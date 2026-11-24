import { ClassSubject, TeachingAssignment, Section, SchoolClass, Subject } from './academics.models.js';
import { resolveSession, getSessionOr404, assertSessionOpen, getClassOr404, teacherMap, nameMap, idStr, uniqIds } from './academics.common.js';
import { getSectionDoc, decorateSections } from './section.service.js';
import { assertAssignableStaff } from '../memberships/membership.service.js';
import { campusFilter } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { recordAudit } from '../audit/audit.service.js';
import { assertDeletable, runDeleteHooks } from '../../utils/dependencyGuards.js';

/* ----------------------------- class subjects ----------------------------- */

export async function listClassSubjects(tenant, { sessionId, classId }) {
  const session = await resolveSession(tenant.schoolId, sessionId);
  await getClassOr404(tenant.schoolId, classId);
  const rows = await ClassSubject.find({ schoolId: tenant.schoolId, sessionId: session._id, classId }).sort('order').lean();
  const subjects = await nameMap(Subject, tenant.schoolId, rows.map((r) => r.subjectId), 'name code type status');
  return {
    sessionId: session._id,
    classId,
    subjects: rows.map((r) => ({ ...r, subject: subjects.get(idStr(r.subjectId)) || null })),
  };
}

/**
 * Replaces the subject list of a class for a session. Subjects removed from the class also
 * lose their teaching assignments in that class's sections.
 */
export async function setClassSubjects(tenant, { sessionId, classId, subjects }, ctx) {
  const schoolId = tenant.schoolId;
  const session = await getSessionOr404(schoolId, sessionId);
  assertSessionOpen(session);
  await getClassOr404(schoolId, classId, { requireActive: true });

  const ids = subjects.map((s) => String(s.subjectId));
  if (new Set(ids).size !== ids.length) throw ApiError.validation([{ field: 'body.subjects', message: 'Each subject may appear only once' }]);

  const existing = await ClassSubject.find({ schoolId, sessionId: session._id, classId }).lean();
  const existingIds = new Set(existing.map((e) => String(e.subjectId)));

  if (ids.length) {
    const found = await Subject.find({ schoolId, _id: { $in: ids } }).select('status').lean();
    if (found.length !== ids.length) throw ApiError.badRequest('One or more subjects do not belong to this school', { code: 'INVALID_SUBJECT' });
    const newlyAddedInactive = found.filter((s) => s.status !== 'active' && !existingIds.has(String(s._id)));
    if (newlyAddedInactive.length) throw ApiError.badRequest('Inactive subjects cannot be added to a class', { code: 'SUBJECT_INACTIVE' });
  }

  const removed = existing.filter((e) => !ids.includes(String(e.subjectId))).map((e) => e.subjectId);
  let assignmentsRemoved = 0;
  if (removed.length) {
    const change = { sessionId: session._id, classId, subjectIds: removed };
    await assertDeletable('class_subjects', schoolId, change, 'subject removal'); // e.g. exam papers block it
    await runDeleteHooks('class_subjects', schoolId, change); // e.g. timetable periods are cleaned up
    const sectionIds = await Section.distinct('_id', { schoolId, sessionId: session._id, classId });
    ({ deletedCount: assignmentsRemoved } = await TeachingAssignment.deleteMany({ schoolId, sectionId: { $in: sectionIds }, subjectId: { $in: removed } }));
    await ClassSubject.deleteMany({ schoolId, sessionId: session._id, classId, subjectId: { $in: removed } });
  }

  if (subjects.length) {
    await ClassSubject.bulkWrite(
      subjects.map((s, i) => ({
        updateOne: {
          filter: { schoolId, sessionId: session._id, classId, subjectId: s.subjectId },
          update: {
            $set: { isOptional: s.isOptional ?? false, periodsPerWeek: s.periodsPerWeek ?? null, order: s.order ?? i, updatedBy: ctx.actorId },
            $setOnInsert: { createdBy: ctx.actorId },
          },
          upsert: true,
        },
      })),
    );
  }

  await recordAudit({
    ...ctx,
    action: 'class_subjects.updated',
    entityType: 'SchoolClass',
    entityId: classId,
    metadata: { sessionId: session._id, subjects: ids, removed: removed.map(String), assignmentsRemoved },
  });
  return { ...(await listClassSubjects(tenant, { sessionId: session._id, classId })), assignmentsRemoved };
}

