import mongoose from 'mongoose';
import { Admission, STATUS_TRANSITIONS, MAX_HISTORY } from './admission.model.js';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models.js';
import { Campus } from '../campuses/campus.model.js';
import { getSessionOr404, assertSessionOpen, getClassOr404, nameMap, idStr } from '../academics/academics.common.js';
import { createStudent } from '../students/student.service.js';
import { nextFreeCode } from '../counters/counter.model.js';
import { normalizePhone } from '../common/person.validators.js';
import { escapeRegex } from '../common/person.schema.js';
import { isCampusRestricted, assertCampusAccess } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const OPEN_STATUSES = ['enquiry', 'applied', 'under_review', 'approved'];

async function decorate(schoolId, rows) {
  const [sessions, classes, campuses] = await Promise.all([
    nameMap(AcademicSession, schoolId, rows.map((r) => r.sessionId), 'name'),
    nameMap(SchoolClass, schoolId, rows.map((r) => r.classId), 'name code'),
    nameMap(Campus, schoolId, rows.map((r) => r.campusId), 'name code'),
  ]);
  return rows.map((r) => {
    const { guardian, isDeleted: _d, deletedAt: _da, deletedBy: _db, __v: _v, ...rest } = r;
    const { phoneNormalized: _p, ...guardianOut } = guardian || {};
    return {
      ...rest,
      guardian: guardianOut,
      applicantName: [r.applicant?.firstName, r.applicant?.lastName].filter(Boolean).join(' '),
      session: sessions.get(idStr(r.sessionId)) ? { id: r.sessionId, name: sessions.get(idStr(r.sessionId)).name } : null,
      class: classes.get(idStr(r.classId)) ? { id: r.classId, name: classes.get(idStr(r.classId)).name } : null,
      campus: campuses.get(idStr(r.campusId)) ? { id: r.campusId, name: campuses.get(idStr(r.campusId)).name } : null,
    };
  });
}

async function getAdmissionDoc(tenant, id) {
  const a = await Admission.findOne({ _id: id, schoolId: tenant.schoolId });
  if (!a) throw ApiError.notFound('Admission application not found');
  if (isCampusRestricted(tenant) && !tenant.campusIds.some((c) => String(c) === String(a.campusId))) throw ApiError.notFound('Admission application not found');
  return a;
}

async function assertCampusUsable(tenant, campusId) {
  assertCampusAccess(tenant, campusId);
  const campus = await Campus.findOne({ _id: campusId, schoolId: tenant.schoolId }).lean();
  if (!campus) throw ApiError.badRequest('Campus does not belong to this school', { code: 'INVALID_CAMPUS' });
  if (campus.status !== 'active') throw ApiError.badRequest('Campus is inactive', { code: 'CAMPUS_INACTIVE' });
}

/* ------------------------------ queries ------------------------------ */

