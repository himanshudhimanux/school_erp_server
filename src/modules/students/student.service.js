import { Student, Enrollment, LEFT_STATUSES, fullName } from './student.model.js';
import { Guardian, StudentGuardian } from '../parents/guardian.model.js';
import { AcademicSession } from '../academics/academics.models.js';
import { Campus } from '../campuses/campus.model.js';
import { getSessionOr404 } from '../academics/academics.common.js';
import { studentAccess, studentFilter, getStudentDoc } from './access.js';
import { prepareEnrollment, writeEnrollment, decorateEnrollments } from './enrollment.service.js';
import { prepareLinks, createLinks, listStudentGuardians, currentPlacement, assertLoginFree } from '../parents/guardian.service.js';
import { grantFamilyRole, revokeFamilyRole, membershipUsers } from '../memberships/membership.service.js';
import { assertWithinLimit } from '../subscriptions/subscription.service.js';
import { nextFreeCode } from '../counters/counter.model.js';
import { normalizePhone } from '../common/person.validators.js';
import { escapeRegex } from '../common/person.schema.js';
import { ApiError } from '../../utils/ApiError.js';
import { assertDeletable, runDeleteHooks } from '../../utils/dependencyGuards.js';
import { recordAudit } from '../audit/audit.service.js';
import { logger } from '../../utils/logger.js';

const ADMISSION_NO_PREFIX = 'ADM';

async function currentSession(schoolId) {
  return AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
}

/* ------------------------------ list / read ------------------------------ */

/** List rows: student basics, placement in the session and the primary guardian. */
async function decorateList(schoolId, students, sessionId) {
  const ids = students.map((s) => s._id);
  const [placement, primaryLinks] = await Promise.all([
    currentPlacement(schoolId, sessionId, ids),
    StudentGuardian.find({ schoolId, studentId: { $in: ids }, isPrimary: true }).lean(),
  ]);
  const guardians = await Guardian.find({ schoolId, _id: { $in: primaryLinks.map((l) => l.guardianId) } }).select('name phone').lean();
  const gById = new Map(guardians.map((g) => [String(g._id), g]));
  const primary = new Map(primaryLinks.map((l) => [String(l.studentId), { link: l, g: gById.get(String(l.guardianId)) }]));
  return students.map((s) => {
    const p = primary.get(String(s._id));
    return {
      _id: s._id,
      admissionNo: s.admissionNo,
      firstName: s.firstName,
      lastName: s.lastName,
      fullName: fullName(s),
      gender: s.gender,
      dateOfBirth: s.dateOfBirth,
      status: s.status,
      campusId: s.campusId,
      phone: s.phone ?? null,
      photoUrl: s.photoUrl ?? null,
      admissionDate: s.admissionDate,
      enrollment: placement.get(String(s._id)) || null,
      primaryGuardian: p?.g ? { id: p.g._id, name: p.g.name, phone: p.g.phone, relation: p.link.relation } : null,
      hasPortalAccess: Boolean(s.membershipId),
    };
  });
}

const SORTS = {
  name: { firstName: 1, lastName: 1, _id: 1 },
  '-name': { firstName: -1, lastName: -1, _id: -1 },
  admissionNo: { admissionNo: 1 },
  '-admissionNo': { admissionNo: -1 },
  createdAt: { createdAt: 1, _id: 1 },
  '-createdAt': { createdAt: -1, _id: -1 },
};