/* -------------------------- teaching assignments -------------------------- */

async function decorateAssignments(tenant, rows) {
  const schoolId = tenant.schoolId;
  const sections = await Section.find({ schoolId, _id: { $in: uniqIds(rows.map((r) => r.sectionId)) } }).lean();
  const [decorated, subjects, teachers] = await Promise.all([
    decorateSections(schoolId, sections),
    nameMap(Subject, schoolId, rows.map((r) => r.subjectId), 'name code'),
    teacherMap(schoolId, rows.map((r) => r.teacherId)),
  ]);
  const secMap = new Map(decorated.map((s) => [String(s._id), s]));
  return rows.map((r) => {
    const sec = secMap.get(idStr(r.sectionId));
    return {
      ...r,
      section: sec ? { id: sec._id, name: sec.name, displayName: sec.displayName, class: sec.class, campus: sec.campus } : null,
      subject: subjects.get(idStr(r.subjectId)) || null,
      teacher: teachers.get(idStr(r.teacherId)) || null,
    };
  });
}

export async function listAssignments(tenant, { sessionId, sectionId, subjectId, teacherId, page, limit }) {
  const schoolId = tenant.schoolId;
  const session = await resolveSession(schoolId, sessionId);
  const filter = { schoolId, sessionId: session._id };
  if (subjectId) filter.subjectId = subjectId;
  if (teacherId) filter.teacherId = teacherId;
  if (sectionId) {
    await getSectionDoc(tenant, sectionId); // campus access check
    filter.sectionId = sectionId;
  } else {
    const scoped = campusFilter(tenant);
    if (scoped.campusId) filter.sectionId = { $in: await Section.distinct('_id', { schoolId, sessionId: session._id, ...scoped }) };
  }
  const result = await paginate(TeachingAssignment, filter, { page, limit, sort: 'sectionId subjectId' });
  result.items = await decorateAssignments(tenant, result.items);
  result.meta.sessionId = session._id;
  return result;
}

export async function createAssignment(tenant, { sectionId, subjectId, teacherId }, ctx) {
  const schoolId = tenant.schoolId;
  const section = await getSectionDoc(tenant, sectionId);
  const session = await getSessionOr404(schoolId, section.sessionId);
  assertSessionOpen(session);

  const mapped = await ClassSubject.exists({ schoolId, sessionId: section.sessionId, classId: section.classId, subjectId });
  if (!mapped) throw ApiError.badRequest('This subject is not part of the class curriculum for this session', { code: 'SUBJECT_NOT_IN_CLASS' });
  await assertAssignableStaff(schoolId, teacherId, { campusId: section.campusId });

  const doc = await TeachingAssignment.create({ schoolId, sessionId: section.sessionId, sectionId, subjectId, teacherId, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'teaching_assignment.created', entityType: 'TeachingAssignment', entityId: doc._id, metadata: { sectionId, subjectId, teacherId } });
  const [decorated] = await decorateAssignments(tenant, [doc.toObject()]);
  return decorated;
}

export async function deleteAssignment(tenant, assignmentId, ctx) {
  const doc = await TeachingAssignment.findOne({ _id: assignmentId, schoolId: tenant.schoolId });
  if (!doc) throw ApiError.notFound('Teaching assignment not found');
  await getSectionDoc(tenant, doc.sectionId);
  assertSessionOpen(await getSessionOr404(tenant.schoolId, doc.sessionId));
  await assertDeletable('teaching_assignment', tenant.schoolId, doc._id, 'assignment');
  await TeachingAssignment.deleteOne({ _id: doc._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'teaching_assignment.deleted', entityType: 'TeachingAssignment', entityId: doc._id, metadata: { sectionId: doc.sectionId, subjectId: doc.subjectId, teacherId: doc.teacherId } });
}

