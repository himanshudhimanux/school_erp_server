import { FeeCategory, FeeStructure, FeeDiscount, FeeAssignment, FeeInvoice } from './fee.models.js';
import { SchoolClass } from '../academics/academics.models.js';
import { Campus } from '../campuses/campus.model.js';
import { getSessionOr404, assertSessionOpen, resolveSession, nameMap, idStr } from '../academics/academics.common.js';
import { escapeRegex } from '../common/person.schema.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { recordAudit } from '../audit/audit.service.js';

const dupError = (err, message, code) => {
  if (err?.code === 11000) return ApiError.conflict(message, { code });
  return err;
};

/* ------------------------------ categories ------------------------------ */

export function listCategories(schoolId, { page, limit, status, search }) {
  const filter = { schoolId };
  if (status) filter.status = status;
  if (search) filter.$or = [{ name: new RegExp(escapeRegex(search), 'i') }, { code: new RegExp(escapeRegex(search), 'i') }];
  return paginate(FeeCategory, filter, { page, limit, sort: 'name' });
}

async function getCategoryDoc(schoolId, id) {
  const c = await FeeCategory.findOne({ _id: id, schoolId });
  if (!c) throw ApiError.notFound('Fee category not found');
  return c;
}

export async function createCategory(tenant, data, ctx) {
  try {
    const c = await FeeCategory.create({ ...data, schoolId: tenant.schoolId, createdBy: ctx.actorId });
    await recordAudit({ ...ctx, action: 'fee_category.created', entityType: 'FeeCategory', entityId: c._id, metadata: { code: c.code } });
    return c;
  } catch (err) {
    throw dupError(err, 'A fee category with this code already exists', 'CODE_TAKEN');
  }
}

export async function updateCategory(tenant, id, data, ctx) {
  const c = await getCategoryDoc(tenant.schoolId, id);
  c.set({ ...data, updatedBy: ctx.actorId });
  try {
    await c.save();
  } catch (err) {
    throw dupError(err, 'A fee category with this code already exists', 'CODE_TAKEN');
  }
  await recordAudit({ ...ctx, action: 'fee_category.updated', entityType: 'FeeCategory', entityId: c._id, metadata: { changed: Object.keys(data) } });
  return c;
}

export async function deleteCategory(tenant, id, ctx) {
  const c = await getCategoryDoc(tenant.schoolId, id);
  const [inStructures, inInvoices] = await Promise.all([
    FeeStructure.countDocuments({ schoolId: tenant.schoolId, 'installments.items.categoryId': c._id }),
    FeeInvoice.countDocuments({ schoolId: tenant.schoolId, 'lines.categoryId': c._id }),
  ]);
  if (inStructures || inInvoices) {
    throw ApiError.conflict('This category is used in fee structures or invoices. Mark it inactive instead.', { code: 'CATEGORY_IN_USE', details: { structures: inStructures, invoices: inInvoices } });
  }
  await c.softDelete(ctx.actorId);
  await recordAudit({ ...ctx, action: 'fee_category.deleted', entityType: 'FeeCategory', entityId: c._id, metadata: { code: c.code } });
}

/* ------------------------------ structures ------------------------------ */

