import { BellSchedule, TimetableEntry } from './timetable.models.js';
import { Section, SchoolClass, Subject, ClassSubject, TeachingAssignment } from '../academics/academics.models.js';
import { Campus } from '../campuses/campus.model.js';
import { resolveSession, getSessionOr404, assertSessionOpen, teacherMap, nameMap, idStr } from '../academics/academics.common.js';
import { getSectionDoc } from '../academics/section.service.js';
import { isCampusRestricted, assertCampusAccess } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The bell schedule that applies to a campus in a session (campus-specific, else the school default). */
export async function scheduleFor(schoolId, sessionId, campusId) {
  const rows = await BellSchedule.find({ schoolId, sessionId, campusId: { $in: [campusId, null] } }).lean();
  return rows.find((r) => String(r.campusId) === String(campusId)) || rows.find((r) => r.campusId === null) || null;
}

/* ------------------------------ bell schedules ------------------------------ */

async function decorateSchedules(schoolId, rows) {
  const campuses = await nameMap(Campus, schoolId, rows.map((r) => r.campusId), 'name code');
  return rows.map((r) => ({ ...r, campus: r.campusId ? campuses.get(idStr(r.campusId)) ?? null : null }));
}

export async function listSchedules(tenant, { sessionId }) {
  const session = await resolveSession(tenant.schoolId, sessionId);
  const filter = { schoolId: tenant.schoolId, sessionId: session._id };
  if (isCampusRestricted(tenant)) filter.campusId = { $in: [null, ...tenant.campusIds] };
  const rows = await BellSchedule.find(filter).sort({ campusId: 1 }).lean();
  return { session: { id: session._id, name: session.name }, items: await decorateSchedules(tenant.schoolId, rows) };
}

async function getScheduleDoc(tenant, id) {
  const s = await BellSchedule.findOne({ _id: id, schoolId: tenant.schoolId });
  if (!s) throw ApiError.notFound('Bell schedule not found');
  if (s.campusId) assertCampusAccess(tenant, s.campusId);
  return s;
}

/** Sections whose timetable uses this schedule. */
async function sectionsUsing(schedule) {
  const { schoolId, sessionId, campusId } = schedule;
  if (campusId) return Section.distinct('_id', { schoolId, sessionId, campusId });
  const overridden = await BellSchedule.distinct('campusId', { schoolId, sessionId, campusId: { $ne: null } });
  return Section.distinct('_id', { schoolId, sessionId, campusId: { $nin: overridden } });
}

export async function createSchedule(tenant, data, ctx) {
  const schoolId = tenant.schoolId;
  assertSessionOpen(await getSessionOr404(schoolId, data.sessionId));
  if (data.campusId) {
    assertCampusAccess(tenant, data.campusId);
    if (!(await Campus.exists({ _id: data.campusId, schoolId }))) throw ApiError.badRequest('Campus does not belong to this school', { code: 'INVALID_CAMPUS' });
  } else if (isCampusRestricted(tenant)) {
    throw ApiError.forbidden('Only members with access to all campuses can set the school default schedule', { code: 'CAMPUS_ACCESS_DENIED' });
  }
  let doc;
  try {
    doc = await BellSchedule.create({ ...data, campusId: data.campusId || null, schoolId, createdBy: ctx.actorId });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('A bell schedule already exists for this session and campus', { code: 'SCHEDULE_EXISTS' });
    throw err;
  }
  await recordAudit({ ...ctx, action: 'bell_schedule.created', entityType: 'BellSchedule', entityId: doc._id, metadata: { sessionId: doc.sessionId, campusId: doc.campusId } });
  const [row] = await decorateSchedules(schoolId, [doc.toObject()]);
  return row;
}

export async function updateSchedule(tenant, id, data, ctx) {
  const schoolId = tenant.schoolId;
  const doc = await getScheduleDoc(tenant, id);
  assertSessionOpen(await getSessionOr404(schoolId, doc.sessionId));
  if (data.periods || data.workingDays) {
    const sectionIds = await sectionsUsing(doc);
    const periods = data.periods || doc.periods;
    const teaching = periods.filter((p) => !p.isBreak).map((p) => p.number);
    const days = data.workingDays || doc.workingDays;
    const blockedPeriod = await TimetableEntry.findOne({ schoolId, sessionId: doc.sessionId, sectionId: { $in: sectionIds }, periodNumber: { $nin: teaching } }).lean();
    if (blockedPeriod) throw ApiError.conflict(`Period ${blockedPeriod.periodNumber} is used in timetables. Clear those periods first.`, { code: 'PERIOD_IN_USE' });
    const blockedDay = await TimetableEntry.findOne({ schoolId, sessionId: doc.sessionId, sectionId: { $in: sectionIds }, day: { $nin: days } }).lean();
    if (blockedDay) throw ApiError.conflict(`${DAY_NAMES[blockedDay.day]} has timetable entries. Clear them first.`, { code: 'DAY_IN_USE' });
  }
  doc.set({ ...data, updatedBy: ctx.actorId });
  await doc.save();
  await recordAudit({ ...ctx, action: 'bell_schedule.updated', entityType: 'BellSchedule', entityId: doc._id, metadata: { changed: Object.keys(data) } });
  const [row] = await decorateSchedules(schoolId, [doc.toObject()]);
  return row;
}