export async function listAdmissions(tenant, { page, limit, sessionId, status, classId, campusId, source, search, followUpDue }) {
  const filter = { schoolId: tenant.schoolId };
  if (sessionId) filter.sessionId = sessionId;
  if (status) filter.status = status;
  if (classId) filter.classId = classId;
  if (source) filter.source = source;
  if (campusId) {
    assertCampusAccess(tenant, campusId);
    filter.campusId = campusId;
  } else if (isCampusRestricted(tenant)) {
    filter.campusId = { $in: tenant.campusIds };
  }
  if (followUpDue) {
    const endOfToday = new Date();
    endOfToday.setUTCHours(23, 59, 59, 999);
    filter.followUpDate = { $ne: null, $lte: endOfToday };
    if (!status) filter.status = { $in: OPEN_STATUSES };
  }
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const or = [{ applicationNo: rx }, { 'applicant.firstName': rx }, { 'applicant.lastName': rx }, { 'guardian.name': rx }];
    const digits = normalizePhone(search);
    if (/^\+?\d{4,}$/.test(digits)) or.push({ 'guardian.phoneNormalized': new RegExp(escapeRegex(digits)) });
    filter.$or = or;
  }
  const [rows, total] = await Promise.all([
    Admission.find(filter).select('-history').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Admission.countDocuments(filter),
  ]);
  return { items: await decorate(tenant.schoolId, rows), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

/** Application counts by status (for a session when given). */
export async function admissionSummary(tenant, { sessionId }) {
  const match = { schoolId: oid(tenant.schoolId), isDeleted: false };
  if (sessionId) match.sessionId = oid(sessionId);
  if (isCampusRestricted(tenant)) match.campusId = { $in: tenant.campusIds.map(oid) };
  const rows = await Admission.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  return { sessionId: sessionId ?? null, byStatus, total: rows.reduce((t, r) => t + r.n, 0) };
}

export async function getAdmission(tenant, id) {
  const a = await getAdmissionDoc(tenant, id);
  const [row] = await decorate(tenant.schoolId, [a.toObject()]);
  return row;
}

/* ------------------------------ mutations ------------------------------ */

function pushHistory(doc, status, note, actorId) {
  doc.history.push({ status, note, by: actorId });
  if (doc.history.length > MAX_HISTORY) doc.history.splice(0, doc.history.length - MAX_HISTORY);
}

export async function createAdmission(tenant, data, ctx) {
  const schoolId = tenant.schoolId;
  assertSessionOpen(await getSessionOr404(schoolId, data.sessionId));
  await getClassOr404(schoolId, data.classId, { requireActive: true });
  await assertCampusUsable(tenant, data.campusId);

  const status = data.status || 'enquiry';
  const applicationNo = await nextFreeCode(schoolId, 'application_no', 'APP', (c) => Admission.exists({ schoolId, applicationNo: c }).setOptions({ withDeleted: true }), { pad: 5 });
  const doc = new Admission({
    ...data,
    status,
    applicationNo,
    guardian: { ...data.guardian, phoneNormalized: normalizePhone(data.guardian.phone) },
    schoolId,
    createdBy: ctx.actorId,
  });
  pushHistory(doc, status, 'Application created', ctx.actorId);
  await doc.save();
  await recordAudit({ ...ctx, action: 'admission.created', entityType: 'Admission', entityId: doc._id, metadata: { applicationNo, status } });
  return getAdmission(tenant, doc._id);
}

function assertNotEnrolled(doc) {
  if (doc.status === 'enrolled') throw ApiError.conflict('This applicant has already been enrolled', { code: 'ADMISSION_ENROLLED' });
}

export async function updateAdmission(tenant, id, data, ctx) {
  const schoolId = tenant.schoolId;
  const doc = await getAdmissionDoc(tenant, id);
  assertNotEnrolled(doc);
  if (data.sessionId) assertSessionOpen(await getSessionOr404(schoolId, data.sessionId));
  if (data.classId) await getClassOr404(schoolId, data.classId, { requireActive: true });
  if (data.campusId) await assertCampusUsable(tenant, data.campusId);

  const { applicant, guardian, ...rest } = data;
  doc.set({ ...rest, updatedBy: ctx.actorId });
  if (applicant) for (const [k, v] of Object.entries(applicant)) doc.set(`applicant.${k}`, v);
  if (guardian) {
    for (const [k, v] of Object.entries(guardian)) doc.set(`guardian.${k}`, v === '' ? undefined : v);
    if (guardian.phone) doc.set('guardian.phoneNormalized', normalizePhone(guardian.phone));
  }
  await doc.save();
  await recordAudit({ ...ctx, action: 'admission.updated', entityType: 'Admission', entityId: doc._id, metadata: { changed: Object.keys(data) } });
  return getAdmission(tenant, doc._id);
}

export async function changeStatus(tenant, id, { status, note }, ctx) {
  const doc = await getAdmissionDoc(tenant, id);
  assertNotEnrolled(doc);
  if (status === doc.status) throw ApiError.badRequest(`Application is already ${status.replace('_', ' ')}`, { code: 'STATUS_UNCHANGED' });
  if (!STATUS_TRANSITIONS[doc.status].includes(status)) {
    throw ApiError.badRequest(`Cannot change an application from ${doc.status} to ${status}`, {
      code: 'INVALID_STATUS_TRANSITION',
      details: { from: doc.status, allowed: STATUS_TRANSITIONS[doc.status] },
    });
  }
  const from = doc.status;
  doc.status = status;
  doc.updatedBy = ctx.actorId;
  pushHistory(doc, status, note, ctx.actorId);
  await doc.save();
  await recordAudit({ ...ctx, action: 'admission.status_changed', entityType: 'Admission', entityId: doc._id, metadata: { from, to: status, note } });
  return getAdmission(tenant, doc._id);
}

/**
 * Turns an approved application into a student, using the same student-creation path as the
 * students module (limits, admission numbers, guardian duplicate checks, enrollment rules).
 */
export async function enrollApplicant(tenant, id, data, ctx) {
  const schoolId = tenant.schoolId;
  const doc = await getAdmissionDoc(tenant, id);
  assertNotEnrolled(doc);
  if (doc.status !== 'approved') throw ApiError.badRequest('Only approved applications can be enrolled', { code: 'ADMISSION_NOT_APPROVED' });
  assertSessionOpen(await getSessionOr404(schoolId, doc.sessionId));

  if (data.sectionId) {
    const section = await Section.findOne({ _id: data.sectionId, schoolId }).lean();
    if (!section) throw ApiError.notFound('Section not found');
    if (String(section.sessionId) !== String(doc.sessionId) || String(section.classId) !== String(doc.classId)) {
      throw ApiError.badRequest('Choose a section of the class and session the applicant applied for', { code: 'SECTION_MISMATCH' });
    }
  }

  const g = doc.guardian;
  const guardianLink = data.guardianId
    ? { guardianId: data.guardianId, relation: g.relation, isPrimary: true }
    : {
        guardian: { name: g.name, phone: g.phone, email: g.email || undefined, occupation: g.occupation || undefined, allowDuplicate: data.allowDuplicateGuardian },
        relation: g.relation,
        isPrimary: true,
      };

  const student = await createStudent(
    tenant,
    {
      firstName: doc.applicant.firstName,
      lastName: doc.applicant.lastName || undefined,
      gender: doc.applicant.gender,
      dateOfBirth: doc.applicant.dateOfBirth || undefined,
      previousSchool: doc.applicant.previousSchool || undefined,
      admissionNo: data.admissionNo,
      admissionDate: data.admissionDate,
      ...(data.sectionId ? { enrollment: { sectionId: data.sectionId, rollNo: data.rollNo } } : { campusId: doc.campusId }),
      guardians: [guardianLink],
    },
    ctx,
    { admissionId: doc._id },
  );

  doc.status = 'enrolled';
  doc.studentId = student._id;
  doc.enrolledAt = new Date();
  doc.updatedBy = ctx.actorId;
  pushHistory(doc, 'enrolled', `Admission number ${student.admissionNo}`, ctx.actorId);
  await doc.save();
  await recordAudit({ ...ctx, action: 'admission.enrolled', entityType: 'Admission', entityId: doc._id, metadata: { studentId: student._id, admissionNo: student.admissionNo } });
  return { admission: await getAdmission(tenant, doc._id), student };
}

export async function deleteAdmission(tenant, id, ctx) {
  const doc = await getAdmissionDoc(tenant, id);
  assertNotEnrolled(doc);
  await doc.softDelete(ctx.actorId);
  await recordAudit({ ...ctx, action: 'admission.deleted', entityType: 'Admission', entityId: doc._id, metadata: { applicationNo: doc.applicationNo } });
}