async function decorateStructures(schoolId, rows) {
  const [classes, categories, campuses, counts] = await Promise.all([
    nameMap(SchoolClass, schoolId, rows.flatMap((r) => r.classIds), 'name order'),
    nameMap(FeeCategory, schoolId, rows.flatMap((r) => r.installments.flatMap((i) => i.items.map((x) => x.categoryId))), 'name code'),
    nameMap(Campus, schoolId, rows.map((r) => r.campusId), 'name'),
    FeeAssignment.aggregate([{ $match: { schoolId: rows[0]?.schoolId ?? schoolId, structureId: { $in: rows.map((r) => r._id) }, status: 'active' } }, { $group: { _id: '$structureId', n: { $sum: 1 } } }]),
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((r) => ({
    ...r,
    classes: r.classIds.map((id) => classes.get(idStr(id))).filter(Boolean).map((c) => ({ id: c._id, name: c.name })),
    campus: r.campusId ? campuses.get(idStr(r.campusId)) ?? null : null,
    installments: r.installments.map((i) => ({
      ...i,
      total: i.items.reduce((t, x) => t + x.amount, 0),
      items: i.items.map((x) => ({ ...x, category: categories.get(idStr(x.categoryId)) ?? null })),
    })),
    totalAmount: r.installments.reduce((t, i) => t + i.items.reduce((s, x) => s + x.amount, 0), 0),
    assignedStudents: countBy.get(String(r._id)) || 0,
  }));
}

export async function listStructures(tenant, { sessionId, classId, status }) {
  const session = await resolveSession(tenant.schoolId, sessionId);
  const filter = { schoolId: tenant.schoolId, sessionId: session._id };
  if (classId) filter.classIds = classId;
  if (status) filter.status = status;
  const rows = await FeeStructure.find(filter).sort({ name: 1 }).lean();
  return { session: { id: session._id, name: session.name }, items: await decorateStructures(tenant.schoolId, rows) };
}

export async function getStructureDoc(schoolId, id) {
  const s = await FeeStructure.findOne({ _id: id, schoolId });
  if (!s) throw ApiError.notFound('Fee structure not found');
  return s;
}

export async function getStructure(tenant, id) {
  const s = await getStructureDoc(tenant.schoolId, id);
  const [row] = await decorateStructures(tenant.schoolId, [s.toObject()]);
  return row;
}

/** Checks classes, campus, categories and due dates against the school and session. */
async function validateStructure(schoolId, session, data) {
  if (data.classIds) {
    const n = await SchoolClass.countDocuments({ schoolId, _id: { $in: data.classIds } });
    if (n !== new Set(data.classIds.map(String)).size) throw ApiError.badRequest('One or more classes do not belong to this school', { code: 'INVALID_CLASS' });
  }
  if (data.campusId && !(await Campus.exists({ _id: data.campusId, schoolId }))) throw ApiError.badRequest('Campus does not belong to this school', { code: 'INVALID_CAMPUS' });
  if (data.installments) {
    const categoryIds = [...new Set(data.installments.flatMap((i) => i.items.map((x) => String(x.categoryId))))];
    const cats = await FeeCategory.find({ schoolId, _id: { $in: categoryIds } }).select('status').lean();
    if (cats.length !== categoryIds.length) throw ApiError.badRequest('One or more fee categories do not belong to this school', { code: 'INVALID_CATEGORY' });
    if (cats.some((c) => c.status !== 'active')) throw ApiError.badRequest('Inactive fee categories cannot be used', { code: 'CATEGORY_INACTIVE' });
    for (const i of data.installments) {
      if (i.dueDate < session.startDate || i.dueDate > session.endDate) {
        throw ApiError.badRequest(`Due date of "${i.name}" is outside session ${session.name}`, { code: 'OUTSIDE_SESSION' });
      }
    }
  }
}

export async function createStructure(tenant, data, ctx) {
  const session = await getSessionOr404(tenant.schoolId, data.sessionId);
  assertSessionOpen(session);
  await validateStructure(tenant.schoolId, session, data);
  try {
    const s = await FeeStructure.create({ ...data, schoolId: tenant.schoolId, createdBy: ctx.actorId });
    await recordAudit({ ...ctx, action: 'fee_structure.created', entityType: 'FeeStructure', entityId: s._id, metadata: { name: s.name, installments: s.installments.length } });
    return getStructure(tenant, s._id);
  } catch (err) {
    throw dupError(err, 'A fee structure with this name already exists in the session', 'NAME_TAKEN');
  }
}

/** Edits apply to future assignments only: invoices already issued keep their amounts. */
export async function updateStructure(tenant, id, data, ctx) {
  const s = await getStructureDoc(tenant.schoolId, id);
  const session = await getSessionOr404(tenant.schoolId, s.sessionId);
  assertSessionOpen(session);
  await validateStructure(tenant.schoolId, session, data);
  s.set({ ...data, updatedBy: ctx.actorId });
  try {
    await s.save();
  } catch (err) {
    throw dupError(err, 'A fee structure with this name already exists in the session', 'NAME_TAKEN');
  }
  await recordAudit({ ...ctx, action: 'fee_structure.updated', entityType: 'FeeStructure', entityId: s._id, metadata: { changed: Object.keys(data) } });
  return getStructure(tenant, s._id);
}

export async function deleteStructure(tenant, id, ctx) {
  const s = await getStructureDoc(tenant.schoolId, id);
  if (await FeeAssignment.exists({ schoolId: tenant.schoolId, structureId: s._id })) {
    throw ApiError.conflict('This structure has been assigned to students. Mark it inactive instead.', { code: 'STRUCTURE_IN_USE' });
  }
  await FeeStructure.deleteOne({ _id: s._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'fee_structure.deleted', entityType: 'FeeStructure', entityId: s._id, metadata: { name: s.name } });
}

/* ------------------------------ discounts ------------------------------ */

export function listDiscounts(schoolId, { page, limit, status }) {
  const filter = { schoolId };
  if (status) filter.status = status;
  return paginate(FeeDiscount, filter, { page, limit, sort: 'name' });
}

async function getDiscountDoc(schoolId, id) {
  const d = await FeeDiscount.findOne({ _id: id, schoolId });
  if (!d) throw ApiError.notFound('Discount not found');
  return d;
}

async function validateDiscount(schoolId, data) {
  if (data.type === 'percent' && data.value > 100) throw ApiError.validation([{ field: 'body.value', message: 'A percentage cannot exceed 100' }]);
  if (data.type === 'fixed' && !Number.isInteger(data.value)) throw ApiError.validation([{ field: 'body.value', message: 'Fixed amounts are whole paise' }]);
  if (data.categoryIds?.length) {
    const n = await FeeCategory.countDocuments({ schoolId, _id: { $in: data.categoryIds } });
    if (n !== new Set(data.categoryIds.map(String)).size) throw ApiError.badRequest('One or more fee categories do not belong to this school', { code: 'INVALID_CATEGORY' });
  }
}

export async function createDiscount(tenant, data, ctx) {
  await validateDiscount(tenant.schoolId, data);
  try {
    const d = await FeeDiscount.create({ ...data, schoolId: tenant.schoolId, createdBy: ctx.actorId });
    await recordAudit({ ...ctx, action: 'fee_discount.created', entityType: 'FeeDiscount', entityId: d._id, metadata: { name: d.name, type: d.type, value: d.value } });
    return d;
  } catch (err) {
    throw dupError(err, 'A discount with this name already exists', 'NAME_TAKEN');
  }
}

export async function updateDiscount(tenant, id, data, ctx) {
  const d = await getDiscountDoc(tenant.schoolId, id);
  await validateDiscount(tenant.schoolId, { type: data.type ?? d.type, value: data.value ?? d.value, categoryIds: data.categoryIds });
  d.set({ ...data, updatedBy: ctx.actorId });
  try {
    await d.save();
  } catch (err) {
    throw dupError(err, 'A discount with this name already exists', 'NAME_TAKEN');
  }
  await recordAudit({ ...ctx, action: 'fee_discount.updated', entityType: 'FeeDiscount', entityId: d._id, metadata: { changed: Object.keys(data) } });
  return d;
}

export async function deleteDiscount(tenant, id, ctx) {
  const d = await getDiscountDoc(tenant.schoolId, id);
  if (await FeeAssignment.exists({ schoolId: tenant.schoolId, discountIds: d._id })) {
    throw ApiError.conflict('This discount has been given to students. Mark it inactive instead.', { code: 'DISCOUNT_IN_USE' });
  }
  await FeeDiscount.deleteOne({ _id: d._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'fee_discount.deleted', entityType: 'FeeDiscount', entityId: d._id, metadata: { name: d.name } });
}