export async function listStudents(tenant, q) {
  const { page, limit, search, sessionId, classId, sectionId, campusId, status, gender, enrolled, sort } = q;
  const schoolId = tenant.schoolId;
  const session = sessionId ? await getSessionOr404(schoolId, sessionId) : await currentSession(schoolId);
  const access = await studentAccess(tenant, { sessionId: session?._id });

  const and = [{ schoolId }, studentFilter(access)];
  if (status) and.push({ status });
  if (gender) and.push({ gender });
  if (campusId) {
    if (access.campusIds && !access.campusIds.includes(String(campusId))) throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
    and.push({ campusId });
  }

  if (classId || sectionId || enrolled !== undefined) {
    if (!session) throw ApiError.badRequest('No current academic session. Pass sessionId.', { code: 'NO_CURRENT_SESSION' });
    const ef = { schoolId, sessionId: session._id, status: 'active' };
    if (classId) ef.classId = classId;
    if (sectionId) ef.sectionId = sectionId;
    const ids = await Enrollment.distinct('studentId', ef);
    and.push({ _id: enrolled === false ? { $nin: ids } : { $in: ids } });
  }

  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const or = [{ firstName: rx }, { lastName: rx }, { admissionNo: rx }, { phone: rx }];
    const [first, ...rest] = search.split(/\s+/);
    if (rest.length) or.push({ firstName: new RegExp(`^${escapeRegex(first)}`, 'i'), lastName: new RegExp(`^${escapeRegex(rest.join(' '))}`, 'i') });
    // Searching by a parent's phone number finds their children.
    const digits = normalizePhone(search);
    if (/^\+?\d{4,}$/.test(digits)) {
      const gIds = await Guardian.distinct('_id', { schoolId, phoneNormalized: new RegExp(escapeRegex(digits)) });
      if (gIds.length) or.push({ _id: { $in: await StudentGuardian.distinct('studentId', { schoolId, guardianId: { $in: gIds } }) } });
    }
    and.push({ $or: or });
  }

  const filter = { $and: and, schoolId };
  const [rows, total] = await Promise.all([
    Student.find(filter).sort(SORTS[sort] || SORTS.name).skip((page - 1) * limit).limit(limit).lean(),
    Student.countDocuments(filter),
  ]);
  return {
    items: await decorateList(schoolId, rows, session?._id),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), sessionId: session?._id ?? null },
  };
}

export async function getStudent(tenant, studentId) {
  const student = await getStudentDoc(tenant, studentId);
  const s = student.toObject();
  const [guardians, enrollments, campus, users] = await Promise.all([
    listStudentGuardians(tenant.schoolId, s._id),
    Enrollment.find({ schoolId: tenant.schoolId, studentId: s._id }).sort({ enrolledOn: -1 }).lean(),
    Campus.findOne({ _id: s.campusId, schoolId: tenant.schoolId }).select('name code').lean(),
    membershipUsers(tenant.schoolId, [s.membershipId]),
  ]);
  const decorated = await decorateEnrollments(tenant.schoolId, enrollments);
  decorated.sort((a, b) => (b.session?.isCurrent ? 1 : 0) - (a.session?.isCurrent ? 1 : 0));
  const u = users.get(String(s.membershipId));
  const { isDeleted: _d, deletedAt: _da, deletedBy: _db, __v: _v, ...profile } = s;
  return {
    ...profile,
    fullName: fullName(s),
    campus: campus ? { id: campus._id, name: campus.name, code: campus.code } : null,
    currentEnrollment: decorated.find((e) => e.session?.isCurrent && e.status === 'active') || null,
    enrollments: decorated,
    guardians,
    portal: s.membershipId ? { enabled: true, email: u?.email ?? null, lastLoginAt: u?.lastLoginAt ?? null, isEmailVerified: u?.isEmailVerified ?? false } : { enabled: false },
  };
}

/* ------------------------------ create ------------------------------ */

async function assertCampusUsable(tenant, access, campusId) {
  if (access.campusIds && !access.campusIds.includes(String(campusId))) throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
  const campus = await Campus.findOne({ _id: campusId, schoolId: tenant.schoolId }).lean();
  if (!campus) throw ApiError.badRequest('Campus does not belong to this school', { code: 'INVALID_CAMPUS' });
  if (campus.status !== 'active') throw ApiError.badRequest('Campus is inactive', { code: 'CAMPUS_INACTIVE' });
}

