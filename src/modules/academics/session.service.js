import { AcademicSession, Section, ClassSubject, TeachingAssignment } from './academics.models.js';
import { CalendarEvent } from '../calendar/calendarEvent.model.js';
import { Membership } from '../memberships/membership.model.js';
import { getSessionOr404, assertSessionOpen } from './academics.common.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { daysBetween } from '../../utils/dates.js';
import { assertDeletable } from '../../utils/dependencyGuards.js';
import { recordAudit } from '../audit/audit.service.js';

const MAX_SESSION_DAYS = 731;

function assertDates(startDate, endDate) {
  if (endDate <= startDate) throw ApiError.validation([{ field: 'body.endDate', message: 'End date must be after the start date' }]);
  if (daysBetween(startDate, endDate) > MAX_SESSION_DAYS) {
    throw ApiError.validation([{ field: 'body.endDate', message: 'A session cannot be longer than two years' }]);
  }
}

export function listSessions(schoolId, { page, limit, status }) {
  const filter = { schoolId };
  if (status) filter.status = status;
  return paginate(AcademicSession, filter, { page, limit, sort: '-startDate' });
}

export const getSession = (schoolId, sessionId) => getSessionOr404(schoolId, sessionId);

export async function getCurrentSession(schoolId) {
  const s = await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  if (!s) throw ApiError.notFound('No current academic session', { code: 'NO_CURRENT_SESSION' });
  return s;
}

async function makeCurrent(schoolId, session) {
  await AcademicSession.updateMany({ schoolId, isCurrent: true, _id: { $ne: session._id } }, { $set: { isCurrent: false } });
  session.isCurrent = true;
  if (session.status === 'planned') session.status = 'active';
  await session.save();
}

export async function createSession(tenant, data, ctx) {
  assertDates(data.startDate, data.endDate);
  const { isCurrent, ...fields } = data;
  const first = !(await AcademicSession.exists({ schoolId: tenant.schoolId }));
  const session = await AcademicSession.create({ ...fields, schoolId: tenant.schoolId, isCurrent: false, createdBy: ctx.actorId });
  if (isCurrent || first) await makeCurrent(tenant.schoolId, session);
  await recordAudit({ ...ctx, action: 'academic_session.created', entityType: 'AcademicSession', entityId: session._id, metadata: { name: session.name, isCurrent: session.isCurrent } });
  return session;
}

export async function updateSession(tenant, sessionId, data, ctx) {
  const session = await getSessionOr404(tenant.schoolId, sessionId);
  const startDate = data.startDate ?? session.startDate;
  const endDate = data.endDate ?? session.endDate;
  if (data.startDate || data.endDate) {
    assertDates(startDate, endDate);
    const outside = await CalendarEvent.countDocuments({
      schoolId: tenant.schoolId,
      sessionId: session._id,
      $or: [{ startDate: { $lt: startDate } }, { endDate: { $gt: endDate } }],
    });
    if (outside) throw ApiError.badRequest(`${outside} calendar event(s) fall outside the new dates. Move them first.`, { code: 'EVENTS_OUTSIDE_SESSION' });
  }
  if (data.status === 'closed' && session.isCurrent) {
    throw ApiError.badRequest('The current session cannot be closed. Make another session current first.', { code: 'CURRENT_SESSION' });
  }
  if (data.status === 'planned' && session.isCurrent) {
    throw ApiError.badRequest('The current session cannot be set back to planned', { code: 'CURRENT_SESSION' });
  }
  const before = { name: session.name, status: session.status, startDate: session.startDate, endDate: session.endDate };
  session.set({ ...data, updatedBy: ctx.actorId });
  await session.save();
  await recordAudit({ ...ctx, action: 'academic_session.updated', entityType: 'AcademicSession', entityId: session._id, metadata: { before, changed: Object.keys(data) } });
  return session;
}

export async function setCurrentSession(tenant, sessionId, ctx) {
  const session = await getSessionOr404(tenant.schoolId, sessionId);
  if (session.status === 'closed') throw ApiError.badRequest('A closed session cannot be made current. Reopen it first.', { code: 'SESSION_CLOSED' });
  if (!session.isCurrent) await makeCurrent(tenant.schoolId, session);
  await recordAudit({ ...ctx, action: 'academic_session.set_current', entityType: 'AcademicSession', entityId: session._id, metadata: { name: session.name } });
  return session;
}

export async function deleteSession(tenant, sessionId, ctx) {
  const session = await getSessionOr404(tenant.schoolId, sessionId);
  if (session.isCurrent) throw ApiError.badRequest('The current session cannot be deleted', { code: 'CURRENT_SESSION' });
  await assertDeletable('session', tenant.schoolId, session._id, 'academic session');
  await AcademicSession.deleteOne({ _id: session._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'academic_session.deleted', entityType: 'AcademicSession', entityId: session._id, metadata: { name: session.name } });
}

