import mongoose from 'mongoose';
import { FeeCategory, FeeDiscount, FeeAssignment, FeeInvoice, Payment, Refund } from './fee.models.js';
import { getStructureDoc } from './setup.service.js';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { Guardian, StudentGuardian } from '../parents/guardian.model.js';
import { AcademicSession, Section, SchoolClass } from '../academics/academics.models.js';
import { School } from '../schools/school.model.js';
import { getSessionOr404, assertSessionOpen, nameMap, idStr } from '../academics/academics.common.js';
import { studentAccess, studentFilter, getStudentDoc } from '../students/access.js';
import { nextSequence } from '../counters/counter.model.js';
import { normalizePhone } from '../common/person.validators.js';
import { escapeRegex } from '../common/person.schema.js';
import { withTransaction } from '../../utils/transaction.js';
import { todayIn, addDays, daysBetween } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';
import { logger } from '../../utils/logger.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const OPEN = ['unpaid', 'partially_paid'];
export const tx = (fn) => withTransaction(fn, { required: true });

/* ------------------------------ amounts & status ------------------------------ */

export function totalsOf(inv) {
  const subtotal = inv.lines.reduce((t, l) => t + l.amount, 0);
  const discountTotal = inv.lines.reduce((t, l) => t + (l.discount || 0), 0);
  const late = inv.lateFeeWaived ? 0 : inv.lateFee || 0;
  return { subtotal, discountTotal, total: Math.max(0, subtotal - discountTotal - (inv.concession || 0) + late) };
}

export function statusOf(total, paid) {
  if (paid >= total) return 'paid';
  return paid > 0 ? 'partially_paid' : 'unpaid';
}

/** Badge for the UI: paid, partially_paid, pending, overdue or cancelled. */
export function displayStatus(inv, today) {
  if (inv.status === 'cancelled' || inv.status === 'paid') return inv.status;
  if (new Date(inv.dueDate) < today) return 'overdue';
  return inv.status === 'partially_paid' ? 'partially_paid' : 'pending';
}

export async function nextNumber(schoolId, key, prefix, session, pad = 6) {
  return `${prefix}${String(await nextSequence(schoolId, key, { session })).padStart(pad, '0')}`;
}

async function schoolToday(tenantOrSchool) {
  const tz = tenantOrSchool?.school?.timezone || tenantOrSchool?.timezone;
  if (tz) return todayIn(tz);
  const s = await School.findById(tenantOrSchool.schoolId ?? tenantOrSchool).select('timezone').lean();
  return todayIn(s?.timezone);
}
export { schoolToday };

/** Applies discounts to an installment's items. */
function buildLines(items, discounts, categories) {
  return items.map((item) => {
    let discount = 0;
    for (const d of discounts) {
      if (d.categoryIds.length && !d.categoryIds.some((c) => String(c) === String(item.categoryId))) continue;
      discount += d.type === 'percent' ? Math.round((item.amount * d.value) / 100) : d.value;
    }
    return { categoryId: item.categoryId, name: categories.get(String(item.categoryId))?.name ?? 'Fee', amount: item.amount, discount: Math.min(discount, item.amount) };
  });
}

/* ------------------------------ assignment ------------------------------ */

/**
 * Applies a fee structure to students (a section, or a list of students), generating one invoice
 * per installment. Each student is processed in its own transaction; students who are not
 * eligible or already have the structure are skipped and reported.
 */
