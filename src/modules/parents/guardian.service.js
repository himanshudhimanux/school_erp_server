import { Guardian, StudentGuardian, MAX_GUARDIANS_PER_STUDENT } from './guardian.model.js';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models.js';
import { studentAccess, studentFilter, getStudentDoc } from '../students/access.js';
import { grantFamilyRole, revokeFamilyRole, membershipUsers } from '../memberships/membership.service.js';
import { normalizePhone } from '../common/person.validators.js';
import { escapeRegex } from '../common/person.schema.js';
import { User } from '../users/user.model.js';
import { Membership } from '../memberships/membership.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { assertDeletable } from '../../utils/dependencyGuards.js';
import { recordAudit } from '../audit/audit.service.js';

const idStr = (v) => (v ? String(v._id ?? v) : null);

/* ------------------------------ access ------------------------------ */

/**
 * Guardian ids visible to a restricted caller (campus-restricted staff or a section-scoped
 * teacher): guardians linked to students they can see. null = no restriction.
 */
async function visibleGuardianIds(tenant, access) {
  if (!access.restricted) return null;
  const studentIds = await Student.distinct('_id', { schoolId: tenant.schoolId, ...studentFilter(access) });
  return StudentGuardian.distinct('guardianId', { schoolId: tenant.schoolId, studentId: { $in: studentIds } });
}

export async function getGuardianDoc(tenant, guardianId, access) {
  const guardian = await Guardian.findOne({ _id: guardianId, schoolId: tenant.schoolId });
  if (!guardian) throw ApiError.notFound('Parent not found');
  const acc = access || (await studentAccess(tenant));
  const visible = await visibleGuardianIds(tenant, acc);
  // An unlinked guardian is visible only to unrestricted staff.
  if (visible && !visible.some((id) => String(id) === String(guardian._id))) throw ApiError.notFound('Parent not found');
  return guardian;
}

/* ------------------------------ queries ------------------------------ */

/** Linked children for a set of guardians, with their current class/section. */
async function childrenByGuardian(schoolId, guardianIds) {
  if (!guardianIds.length) return new Map();
  const links = await StudentGuardian.find({ schoolId, guardianId: { $in: guardianIds } }).lean();
  const students = await Student.find({ schoolId, _id: { $in: links.map((l) => l.studentId) } })
    .select('admissionNo firstName lastName status campusId')
    .lean();
  const current = await AcademicSession.findOne({ schoolId, isCurrent: true }).select('_id').lean();
  const placement = await currentPlacement(schoolId, current?._id, students.map((s) => s._id));
  const byStudent = new Map(students.map((s) => [String(s._id), s]));
  const out = new Map();
  for (const l of links) {
    const s = byStudent.get(String(l.studentId));
    if (!s) continue;
    const list = out.get(String(l.guardianId)) || [];
    list.push({
      studentId: s._id,
      name: fullName(s),
      admissionNo: s.admissionNo,
      status: s.status,
      relation: l.relation,
      isPrimary: l.isPrimary,
      receivesAlerts: l.receivesAlerts,
      canPickup: l.canPickup,
      classSection: placement.get(String(s._id)) || null,
    });
    out.set(String(l.guardianId), list);
  }
  return out;
}

/** studentId → { sectionId, classId, displayName, rollNo } for active enrollments in a session. */
export async function currentPlacement(schoolId, sessionId, studentIds) {
  if (!sessionId || !studentIds.length) return new Map();
  const rows = await Enrollment.find({ schoolId, sessionId, studentId: { $in: studentIds }, status: 'active' }).lean();
  const [classes, sections] = await Promise.all([
    SchoolClass.find({ schoolId, _id: { $in: rows.map((r) => r.classId) } }).setOptions({ withDeleted: true }).select('name').lean(),
    Section.find({ schoolId, _id: { $in: rows.map((r) => r.sectionId) } }).select('name').lean(),
  ]);
  const cn = new Map(classes.map((c) => [String(c._id), c.name]));
  const sn = new Map(sections.map((s) => [String(s._id), s.name]));
  return new Map(
    rows.map((r) => [
      String(r.studentId),
      { sectionId: r.sectionId, classId: r.classId, rollNo: r.rollNo, displayName: `${cn.get(String(r.classId)) ?? ''} - ${sn.get(String(r.sectionId)) ?? ''}` },
    ]),
  );
}