/* ----------------------------- teacher scope ----------------------------- */

/**
 * What a teacher (membership) is responsible for in a session. Used by attendance, homework
 * and marks entry to restrict teachers to their own sections/subjects.
 */
export async function getTeacherScope(schoolId, membershipId, sessionId) {
  const [classTeacherOf, assignments] = await Promise.all([
    Section.find({ schoolId, sessionId, classTeacherId: membershipId, status: 'active' }).select('_id').lean(),
    TeachingAssignment.find({ schoolId, sessionId, teacherId: membershipId }).select('sectionId subjectId').lean(),
  ]);
  return {
    classTeacherSectionIds: classTeacherOf.map((s) => String(s._id)),
    subjectAssignments: assignments.map((a) => ({ sectionId: String(a.sectionId), subjectId: String(a.subjectId) })),
    sectionIds: uniqIds([...classTeacherOf.map((s) => s._id), ...assignments.map((a) => a.sectionId)]),
  };
}

export function myAssignments(tenant, { sessionId }) {
  return teacherWorkload(tenant, tenant.membershipId, sessionId);
}

/** A staff member's class-teacher sections and subject assignments in a session (current by default). */
export async function teacherWorkload(tenant, membershipId, sessionId) {
  const session = await resolveSession(tenant.schoolId, sessionId);
  const schoolId = tenant.schoolId;
  const [classTeacherSections, assignments] = await Promise.all([
    Section.find({ schoolId, sessionId: session._id, classTeacherId: membershipId }).lean(),
    TeachingAssignment.find({ schoolId, sessionId: session._id, teacherId: membershipId }).lean(),
  ]);
  return {
    session: { id: session._id, name: session.name },
    classTeacherOf: await decorateSections(schoolId, classTeacherSections),
    subjects: await decorateAssignments(tenant, assignments),
  };
}

/* ------------------------------- structure ------------------------------- */

/** Classes with their sections and subject counts for a session: feeds selectors and setup screens. */
export async function academicStructure(tenant, { sessionId, campusId }) {
  const schoolId = tenant.schoolId;
  const session = await resolveSession(schoolId, sessionId);
  const sectionFilter = { schoolId, sessionId: session._id, ...campusFilter(tenant) };
  if (campusId) {
    if (sectionFilter.campusId && !tenant.campusIds.some((c) => String(c) === String(campusId))) {
      throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
    }
    sectionFilter.campusId = campusId;
  }
  const [classes, sections, subjectCounts] = await Promise.all([
    SchoolClass.find({ schoolId, status: 'active' }).sort('order name').lean(),
    Section.find(sectionFilter).sort('name').lean(),
    ClassSubject.aggregate([{ $match: { schoolId: session.schoolId, sessionId: session._id } }, { $group: { _id: '$classId', n: { $sum: 1 } } }]),
  ]);
  const decorated = await decorateSections(schoolId, sections);
  const counts = new Map(subjectCounts.map((c) => [String(c._id), c.n]));
  return {
    session: { id: session._id, name: session.name, status: session.status, isCurrent: session.isCurrent },
    classes: classes.map((c) => ({
      id: c._id,
      name: c.name,
      code: c.code,
      order: c.order,
      subjectCount: counts.get(String(c._id)) || 0,
      sections: decorated
        .filter((s) => String(s.classId) === String(c._id))
        .map((s) => ({ id: s._id, name: s.name, campus: s.campus, classTeacher: s.classTeacher, capacity: s.capacity, status: s.status })),
    })),
  };
}