export async function assignFees(tenant, { structureId, studentIds, sectionId, discountIds = [] }, ctx) {
  const schoolId = tenant.schoolId;
  const structure = await getStructureDoc(schoolId, structureId);
  if (structure.status !== 'active') throw ApiError.badRequest('This fee structure is inactive', { code: 'STRUCTURE_INACTIVE' });
  const session = await getSessionOr404(schoolId, structure.sessionId);
  assertSessionOpen(session);

  const discounts = discountIds.length ? await FeeDiscount.find({ schoolId, _id: { $in: discountIds }, status: 'active' }).lean() : [];
  if (discounts.length !== new Set(discountIds.map(String)).size) throw ApiError.badRequest('One or more discounts are invalid or inactive', { code: 'INVALID_DISCOUNT' });

  const access = await studentAccess(tenant);
  let targetIds = studentIds ? [...new Set(studentIds.map(String))] : null;
  if (sectionId) {
    const section = await Section.findOne({ _id: sectionId, schoolId }).lean();
    if (!section) throw ApiError.notFound('Section not found');
    if (String(section.sessionId) !== String(structure.sessionId)) throw ApiError.badRequest('The section is not in the structure’s session', { code: 'SESSION_MISMATCH' });
    targetIds = (await Enrollment.distinct('studentId', { schoolId, sectionId, status: 'active' })).map(String);
  }
  if (!targetIds?.length) throw ApiError.badRequest('No students to assign', { code: 'NO_STUDENTS' });
  if (targetIds.length > 500) throw ApiError.badRequest('Assign at most 500 students at a time', { code: 'TOO_MANY_STUDENTS' });

  const [enrollments, students, existing, categories] = await Promise.all([
    Enrollment.find({ schoolId, sessionId: structure.sessionId, studentId: { $in: targetIds }, status: 'active' }).lean(),
    Student.find({ schoolId, _id: { $in: targetIds }, ...studentFilter(access) }).select('status campusId').lean(),
    FeeAssignment.find({ schoolId, structureId: structure._id, studentId: { $in: targetIds }, status: 'active' }).select('studentId').lean(),
    nameMap(FeeCategory, schoolId, structure.installments.flatMap((i) => i.items.map((x) => x.categoryId)), 'name'),
  ]);
  const enrolledBy = new Map(enrollments.map((e) => [String(e.studentId), e]));
  const studentBy = new Map(students.map((s) => [String(s._id), s]));
  const assigned = new Set(existing.map((e) => String(e.studentId)));
  const classes = new Set(structure.classIds.map(String));

  const skipped = [];
  let assignedCount = 0;
  let invoicesCreated = 0;
  for (const id of targetIds) {
    const student = studentBy.get(id);
    const enrollment = enrolledBy.get(id);
    if (!student) skipped.push({ studentId: id, reason: 'NOT_FOUND' });
    else if (student.status !== 'active') skipped.push({ studentId: id, reason: 'STUDENT_INACTIVE' });
    else if (!enrollment) skipped.push({ studentId: id, reason: 'NOT_ENROLLED_IN_SESSION' });
    else if (!classes.has(String(enrollment.classId))) skipped.push({ studentId: id, reason: 'CLASS_NOT_IN_STRUCTURE' });
    else if (structure.campusId && String(structure.campusId) !== String(enrollment.campusId)) skipped.push({ studentId: id, reason: 'CAMPUS_MISMATCH' });
    else if (assigned.has(id)) skipped.push({ studentId: id, reason: 'ALREADY_ASSIGNED' });
    else {
      try {
        invoicesCreated += await tx(async (s) => {
          const [assignment] = await FeeAssignment.create([{ schoolId, studentId: id, structureId: structure._id, sessionId: structure.sessionId, discountIds: discounts.map((d) => d._id), createdBy: ctx.actorId }], { session: s });
          const docs = [];
          for (const inst of structure.installments) {
            const lines = buildLines(inst.items, discounts, categories);
            const draft = { lines, concession: 0, lateFee: 0 };
            const t = totalsOf(draft);
            docs.push({
              schoolId,
              invoiceNo: await nextNumber(schoolId, 'invoice_no', 'INV', s),
              studentId: id,
              sessionId: structure.sessionId,
              classId: enrollment.classId,
              sectionId: enrollment.sectionId,
              campusId: enrollment.campusId,
              assignmentId: assignment._id,
              structureId: structure._id,
              installmentId: inst._id,
              title: `${structure.name} - ${inst.name}`,
              dueDate: inst.dueDate,
              lines,
              ...t,
              lateFeeRule: structure.lateFee,
              status: statusOf(t.total, 0),
              createdBy: ctx.actorId,
            });
          }
          await FeeInvoice.insertMany(docs, { session: s });
          return docs.length;
        });
        assignedCount += 1;
      } catch (err) {
        if (err?.code === 11000) skipped.push({ studentId: id, reason: 'ALREADY_ASSIGNED' });
        else throw err;
      }
    }
  }
  await recordAudit({ ...ctx, action: 'fees.assigned', entityType: 'FeeStructure', entityId: structure._id, metadata: { assigned: assignedCount, invoicesCreated, skipped: skipped.length, discountIds } });
  return { assigned: assignedCount, invoicesCreated, skipped };
}