function publicGuardian(g, portal) {
  return {
    _id: g._id,
    name: g.name,
    phone: g.phone,
    alternatePhone: g.alternatePhone ?? null,
    email: g.email ?? null,
    occupation: g.occupation ?? null,
    address: g.address ?? null,
    notes: g.notes ?? null,
    portal: g.membershipId ? { enabled: true, ...(portal || {}) } : { enabled: false },
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

export async function listGuardians(tenant, { page, limit, search, hasPortal }) {
  const access = await studentAccess(tenant);
  const filter = { schoolId: tenant.schoolId };
  const visible = await visibleGuardianIds(tenant, access);
  if (visible) filter._id = { $in: visible };
  if (hasPortal !== undefined) filter.membershipId = hasPortal ? { $ne: null } : null;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const or = [{ name: rx }, { email: rx }];
    const digits = normalizePhone(search);
    if (/^\+?\d{3,}$/.test(digits)) or.push({ phoneNormalized: new RegExp(escapeRegex(digits)) });
    filter.$or = or;
  }
  const [rows, total] = await Promise.all([
    Guardian.find(filter).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Guardian.countDocuments(filter),
  ]);
  const children = await childrenByGuardian(tenant.schoolId, rows.map((g) => g._id));
  return {
    items: rows.map((g) => ({ ...publicGuardian(g), children: children.get(String(g._id)) || [] })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getGuardian(tenant, guardianId) {
  const g = await getGuardianDoc(tenant, guardianId);
  const [children, users] = await Promise.all([childrenByGuardian(tenant.schoolId, [g._id]), membershipUsers(tenant.schoolId, [g.membershipId])]);
  const u = users.get(idStr(g.membershipId));
  return { ...publicGuardian(g.toObject(), u && { email: u.email, lastLoginAt: u.lastLoginAt, isEmailVerified: u.isEmailVerified }), children: children.get(String(g._id)) || [] };
}

/* ------------------------------ mutations ------------------------------ */

/**
 * Creates a guardian. A guardian with the same phone usually means a sibling's parent who is
 * already registered: unless `allowDuplicate` is set this fails with 409 DUPLICATE_GUARDIAN
 * listing the matches, so the caller can link the existing record instead.
 */
export async function createGuardianDoc(tenant, data, ctx) {
  const { allowDuplicate, ...fields } = data;
  const phoneNormalized = normalizePhone(fields.phone);
  if (!allowDuplicate) {
    const matches = await Guardian.find({ schoolId: tenant.schoolId, phoneNormalized }).select('name phone email').limit(5).lean();
    if (matches.length) {
      throw ApiError.conflict('A parent with this phone number already exists. Link the existing parent or confirm it is a different person.', {
        code: 'DUPLICATE_GUARDIAN',
        details: { matches: matches.map((m) => ({ id: m._id, name: m.name, phone: m.phone, email: m.email ?? null })) },
      });
    }
  }
  const guardian = await Guardian.create({ ...fields, phoneNormalized, schoolId: tenant.schoolId, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'guardian.created', entityType: 'Guardian', entityId: guardian._id, metadata: { name: guardian.name } });
  return guardian;
}

export async function createGuardian(tenant, data, ctx) {
  const g = await createGuardianDoc(tenant, data, ctx);
  return getGuardian(tenant, g._id);
}

export async function updateGuardian(tenant, guardianId, data, ctx) {
  const g = await getGuardianDoc(tenant, guardianId);
  const update = { ...data, updatedBy: ctx.actorId };
  if (data.phone) update.phoneNormalized = normalizePhone(data.phone);
  for (const k of ['email', 'alternatePhone', 'occupation', 'notes']) if (data[k] === '') update[k] = undefined;
  g.set(update);
  await g.save();
  await recordAudit({ ...ctx, action: 'guardian.updated', entityType: 'Guardian', entityId: g._id, metadata: { changed: Object.keys(data) } });
  return getGuardian(tenant, g._id);
}

export async function deleteGuardian(tenant, guardianId, ctx) {
  const g = await getGuardianDoc(tenant, guardianId);
  await assertDeletable('guardian', tenant.schoolId, g._id, 'parent');
  if (g.membershipId) await revokeFamilyRole(tenant.schoolId, g.membershipId, 'parent', ctx);
  g.membershipId = null;
  await g.softDelete(ctx.actorId);
  await recordAudit({ ...ctx, action: 'guardian.deleted', entityType: 'Guardian', entityId: g._id, metadata: { name: g.name } });
}

/* ------------------------- student ↔ guardian links ------------------------- */

/** Validates a link request before anything is written (used by student creation too). */
export async function prepareLinks(tenant, links = []) {
  if (links.length > MAX_GUARDIANS_PER_STUDENT) throw ApiError.badRequest(`A student can have at most ${MAX_GUARDIANS_PER_STUDENT} guardians`, { code: 'TOO_MANY_GUARDIANS' });
  const existingIds = links.filter((l) => l.guardianId).map((l) => String(l.guardianId));
  if (new Set(existingIds).size !== existingIds.length) throw ApiError.validation([{ field: 'body.guardians', message: 'The same parent is listed twice' }]);
  if (existingIds.length) {
    const found = await Guardian.countDocuments({ schoolId: tenant.schoolId, _id: { $in: existingIds } });
    if (found !== existingIds.length) throw ApiError.badRequest('One or more parents do not belong to this school', { code: 'INVALID_GUARDIAN' });
  }
  if (links.filter((l) => l.isPrimary).length > 1) throw ApiError.validation([{ field: 'body.guardians', message: 'Only one parent can be the primary contact' }]);
  // Fail on duplicate phones up front rather than half-way through creating records.
  for (const l of links.filter((x) => x.guardian && !x.guardian.allowDuplicate)) {
    const phoneNormalized = normalizePhone(l.guardian.phone);
    const matches = await Guardian.find({ schoolId: tenant.schoolId, phoneNormalized }).select('name phone email').limit(5).lean();
    if (matches.length) {
      throw ApiError.conflict(`A parent with phone ${l.guardian.phone} already exists. Link the existing parent or confirm it is a different person.`, {
        code: 'DUPLICATE_GUARDIAN',
        details: { phone: l.guardian.phone, matches: matches.map((m) => ({ id: m._id, name: m.name, phone: m.phone, email: m.email ?? null })) },
      });
    }
  }
}

/**
 * Creates links (and new guardians) for a student. Returns created ids so a caller can roll
 * back. The first guardian becomes primary when none is marked.
 */
export async function createLinks(tenant, student, links, ctx, created = { guardians: [], links: [] }) {
  const hasPrimary = await StudentGuardian.exists({ schoolId: tenant.schoolId, studentId: student._id, isPrimary: true });
  const markFirst = !hasPrimary && !links.some((l) => l.isPrimary);
  for (const [i, l] of links.entries()) {
    let guardianId = l.guardianId;
    if (!guardianId) {
      const g = await createGuardianDoc(tenant, { ...l.guardian, allowDuplicate: true }, ctx);
      created.guardians.push(g._id);
      guardianId = g._id;
    }
    const isPrimary = Boolean(l.isPrimary) || (markFirst && i === 0);
    if (isPrimary) await StudentGuardian.updateMany({ schoolId: tenant.schoolId, studentId: student._id, isPrimary: true }, { isPrimary: false });
    const link = await StudentGuardian.create({
      schoolId: tenant.schoolId,
      studentId: student._id,
      guardianId,
      relation: l.relation,
      isPrimary,
      receivesAlerts: l.receivesAlerts ?? true,
      canPickup: l.canPickup ?? true,
      createdBy: ctx.actorId,
    });
    created.links.push(link._id);
  }
  return created;
}

export async function listStudentGuardians(schoolId, studentId) {
  const links = await StudentGuardian.find({ schoolId, studentId }).sort({ isPrimary: -1, createdAt: 1 }).lean();
  const guardians = await Guardian.find({ schoolId, _id: { $in: links.map((l) => l.guardianId) } }).lean();
  const byId = new Map(guardians.map((g) => [String(g._id), g]));
  return links
    .filter((l) => byId.has(String(l.guardianId)))
    .map((l) => {
      const g = byId.get(String(l.guardianId));
      return {
        guardianId: g._id,
        name: g.name,
        phone: g.phone,
        alternatePhone: g.alternatePhone ?? null,
        email: g.email ?? null,
        occupation: g.occupation ?? null,
        relation: l.relation,
        isPrimary: l.isPrimary,
        receivesAlerts: l.receivesAlerts,
        canPickup: l.canPickup,
        hasPortalAccess: Boolean(g.membershipId),
      };
    });
}

export async function linkGuardian(tenant, studentId, data, ctx) {
  const student = await getStudentDoc(tenant, studentId);
  if (data.guardianId) await getGuardianDoc(tenant, data.guardianId);
  const count = await StudentGuardian.countDocuments({ schoolId: tenant.schoolId, studentId: student._id });
  if (count >= MAX_GUARDIANS_PER_STUDENT) throw ApiError.badRequest(`A student can have at most ${MAX_GUARDIANS_PER_STUDENT} guardians`, { code: 'TOO_MANY_GUARDIANS' });
  if (data.guardianId && (await StudentGuardian.exists({ schoolId: tenant.schoolId, studentId: student._id, guardianId: data.guardianId }))) {
    throw ApiError.conflict('This parent is already linked to the student', { code: 'ALREADY_LINKED' });
  }
  await prepareLinks(tenant, [data]);
  const created = await createLinks(tenant, student, [data], ctx);
  await recordAudit({ ...ctx, action: 'student.guardian_linked', entityType: 'Student', entityId: student._id, metadata: { linkId: created.links[0], newGuardian: created.guardians.length > 0 } });
  return listStudentGuardians(tenant.schoolId, student._id);
}

export async function updateLink(tenant, studentId, guardianId, data, ctx) {
  const student = await getStudentDoc(tenant, studentId);
  const link = await StudentGuardian.findOne({ schoolId: tenant.schoolId, studentId: student._id, guardianId });
  if (!link) throw ApiError.notFound('This parent is not linked to the student');
  if (data.isPrimary === false && link.isPrimary) {
    throw ApiError.badRequest('Mark another parent as primary instead', { code: 'PRIMARY_REQUIRED' });
  }
  if (data.isPrimary && !link.isPrimary) {
    await StudentGuardian.updateMany({ schoolId: tenant.schoolId, studentId: student._id, isPrimary: true }, { isPrimary: false });
  }
  link.set(data);
  await link.save();
  await recordAudit({ ...ctx, action: 'student.guardian_updated', entityType: 'Student', entityId: student._id, metadata: { guardianId, changed: Object.keys(data) } });
  return listStudentGuardians(tenant.schoolId, student._id);
}

export async function unlinkGuardian(tenant, studentId, guardianId, ctx) {
  const student = await getStudentDoc(tenant, studentId);
  const link = await StudentGuardian.findOneAndDelete({ schoolId: tenant.schoolId, studentId: student._id, guardianId });
  if (!link) throw ApiError.notFound('This parent is not linked to the student');
  if (link.isPrimary) {
    const next = await StudentGuardian.findOne({ schoolId: tenant.schoolId, studentId: student._id }).sort({ createdAt: 1 });
    if (next) {
      next.isPrimary = true;
      await next.save();
    }
  }
  await recordAudit({ ...ctx, action: 'student.guardian_unlinked', entityType: 'Student', entityId: student._id, metadata: { guardianId } });
  return listStudentGuardians(tenant.schoolId, student._id);
}

/* ------------------------------ portal access ------------------------------ */

/** Gives a guardian parent-portal access using their email (or one supplied now). */
export async function grantGuardianPortal(tenant, guardianId, { email } = {}, ctx) {
  const g = await getGuardianDoc(tenant, guardianId);
  if (g.membershipId) throw ApiError.conflict('This parent already has portal access', { code: 'PORTAL_ALREADY_ENABLED' });
  const loginEmail = email || g.email;
  if (!loginEmail) throw ApiError.badRequest('Add an email address for this parent first', { code: 'EMAIL_REQUIRED' });
  await assertLoginFree(tenant.schoolId, loginEmail);

  const result = await grantFamilyRole(tenant, { name: g.name, email: loginEmail, phone: g.phone }, 'parent', ctx);
  g.membershipId = result.membership._id;
  if (!g.email) g.email = loginEmail;
  await g.save();
  return { parent: await getGuardian(tenant, g._id), isNewUser: result.isNewUser, emailDelivered: result.emailDelivered, emailError: result.emailError, setupEmailDelivered: result.setupEmailDelivered };
}

export async function revokeGuardianPortal(tenant, guardianId, ctx) {
  const g = await getGuardianDoc(tenant, guardianId);
  if (!g.membershipId) throw ApiError.badRequest('This parent does not have portal access', { code: 'PORTAL_NOT_ENABLED' });
  await revokeFamilyRole(tenant.schoolId, g.membershipId, 'parent', ctx);
  g.membershipId = null;
  await g.save();
  return getGuardian(tenant, g._id);
}

/**
 * A login (membership) can represent only one guardian and one student record per school.
 * Shared with the student portal.
 */
export async function assertLoginFree(schoolId, email) {
  const user = await User.findOne({ email }).select('_id').lean();
  if (!user) return;
  const m = await Membership.findOne({ schoolId, userId: user._id }).select('_id').lean();
  if (!m) return;
  const [asGuardian, asStudent] = await Promise.all([
    Guardian.exists({ schoolId, membershipId: m._id }),
    Student.exists({ schoolId, membershipId: m._id }),
  ]);
  if (asGuardian || asStudent) {
    throw ApiError.conflict('This email is already used for another parent or student login in this school', { code: 'PORTAL_ACCOUNT_IN_USE' });
  }
}