export async function deleteSchedule(tenant, id, ctx) {
  const doc = await getScheduleDoc(tenant, id);
  assertSessionOpen(await getSessionOr404(tenant.schoolId, doc.sessionId));
  const sectionIds = await sectionsUsing(doc);
  const used = await TimetableEntry.countDocuments({ schoolId: tenant.schoolId, sessionId: doc.sessionId, sectionId: { $in: sectionIds } });
  if (used) throw ApiError.conflict(`This schedule is used by ${used} timetable entries`, { code: 'SCHEDULE_IN_USE' });
  await BellSchedule.deleteOne({ _id: doc._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'bell_schedule.deleted', entityType: 'BellSchedule', entityId: doc._id, metadata: { sessionId: doc.sessionId, campusId: doc.campusId } });
}

/* ------------------------------ timetables ------------------------------ */

async function decorateEntries(schoolId, entries) {
  const [subjects, teachers, sections, classes] = await Promise.all([
    nameMap(Subject, schoolId, entries.map((e) => e.subjectId), 'name code'),
    teacherMap(schoolId, entries.map((e) => e.teacherId)),
    nameMap(Section, schoolId, entries.map((e) => e.sectionId), 'name classId'),
    nameMap(SchoolClass, schoolId, entries.map((e) => e.classId), 'name'),
  ]);
  return entries.map((e) => {
    const sec = sections.get(idStr(e.sectionId));
    const s = subjects.get(idStr(e.subjectId));
    const t = e.teacherId ? teachers.get(idStr(e.teacherId)) : null;
    return {
      _id: e._id,
      day: e.day,
      dayName: DAY_NAMES[e.day],
      periodNumber: e.periodNumber,
      sectionId: e.sectionId,
      section: sec ? { id: sec._id, displayName: `${classes.get(idStr(e.classId))?.name ?? ''} - ${sec.name}` } : null,
      subject: s ? { id: s._id, name: s.name, code: s.code } : null,
      teacher: t ? { id: t.id, name: t.name } : null,
      room: e.room ?? null,
    };
  });
}

export async function getSectionTimetable(tenant, sectionId) {
  const section = await getSectionDoc(tenant, sectionId);
  return sectionTimetable(tenant.schoolId, section);
}

/** Timetable of a section document (no access check: callers check access). */
export async function sectionTimetable(schoolId, section) {
  const [schedule, entries, cls] = await Promise.all([
    scheduleFor(schoolId, section.sessionId, section.campusId),
    TimetableEntry.find({ schoolId, sectionId: section._id }).sort({ day: 1, periodNumber: 1 }).lean(),
    SchoolClass.findOne({ _id: section.classId, schoolId }).setOptions({ withDeleted: true }).select('name').lean(),
  ]);
  return {
    section: { id: section._id, displayName: `${cls?.name ?? ''} - ${section.name}`, sessionId: section.sessionId, campusId: section.campusId },
    schedule: schedule ? { id: schedule._id, name: schedule.name, workingDays: schedule.workingDays, periods: schedule.periods } : null,
    entries: await decorateEntries(schoolId, entries),
  };
}

/**
 * Replaces a section's weekly timetable. Every cell must use a working day and a teaching
 * (non-break) period of the bell schedule, a subject from the class curriculum and, when a
 * teacher is given, a teacher assigned to that subject in the section who is free in that period.
 */