/**
 * Year rollover: copies sections (and optionally their class teachers), the class-subject
 * curriculum and (optionally) subject-teacher assignments from another session.
 * Existing records in the target are kept; only missing ones are created.
 */
export async function copyStructure(tenant, targetId, { fromSessionId, sections = true, classSubjects = true, teachers = false }, ctx) {
  const schoolId = tenant.schoolId;
  if (String(targetId) === String(fromSessionId)) throw ApiError.badRequest('Source and target sessions must differ');
  const [target, source] = await Promise.all([getSessionOr404(schoolId, targetId), getSessionOr404(schoolId, fromSessionId)]);
  assertSessionOpen(target);

  const result = { sectionsCreated: 0, classSubjectsCreated: 0, assignmentsCreated: 0, teachersSkipped: 0 };

  // Only carry teachers forward who are still active members with access to the campus.
  let canTeach = () => false;
  if (teachers) {
    const referenced = [
      ...(await Section.distinct('classTeacherId', { schoolId, sessionId: source._id })),
      ...(await TeachingAssignment.distinct('teacherId', { schoolId, sessionId: source._id })),
    ].filter(Boolean);
    const active = new Map(
      (await Membership.find({ schoolId, status: 'active', _id: { $in: referenced } }).select('campusIds').lean()).map((m) => [String(m._id), m.campusIds.map(String)]),
    );
    canTeach = (teacherId, campusId) => {
      const campuses = teacherId && active.get(String(teacherId));
      const ok = Boolean(campuses) && (campuses.length === 0 || campuses.includes(String(campusId)));
      if (teacherId && !ok) result.teachersSkipped += 1;
      return ok;
    };
  }

  // Section key → target section id, for mapping teaching assignments.
  const key = (s) => `${s.classId}|${s.campusId}|${s.name}`;
  const targetSections = new Map((await Section.find({ schoolId, sessionId: target._id }).lean()).map((s) => [key(s), s._id]));

  if (sections) {
    const src = await Section.find({ schoolId, sessionId: source._id, status: 'active' }).lean();
    const toCreate = src
      .filter((s) => !targetSections.has(key(s)))
      .map((s) => ({
        schoolId,
        sessionId: target._id,
        classId: s.classId,
        campusId: s.campusId,
        name: s.name,
        capacity: s.capacity,
        room: s.room,
        classTeacherId: canTeach(s.classTeacherId, s.campusId) ? s.classTeacherId : null,
        createdBy: ctx.actorId,
      }));
    if (toCreate.length) {
      const created = await Section.insertMany(toCreate);
      for (const s of created) targetSections.set(key(s), s._id);
      result.sectionsCreated = created.length;
    }
  }

  if (classSubjects) {
    const [src, existing] = await Promise.all([
      ClassSubject.find({ schoolId, sessionId: source._id }).lean(),
      ClassSubject.find({ schoolId, sessionId: target._id }).select('classId subjectId').lean(),
    ]);
    const have = new Set(existing.map((c) => `${c.classId}|${c.subjectId}`));
    const toCreate = src
      .filter((c) => !have.has(`${c.classId}|${c.subjectId}`))
      .map((c) => ({ schoolId, sessionId: target._id, classId: c.classId, subjectId: c.subjectId, isOptional: c.isOptional, periodsPerWeek: c.periodsPerWeek, order: c.order, createdBy: ctx.actorId }));
    if (toCreate.length) result.classSubjectsCreated = (await ClassSubject.insertMany(toCreate)).length;
  }

  if (teachers) {
    const srcSections = new Map((await Section.find({ schoolId, sessionId: source._id }).lean()).map((s) => [String(s._id), s]));
    const [srcAssignments, existing] = await Promise.all([
      TeachingAssignment.find({ schoolId, sessionId: source._id }).lean(),
      TeachingAssignment.find({ schoolId, sessionId: target._id }).select('sectionId subjectId teacherId').lean(),
    ]);
    const have = new Set(existing.map((a) => `${a.sectionId}|${a.subjectId}|${a.teacherId}`));
    const toCreate = [];
    for (const a of srcAssignments) {
      const srcSection = srcSections.get(String(a.sectionId));
      const targetSectionId = srcSection && targetSections.get(key(srcSection));
      if (!targetSectionId) continue;
      const k = `${targetSectionId}|${a.subjectId}|${a.teacherId}`;
      if (have.has(k) || !canTeach(a.teacherId, srcSection.campusId)) continue;
      have.add(k);
      toCreate.push({ schoolId, sessionId: target._id, sectionId: targetSectionId, subjectId: a.subjectId, teacherId: a.teacherId, createdBy: ctx.actorId });
    }
    if (toCreate.length) result.assignmentsCreated = (await TeachingAssignment.insertMany(toCreate)).length;
  }

  await recordAudit({ ...ctx, action: 'academic_session.structure_copied', entityType: 'AcademicSession', entityId: target._id, metadata: { from: source._id, ...result } });
  return result;
}