async function assertAdmissionNoFree(schoolId, admissionNo, exceptId) {
  const taken = await Student.exists({ schoolId, admissionNo, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (taken) throw ApiError.conflict(`Admission number ${admissionNo} is already in use`, { code: 'ADMISSION_NO_TAKEN' });
}

/**
 * Creates a student with optional guardians and enrollment.
 * Everything is validated before the first write; if a later write still fails, the records
 * created so far are removed (the database runs without transactions in development).
 */
export async function createStudent(tenant, data, ctx, { admissionId = null } = {}) {
  const schoolId = tenant.schoolId;
  const { guardians = [], enrollment, ...profile } = data;
  for (const k of Object.keys(profile)) if (profile[k] === '') delete profile[k];
  const access = await studentAccess(tenant);
  const status = profile.status || 'active';
  if (enrollment && status !== 'active') throw ApiError.badRequest('Only active students can be enrolled', { code: 'STUDENT_INACTIVE' });

  // Validate everything up front.
  let target = null;
  if (enrollment) {
    target = await prepareEnrollment(tenant, null, enrollment, access);
    if (profile.campusId && String(profile.campusId) !== String(target.section.campusId)) {
      throw ApiError.badRequest('The section belongs to a different campus', { code: 'ENROLLMENT_CAMPUS_MISMATCH' });
    }
    profile.campusId = target.section.campusId;
  }
  if (!profile.campusId) throw ApiError.validation([{ field: 'body.campusId', message: 'Campus is required when no section is given' }]);
  await assertCampusUsable(tenant, access, profile.campusId);
  if (profile.admissionNo) await assertAdmissionNoFree(schoolId, profile.admissionNo);
  await prepareLinks(tenant, guardians);
  if (status === 'active') await assertWithinLimit(schoolId, 'maxStudents');

  const admissionNo = profile.admissionNo || (await nextFreeCode(schoolId, 'admission_no', ADMISSION_NO_PREFIX, (c) => Student.exists({ schoolId, admissionNo: c })));

  const created = { guardians: [], links: [] };
  let student;
  let enrollmentDoc;
  try {
    student = await Student.create({ ...profile, status, admissionNo, schoolId, admissionId, admissionDate: profile.admissionDate || new Date(), createdBy: ctx.actorId });
    await createLinks(tenant, student, guardians, ctx, created);
    if (target) enrollmentDoc = await writeEnrollment(tenant, student, target, enrollment, ctx);
  } catch (err) {
    await rollback(schoolId, { student, enrollmentDoc, ...created });
    if (err?.code === 11000 && /admissionNo/.test(err.message)) throw ApiError.conflict(`Admission number ${admissionNo} is already in use`, { code: 'ADMISSION_NO_TAKEN' });
    if (err?.code === 11000 && /uniq_active_rollno/.test(err.message)) throw ApiError.conflict('This roll number is already used in the section', { code: 'ROLL_NO_TAKEN' });
    throw err;
  }

  await recordAudit({
    ...ctx,
    action: 'student.created',
    entityType: 'Student',
    entityId: student._id,
    metadata: { admissionNo, name: fullName(student), guardiansLinked: created.links.length, sectionId: enrollmentDoc?.sectionId ?? null, admissionId },
  });
  return getStudent(tenant, student._id);
}

async function rollback(schoolId, { student, enrollmentDoc, guardians = [], links = [] }) {
  try {
    if (enrollmentDoc) await Enrollment.deleteOne({ _id: enrollmentDoc._id, schoolId });
    if (links.length) await StudentGuardian.deleteMany({ schoolId, _id: { $in: links } });
    if (guardians.length) await Guardian.deleteMany({ schoolId, _id: { $in: guardians } });
    if (student) await Student.deleteOne({ _id: student._id, schoolId });
  } catch (err) {
    logger.error({ err, studentId: student?._id }, 'Student creation rollback failed');
  }
}

/* ------------------------------ update ------------------------------ */

export async function updateStudent(tenant, studentId, data, ctx) {
  const schoolId = tenant.schoolId;
  const access = await studentAccess(tenant);
  const student = await getStudentDoc(tenant, studentId, access);
  const before = { status: student.status, campusId: String(student.campusId), admissionNo: student.admissionNo };

  if (data.admissionNo && data.admissionNo !== student.admissionNo) await assertAdmissionNoFree(schoolId, data.admissionNo, student._id);

  if (data.campusId && String(data.campusId) !== String(student.campusId)) {
    await assertCampusUsable(tenant, access, data.campusId);
    const session = await currentSession(schoolId);
    const active = session && (await Enrollment.findOne({ schoolId, studentId: student._id, sessionId: session._id, status: 'active' }).lean());
    if (active) {
      throw ApiError.conflict('The campus follows the student’s current section. Move the student to a section at the other campus instead.', { code: 'CAMPUS_FOLLOWS_ENROLLMENT' });
    }
  }

  let enrollmentsEnded = 0;
  if (data.status && data.status !== student.status) {
    if (data.status === 'active') {
      await assertWithinLimit(schoolId, 'maxStudents');
      student.leftOn = null;
      student.leavingReason = undefined;
    }
    if (LEFT_STATUSES.includes(data.status)) {
      student.leftOn = data.leftOn || new Date();
      // Free the seat in open sessions; history in closed sessions stays as it was.
      const openSessions = await AcademicSession.distinct('_id', { schoolId, status: { $ne: 'closed' } });
      ({ modifiedCount: enrollmentsEnded } = await Enrollment.updateMany(
        { schoolId, studentId: student._id, sessionId: { $in: openSessions }, status: 'active' },
        { status: 'left', endedOn: student.leftOn, updatedBy: ctx.actorId },
      ));
    }
  }

  const { leftOn: _leftOn, ...rest } = data;
  for (const k of ['email', 'phone', 'notes', 'medicalNotes', 'previousSchool', 'photoUrl', 'leavingReason']) if (rest[k] === '') rest[k] = undefined;
  student.set({ ...rest, updatedBy: ctx.actorId });
  try {
    await student.save();
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict(`Admission number ${data.admissionNo} is already in use`, { code: 'ADMISSION_NO_TAKEN' });
    throw err;
  }
  await recordAudit({ ...ctx, action: 'student.updated', entityType: 'Student', entityId: student._id, metadata: { before, changed: Object.keys(data), enrollmentsEnded } });
  return getStudent(tenant, student._id);
}

/**
 * Deletes a student entered by mistake. Records referenced by attendance, fees or exams
 * (later phases) cannot be deleted; mark the student withdrawn instead.
 */
export async function deleteStudent(tenant, studentId, ctx) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  await assertDeletable('student', schoolId, student._id);
  if (student.membershipId) await revokeFamilyRole(schoolId, student.membershipId, 'student', ctx);
  const [{ deletedCount: enrollments }, { deletedCount: links }] = await Promise.all([
    Enrollment.deleteMany({ schoolId, studentId: student._id }),
    StudentGuardian.deleteMany({ schoolId, studentId: student._id }),
  ]);
  student.membershipId = null;
  await student.softDelete(ctx.actorId);
  await runDeleteHooks('student', schoolId, student._id);
  await recordAudit({ ...ctx, action: 'student.deleted', entityType: 'Student', entityId: student._id, metadata: { admissionNo: student.admissionNo, name: fullName(student), enrollments, links } });
}

/* ------------------------------ portal ------------------------------ */

export async function grantStudentPortal(tenant, studentId, { email } = {}, ctx) {
  const student = await getStudentDoc(tenant, studentId);
  if (student.membershipId) throw ApiError.conflict('This student already has portal access', { code: 'PORTAL_ALREADY_ENABLED' });
  if (student.status !== 'active') throw ApiError.badRequest('Only active students can get portal access', { code: 'STUDENT_INACTIVE' });
  const loginEmail = email || student.email;
  if (!loginEmail) throw ApiError.badRequest('Add an email address for this student first', { code: 'EMAIL_REQUIRED' });
  await assertLoginFree(tenant.schoolId, loginEmail);

  const result = await grantFamilyRole(tenant, { name: fullName(student), email: loginEmail, phone: student.phone }, 'student', ctx);
  student.membershipId = result.membership._id;
  if (!student.email) student.email = loginEmail;
  await student.save();
  return { student: await getStudent(tenant, student._id), isNewUser: result.isNewUser, emailDelivered: result.emailDelivered, emailError: result.emailError, setupEmailDelivered: result.setupEmailDelivered };
}

export async function revokeStudentPortal(tenant, studentId, ctx) {
  const student = await getStudentDoc(tenant, studentId);
  if (!student.membershipId) throw ApiError.badRequest('This student does not have portal access', { code: 'PORTAL_NOT_ENABLED' });
  await revokeFamilyRole(tenant.schoolId, student.membershipId, 'student', ctx);
  student.membershipId = null;
  await student.save();
  return getStudent(tenant, student._id);
}

/** Headline counts for the students screen (real data only). */
export async function studentSummary(tenant) {
  const schoolId = tenant.schoolId;
  const access = await studentAccess(tenant);
  const match = { schoolId, isDeleted: false, ...studentFilter(access) };
  const session = await currentSession(schoolId);
  const [byStatus, enrolledIds] = await Promise.all([
    Student.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    session ? Enrollment.distinct('studentId', { schoolId, sessionId: session._id, status: 'active' }) : [],
  ]);
  const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
  const activeNotEnrolled = session ? await Student.countDocuments({ ...match, status: 'active', _id: { $nin: enrolledIds } }) : null;
  return {
    session: session ? { id: session._id, name: session.name } : null,
    byStatus: counts,
    active: counts.active || 0,
    activeNotEnrolled,
  };
}