export async function listAssignments(tenant, { structureId, studentId, status, page, limit }) {
  const filter = { schoolId: tenant.schoolId };
  if (structureId) filter.structureId = structureId;
  if (studentId) {
    await getStudentDoc(tenant, studentId);
    filter.studentId = studentId;
  } else {
    const access = await studentAccess(tenant);
    if (access.restricted) filter.studentId = { $in: await Student.distinct('_id', { schoolId: tenant.schoolId, ...studentFilter(access) }) };
  }
  if (status) filter.status = status;
  const [rows, total] = await Promise.all([
    FeeAssignment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    FeeAssignment.countDocuments(filter),
  ]);
  const students = await nameMap(Student, tenant.schoolId, rows.map((r) => r.studentId), 'firstName lastName admissionNo');
  return {
    items: rows.map((r) => {
      const s = students.get(idStr(r.studentId));
      return { ...r, student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo } : null };
    }),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** Cancels an assignment and its invoices. Refused once any of its invoices has a payment. */
export async function cancelAssignment(tenant, id, { reason }, ctx) {
  const schoolId = tenant.schoolId;
  const assignment = await FeeAssignment.findOne({ _id: id, schoolId });
  if (!assignment) throw ApiError.notFound('Fee assignment not found');
  await getStudentDoc(tenant, assignment.studentId);
  if (assignment.status === 'cancelled') throw ApiError.badRequest('This assignment is already cancelled', { code: 'ALREADY_CANCELLED' });
  const cancelled = await tx(async (s) => {
    const paid = await FeeInvoice.countDocuments({ schoolId, assignmentId: assignment._id, paidAmount: { $gt: 0 } }).session(s);
    if (paid) throw ApiError.conflict('Some invoices of this assignment have payments. Refund them first.', { code: 'ASSIGNMENT_HAS_PAYMENTS' });
    const r = await FeeInvoice.updateMany(
      { schoolId, assignmentId: assignment._id, status: { $ne: 'cancelled' } },
      { status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.actorId, cancelReason: reason },
      { session: s },
    );
    await FeeAssignment.updateOne({ _id: assignment._id, schoolId }, { status: 'cancelled', cancelledAt: new Date(), updatedBy: ctx.actorId }, { session: s });
    await recordAudit({ ...ctx, action: 'fees.assignment_cancelled', entityType: 'FeeAssignment', entityId: assignment._id, metadata: { reason, invoicesCancelled: r.modifiedCount } }, { session: s });
    return r.modifiedCount;
  });
  return { invoicesCancelled: cancelled };
}

/* ------------------------------ invoices ------------------------------ */

/** Invoice rows with student, class/section names, balance and badge. */
export async function decorateInvoices(schoolId, rows, today) {
  const [students, classes, sections] = await Promise.all([
    nameMap(Student, schoolId, rows.map((r) => r.studentId), 'firstName lastName admissionNo'),
    nameMap(SchoolClass, schoolId, rows.map((r) => r.classId), 'name'),
    nameMap(Section, schoolId, rows.map((r) => r.sectionId), 'name'),
  ]);
  return rows.map((r) => {
    const s = students.get(idStr(r.studentId));
    const c = classes.get(idStr(r.classId));
    const sec = sections.get(idStr(r.sectionId));
    return {
      _id: r._id,
      invoiceNo: r.invoiceNo,
      title: r.title,
      studentId: r.studentId,
      student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo } : null,
      classSection: c ? `${c.name}${sec ? ` - ${sec.name}` : ''}` : null,
      sessionId: r.sessionId,
      dueDate: r.dueDate,
      lines: r.lines,
      subtotal: r.subtotal,
      discountTotal: r.discountTotal,
      concession: r.concession,
      lateFee: r.lateFeeWaived ? 0 : r.lateFee,
      lateFeeWaived: r.lateFeeWaived,
      total: r.total,
      paidAmount: r.paidAmount,
      balance: Math.max(0, r.total - r.paidAmount),
      status: r.status,
      displayStatus: displayStatus(r, today),
      cancelReason: r.cancelReason ?? null,
      createdAt: r.createdAt,
    };
  });
}