export async function setSectionTimetable(tenant, sectionId, { entries }, ctx) {
  const schoolId = tenant.schoolId;
  const section = await getSectionDoc(tenant, sectionId);
  assertSessionOpen(await getSessionOr404(schoolId, section.sessionId));
  const schedule = await scheduleFor(schoolId, section.sessionId, section.campusId);
  if (!schedule) throw ApiError.badRequest('Create a bell schedule for this session first', { code: 'NO_BELL_SCHEDULE' });

  const teaching = new Set(schedule.periods.filter((p) => !p.isBreak).map((p) => p.number));
  const days = new Set(schedule.workingDays);
  const cells = new Set();
  for (const e of entries) {
    if (!days.has(e.day)) throw ApiError.badRequest(`${DAY_NAMES[e.day]} is not a working day in the bell schedule`, { code: 'INVALID_DAY' });
    if (!teaching.has(e.periodNumber)) throw ApiError.badRequest(`Period ${e.periodNumber} is not a teaching period`, { code: 'INVALID_PERIOD' });
    const key = `${e.day}:${e.periodNumber}`;
    if (cells.has(key)) throw ApiError.validation([{ field: 'body.entries', message: `${DAY_NAMES[e.day]} period ${e.periodNumber} appears twice` }]);
    cells.add(key);
  }

  const [curriculum, assignments] = await Promise.all([
    ClassSubject.distinct('subjectId', { schoolId, sessionId: section.sessionId, classId: section.classId }),
    TeachingAssignment.find({ schoolId, sectionId: section._id }).select('subjectId teacherId').lean(),
  ]);
  const inCurriculum = new Set(curriculum.map(String));
  const assigned = new Set(assignments.map((a) => `${a.subjectId}:${a.teacherId}`));
  for (const e of entries) {
    if (!inCurriculum.has(String(e.subjectId))) throw ApiError.badRequest('A subject is not part of this class’s curriculum', { code: 'SUBJECT_NOT_IN_CLASS', details: { subjectId: e.subjectId } });
    if (e.teacherId && !assigned.has(`${e.subjectId}:${e.teacherId}`)) {
      throw ApiError.badRequest('The teacher is not assigned to teach this subject in the section', { code: 'TEACHER_NOT_ASSIGNED', details: { subjectId: e.subjectId, teacherId: e.teacherId } });
    }
  }

  const teacherIds = [...new Set(entries.filter((e) => e.teacherId).map((e) => String(e.teacherId)))];
  if (teacherIds.length) {
    const busy = await TimetableEntry.find({ schoolId, sessionId: section.sessionId, teacherId: { $in: teacherIds }, sectionId: { $ne: section._id } }).lean();
    const busyBy = new Map(busy.map((b) => [`${b.teacherId}:${b.day}:${b.periodNumber}`, b]));
    const clashes = entries.filter((e) => e.teacherId && busyBy.has(`${e.teacherId}:${e.day}:${e.periodNumber}`));
    if (clashes.length) {
      const decorated = await decorateEntries(schoolId, clashes.map((c) => busyBy.get(`${c.teacherId}:${c.day}:${c.periodNumber}`)));
      throw ApiError.conflict('A teacher is already teaching another class in the same period', {
        code: 'TEACHER_CLASH',
        details: { clashes: decorated.map((d) => ({ teacher: d.teacher, day: d.day, dayName: d.dayName, periodNumber: d.periodNumber, section: d.section })) },
      });
    }
  }

  const old = await TimetableEntry.find({ schoolId, sectionId: section._id }).lean();
  await TimetableEntry.deleteMany({ schoolId, sectionId: section._id });
  try {
    await TimetableEntry.insertMany(
      entries.map((e) => ({
        schoolId,
        sessionId: section.sessionId,
        sectionId: section._id,
        classId: section.classId,
        campusId: section.campusId,
        day: e.day,
        periodNumber: e.periodNumber,
        subjectId: e.subjectId,
        teacherId: e.teacherId || null,
        room: e.room,
        createdBy: ctx.actorId,
      })),
    );
  } catch (err) {
    // Restore the previous timetable (e.g. a clash created concurrently by another editor).
    await TimetableEntry.deleteMany({ schoolId, sectionId: section._id });
    if (old.length) await TimetableEntry.insertMany(old);
    if (err?.code === 11000) throw ApiError.conflict('A teacher was just scheduled elsewhere in the same period. Reload and try again.', { code: 'TEACHER_CLASH' });
    throw err;
  }
  await recordAudit({ ...ctx, action: 'timetable.saved', entityType: 'Section', entityId: section._id, metadata: { before: old.length, after: entries.length } });
  return sectionTimetable(schoolId, section);
}

/** A teacher's weekly timetable (optionally one day), with period times. */
export async function teacherTimetable(tenant, memberId, { sessionId, day }) {
  const schoolId = tenant.schoolId;
  const own = String(memberId) === String(tenant.membershipId);
  if (!own && !tenant.permissions.has('timetable.update')) throw ApiError.forbidden('You can only view your own timetable', { code: 'PERMISSION_DENIED' });
  const session = await resolveSession(schoolId, sessionId);
  const filter = { schoolId, sessionId: session._id, teacherId: memberId };
  if (day !== undefined) filter.day = day;
  const entries = await TimetableEntry.find(filter).sort({ day: 1, periodNumber: 1 }).lean();
  const campusIds = [...new Set(entries.map((e) => String(e.campusId)))];
  const schedules = new Map(await Promise.all(campusIds.map(async (c) => [c, await scheduleFor(schoolId, session._id, c)])));
  const decorated = await decorateEntries(schoolId, entries);
  return {
    session: { id: session._id, name: session.name },
    teacherId: memberId,
    entries: decorated.map((d, i) => {
      const period = schedules.get(String(entries[i].campusId))?.periods.find((p) => p.number === d.periodNumber);
      return { ...d, period: period ? { label: period.label ?? null, startTime: period.startTime, endTime: period.endTime } : null };
    }),
  };
}
