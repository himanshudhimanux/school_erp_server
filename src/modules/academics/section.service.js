import mongoose from 'mongoose';
import { Section, TeachingAssignment, SchoolClass } from './academics.models.js';
import { Campus } from '../campuses/campus.model.js';
import { resolveSession, getSessionOr404, assertSessionOpen, getClassOr404, teacherMap, nameMap, idStr } from './academics.common.js';
import { assertAssignableStaff } from '../memberships/membership.service.js';
import { assertCampusAccess, isCampusRestricted } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { assertDeletable } from '../../utils/dependencyGuards.js';
import { recordAudit } from '../audit/audit.service.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Adds class, campus and class-teacher details to section rows. */
export async function decorateSections(schoolId, sections) {
  const [classes, campuses, teachers] = await Promise.all([
    nameMap(SchoolClass, schoolId, sections.map((s) => s.classId), 'name code order'),
    nameMap(Campus, schoolId, sections.map((s) => s.campusId), 'name code'),
    teacherMap(schoolId, sections.map((s) => s.classTeacherId)),
  ]);
  return sections.map((s) => {
    const c = classes.get(idStr(s.classId));
    const cp = campuses.get(idStr(s.campusId));
    return {
      ...s,
      class: c ? { id: c._id, name: c.name, code: c.code, order: c.order } : null,
      campus: cp ? { id: cp._id, name: cp.name, code: cp.code } : null,
      classTeacher: (s.classTeacherId && teachers.get(idStr(s.classTeacherId))) || null,
      displayName: c ? `${c.name} - ${s.name}` : s.name,
    };
  });
}

/** Sections of a session (current by default), ordered by class order then name, campus-scoped. */
export async function listSections(tenant, { sessionId, classId, campusId, status, page, limit }) {
  const session = await resolveSession(tenant.schoolId, sessionId);
  const match = { schoolId: oid(tenant.schoolId), sessionId: session._id };
  if (classId) match.classId = oid(classId);
  if (status) match.status = status;
  if (campusId) {
    assertCampusAccess(tenant, campusId);
    match.campusId = oid(campusId);
  } else if (isCampusRestricted(tenant)) {
    match.campusId = { $in: tenant.campusIds.map(oid) };
  }

  const [res] = await Section.aggregate([
    { $match: match },
    { $lookup: { from: SchoolClass.collection.name, localField: 'classId', foreignField: '_id', as: 'cls' } },
    { $addFields: { classOrder: { $ifNull: [{ $first: '$cls.order' }, 9999] } } },
    { $project: { cls: 0 } },
    {
      $facet: {
        items: [{ $sort: { classOrder: 1, name: 1, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'n' }],
      },
    },
  ]);
  const total = res.total[0]?.n ?? 0;
  return {
    items: await decorateSections(tenant.schoolId, res.items),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), sessionId: session._id },
  };
}

export async function getSectionDoc(tenant, sectionId) {
  const section = await Section.findOne({ _id: sectionId, schoolId: tenant.schoolId });
  if (!section) throw ApiError.notFound('Section not found');
  assertCampusAccess(tenant, section.campusId);
  return section;
}

export async function getSection(tenant, sectionId) {
  const section = await getSectionDoc(tenant, sectionId);
  const [decorated] = await decorateSections(tenant.schoolId, [section.toObject()]);
  return decorated;
}

async function assertCampusUsable(tenant, campusId) {
  assertCampusAccess(tenant, campusId);
  const campus = await Campus.findOne({ _id: campusId, schoolId: tenant.schoolId });
  if (!campus) throw ApiError.badRequest('Campus does not belong to this school', { code: 'INVALID_CAMPUS' });
  if (campus.status !== 'active') throw ApiError.badRequest('Campus is inactive', { code: 'CAMPUS_INACTIVE' });
  return campus;
}

export async function createSection(tenant, data, ctx) {
  const session = await getSessionOr404(tenant.schoolId, data.sessionId);
  assertSessionOpen(session);
  await getClassOr404(tenant.schoolId, data.classId, { requireActive: true });
  await assertCampusUsable(tenant, data.campusId);
  if (data.classTeacherId) await assertAssignableStaff(tenant.schoolId, data.classTeacherId, { campusId: data.campusId });

  const section = await Section.create({ ...data, schoolId: tenant.schoolId, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'section.created', entityType: 'Section', entityId: section._id, metadata: { sessionId: section.sessionId, classId: section.classId, name: section.name } });
  return getSection(tenant, section._id);
}

export async function updateSection(tenant, sectionId, data, ctx) {
  const section = await getSectionDoc(tenant, sectionId);
  assertSessionOpen(await getSessionOr404(tenant.schoolId, section.sessionId));
  if (data.classTeacherId) await assertAssignableStaff(tenant.schoolId, data.classTeacherId, { campusId: section.campusId });

  const before = { name: section.name, classTeacherId: idStr(section.classTeacherId), status: section.status, capacity: section.capacity };
  section.set({ ...data, updatedBy: ctx.actorId });
  await section.save();
  await recordAudit({ ...ctx, action: 'section.updated', entityType: 'Section', entityId: section._id, metadata: { before, changed: Object.keys(data) } });
  return getSection(tenant, section._id);
}

export async function deleteSection(tenant, sectionId, ctx) {
  const section = await getSectionDoc(tenant, sectionId);
  assertSessionOpen(await getSessionOr404(tenant.schoolId, section.sessionId));
  // Students (Phase 4), attendance, timetable etc. register guards for 'section'.
  await assertDeletable('section', tenant.schoolId, section._id);
  const { deletedCount } = await TeachingAssignment.deleteMany({ schoolId: tenant.schoolId, sectionId: section._id });
  await Section.deleteOne({ _id: section._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'section.deleted', entityType: 'Section', entityId: section._id, metadata: { name: section.name, classId: section.classId, assignmentsRemoved: deletedCount } });
}