/** Students matching a search by name, admission number, or a parent's name/phone. */
async function searchStudentIds(schoolId, search) {
  const rx = new RegExp(escapeRegex(search), 'i');
  const or = [{ firstName: rx }, { lastName: rx }, { admissionNo: rx }];
  const [first, ...rest] = search.split(/\s+/);
  if (rest.length) or.push({ firstName: new RegExp(`^${escapeRegex(first)}`, 'i'), lastName: new RegExp(`^${escapeRegex(rest.join(' '))}`, 'i') });
  const ids = (await Student.distinct('_id', { schoolId, $or: or })).map(String);
  const gq = [{ name: rx }];
  const digits = normalizePhone(search);
  if (/^\+?\d{4,}$/.test(digits)) gq.push({ phoneNormalized: new RegExp(escapeRegex(digits)) });
  const gIds = await Guardian.distinct('_id', { schoolId, $or: gq });
  if (gIds.length) ids.push(...(await StudentGuardian.distinct('studentId', { schoolId, guardianId: { $in: gIds } })).map(String));
  return [...new Set(ids)];
}

const SORTS = { dueDate: { dueDate: 1, _id: 1 }, '-dueDate': { dueDate: -1, _id: -1 }, invoiceNo: { invoiceNo: 1 }, '-invoiceNo': { invoiceNo: -1 }, '-createdAt': { createdAt: -1, _id: -1 } };

/** Base invoice filter for staff: tenant + campus restriction. */
export async function staffInvoiceScope(tenant) {
  const access = await studentAccess(tenant);
  const f = { schoolId: tenant.schoolId };
  if (access.campusIds) f.campusId = { $in: access.campusIds.map(oid) };
  if (access.studentIds) f.studentId = { $in: [...access.studentIds].map(oid) };
  return f;
}

export async function listInvoices(tenant, q) {
  const { page, limit, search, sessionId, classId, sectionId, status, dueFrom, dueTo, studentId, sort } = q;
  const today = await schoolToday(tenant);
  const filter = await staffInvoiceScope(tenant);
  // ObjectIds (not strings) so the same filter works in the totals aggregation.
  if (sessionId) filter.sessionId = oid(sessionId);
  if (classId) filter.classId = oid(classId);
  if (sectionId) filter.sectionId = oid(sectionId);
  if (studentId) filter.studentId = filter.studentId ? { $in: filter.studentId.$in.filter((id) => String(id) === String(studentId)) } : oid(studentId);
  if (status === 'overdue') Object.assign(filter, { status: { $in: OPEN }, dueDate: { $lt: today } });
  else if (status === 'outstanding') filter.status = { $in: OPEN };
  else if (status === 'pending') Object.assign(filter, { status: 'unpaid', dueDate: { $gte: today } });
  else if (status) filter.status = status;
  if (dueFrom || dueTo) filter.dueDate = { ...(filter.dueDate || {}), ...(dueFrom ? { $gte: dueFrom } : {}), ...(dueTo ? { $lte: dueTo } : {}) };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ invoiceNo: rx }, { studentId: { $in: (await searchStudentIds(tenant.schoolId, search)).map(oid) } }];
  }
  const [rows, total, sums] = await Promise.all([
    FeeInvoice.find(filter).sort(SORTS[sort] || SORTS.dueDate).skip((page - 1) * limit).limit(limit).lean(),
    FeeInvoice.countDocuments(filter),
    FeeInvoice.aggregate([{ $match: { ...filter, schoolId: oid(tenant.schoolId) } }, { $group: { _id: null, total: { $sum: '$total' }, paid: { $sum: '$paidAmount' } } }]),
  ]);
  const agg = sums[0] || { total: 0, paid: 0 };
  return {
    items: await decorateInvoices(tenant.schoolId, rows, today),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), amounts: { total: agg.total, paid: agg.paid, balance: agg.total - agg.paid } },
  };
}

export async function getInvoiceDoc(tenant, id, { session } = {}) {
  const scope = await staffInvoiceScope(tenant);
  const inv = await FeeInvoice.findOne({ ...scope, _id: id }).session(session || null);
  if (!inv) throw ApiError.notFound('Invoice not found');
  return inv;
}

export async function invoiceDetail(schoolId, inv, today) {
  const [row] = await decorateInvoices(schoolId, [inv], today);
  const [payments, refunds, link] = await Promise.all([
    Payment.find({ schoolId, 'allocations.invoiceId': inv._id }).select('receiptNo method paidAt source status allocations reference').sort({ paidAt: 1 }).lean(),
    Refund.find({ schoolId, 'allocations.invoiceId': inv._id }).select('refundNo amount allocations refundedAt reason method').lean(),
    StudentGuardian.findOne({ schoolId, studentId: inv.studentId, isPrimary: true }).lean(),
  ]);
  const guardian = link ? await Guardian.findOne({ schoolId, _id: link.guardianId }).select('name phone email').lean() : null;
  const categories = await nameMap(FeeCategory, schoolId, inv.lines.map((l) => l.categoryId), 'name code');
  return {
    ...row,
    lines: inv.lines.map((l) => ({ ...l, net: l.amount - (l.discount || 0), category: categories.get(idStr(l.categoryId)) ?? null })),
    lateFeeRule: inv.lateFeeRule,
    primaryGuardian: guardian ? { name: guardian.name, phone: guardian.phone, email: guardian.email ?? null } : null,
    payments: payments.map((p) => ({ id: p._id, receiptNo: p.receiptNo, method: p.method, source: p.source, status: p.status, paidAt: p.paidAt, reference: p.reference ?? null, amount: p.allocations.find((a) => String(a.invoiceId) === String(inv._id))?.amount ?? 0 })),
    refunds: refunds.map((r) => ({ id: r._id, refundNo: r.refundNo, refundedAt: r.refundedAt, reason: r.reason, method: r.method, amount: r.allocations.find((a) => String(a.invoiceId) === String(inv._id))?.amount ?? 0 })),
  };
}

export async function getInvoice(tenant, id) {
  const inv = await getInvoiceDoc(tenant, id);
  return invoiceDetail(tenant.schoolId, inv.toObject(), await schoolToday(tenant));
}

/** One-off invoice (fine, exam fee, lost book...) for a student in the current session. */
export async function createAdhocInvoice(tenant, { studentId, title, dueDate, lines }, ctx) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  if (!session) throw ApiError.badRequest('No current academic session', { code: 'NO_CURRENT_SESSION' });
  assertSessionOpen(session);
  const categoryIds = [...new Set(lines.map((l) => String(l.categoryId)))];
  const cats = await FeeCategory.find({ schoolId, _id: { $in: categoryIds }, status: 'active' }).select('name').lean();
  if (cats.length !== categoryIds.length) throw ApiError.badRequest('One or more fee categories are invalid or inactive', { code: 'INVALID_CATEGORY' });
  const names = new Map(cats.map((c) => [String(c._id), c.name]));
  const enrollment = await Enrollment.findOne({ schoolId, studentId: student._id, sessionId: session._id, status: 'active' }).lean();

  const invLines = lines.map((l) => ({ categoryId: l.categoryId, name: l.description || names.get(String(l.categoryId)), amount: l.amount, discount: 0 }));
  const t = totalsOf({ lines: invLines });
  const inv = await tx(async (s) => {
    const [doc] = await FeeInvoice.create(
      [
        {
          schoolId,
          invoiceNo: await nextNumber(schoolId, 'invoice_no', 'INV', s),
          studentId: student._id,
          sessionId: session._id,
          classId: enrollment?.classId ?? null,
          sectionId: enrollment?.sectionId ?? null,
          campusId: enrollment?.campusId ?? student.campusId,
          title,
          dueDate,
          lines: invLines,
          ...t,
          status: statusOf(t.total, 0),
          createdBy: ctx.actorId,
        },
      ],
      { session: s },
    );
    await recordAudit({ ...ctx, action: 'invoice.created', entityType: 'FeeInvoice', entityId: doc._id, metadata: { invoiceNo: doc.invoiceNo, total: doc.total } }, { session: s });
    return doc;
  });
  return getInvoice(tenant, inv._id);
}

export async function cancelInvoice(tenant, id, { reason }, ctx) {
  await tx(async (s) => {
    const inv = await getInvoiceDoc(tenant, id, { session: s });
    if (inv.status === 'cancelled') throw ApiError.badRequest('This invoice is already cancelled', { code: 'ALREADY_CANCELLED' });
    if (inv.paidAmount > 0) throw ApiError.conflict('This invoice has payments. Refund them before cancelling.', { code: 'INVOICE_HAS_PAYMENTS' });
    inv.set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.actorId, cancelReason: reason, updatedBy: ctx.actorId });
    await inv.save({ session: s });
    await recordAudit({ ...ctx, action: 'invoice.cancelled', entityType: 'FeeInvoice', entityId: inv._id, metadata: { invoiceNo: inv.invoiceNo, reason } }, { session: s });
  });
  return getInvoice(tenant, id);
}

/** Reduces what is owed on an invoice (hardship waiver, scholarship top-up). */
export async function addConcession(tenant, id, { amount, reason }, ctx) {
  await tx(async (s) => {
    const inv = await getInvoiceDoc(tenant, id, { session: s });
    if (inv.status === 'cancelled') throw ApiError.badRequest('This invoice is cancelled', { code: 'INVOICE_CANCELLED' });
    const balance = inv.total - inv.paidAmount;
    if (amount > balance) throw ApiError.badRequest(`The concession cannot exceed the balance (${balance})`, { code: 'CONCESSION_TOO_HIGH', details: { balance } });
    inv.concession += amount;
    Object.assign(inv, totalsOf(inv));
    inv.status = statusOf(inv.total, inv.paidAmount);
    inv.updatedBy = ctx.actorId;
    await inv.save({ session: s });
    await recordAudit({ ...ctx, action: 'invoice.concession', entityType: 'FeeInvoice', entityId: inv._id, metadata: { invoiceNo: inv.invoiceNo, amount, reason } }, { session: s });
  });
  return getInvoice(tenant, id);
}

export async function waiveLateFee(tenant, id, { reason }, ctx) {
  await tx(async (s) => {
    const inv = await getInvoiceDoc(tenant, id, { session: s });
    if (inv.status === 'cancelled') throw ApiError.badRequest('This invoice is cancelled', { code: 'INVOICE_CANCELLED' });
    if (!inv.lateFee || inv.lateFeeWaived) throw ApiError.badRequest('There is no late fee to waive', { code: 'NO_LATE_FEE' });
    const waived = inv.lateFee;
    const newTotal = totalsOf({ ...inv.toObject(), lateFeeWaived: true }).total;
    if (newTotal < inv.paidAmount) throw ApiError.conflict('The late fee has already been paid. Refund it instead.', { code: 'LATE_FEE_PAID' });
    inv.lateFeeWaived = true;
    Object.assign(inv, totalsOf(inv));
    inv.status = statusOf(inv.total, inv.paidAmount);
    inv.updatedBy = ctx.actorId;
    await inv.save({ session: s });
    await recordAudit({ ...ctx, action: 'invoice.late_fee_waived', entityType: 'FeeInvoice', entityId: inv._id, metadata: { invoiceNo: inv.invoiceNo, amount: waived, reason } }, { session: s });
  });
  return getInvoice(tenant, id);
}

/* ------------------------------ late fees ------------------------------ */

export function lateFeeFor(rule, dueDate, today) {
  if (!rule || rule.type === 'none' || !rule.amount) return 0;
  const startsAfter = addDays(dueDate, rule.graceDays || 0);
  if (today <= startsAfter) return 0;
  if (rule.type === 'fixed') return rule.amount;
  const fee = daysBetween(startsAfter, today) * rule.amount;
  return rule.maxAmount ? Math.min(fee, rule.maxAmount) : fee;
}

/**
 * Brings late fees on overdue invoices up to date (they only ever increase, and stop once the
 * invoice is paid, cancelled or the fee is waived). Safe to run repeatedly; run hourly by the
 * scheduler and on demand.
 */
export async function applyLateFees(schoolId, today) {
  const rows = await FeeInvoice.find({ schoolId, status: { $in: OPEN }, lateFeeWaived: false, 'lateFeeRule.type': { $ne: 'none' }, dueDate: { $lt: today } })
    .select('dueDate lateFee lateFeeRule')
    .lean();
  let updated = 0;
  for (const r of rows) {
    const fee = lateFeeFor(r.lateFeeRule, r.dueDate, today);
    if (fee <= r.lateFee) continue;
    // Conditional on the old value so concurrent runs cannot double-add.
    const res = await FeeInvoice.updateOne({ _id: r._id, schoolId, lateFee: r.lateFee, status: { $in: OPEN }, lateFeeWaived: false }, { $set: { lateFee: fee }, $inc: { total: fee - r.lateFee } });
    if (res.modifiedCount) updated += 1;
  }
  if (updated) logger.info({ schoolId, updated }, 'Late fees applied');
  return { invoicesUpdated: updated };
}
