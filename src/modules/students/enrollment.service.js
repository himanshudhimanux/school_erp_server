import { Student, Enrollment, fullName } from './student.model.js';
import { Section, SchoolClass, AcademicSession } from '../academics/academics.models.js';
import { getSessionOr404, assertSessionOpen, nameMap, idStr } from '../academics/academics.common.js';
import { studentAccess, getStudentDoc, assertSectionAccess } from './access.js';
import { ApiError } from '../../utils/ApiError.js';
import { assertDeletable } from '../../utils/dependencyGuards.js';
import { recordAudit } from '../audit/audit.service.js';

/* ------------------------------ helpers ------------------------------ */

/** A section that can receive students: exists, caller can reach its campus, active, open session. */
export async function getEnrollableSection(tenant, sectionId, access) {
  const section = await Section.findOne({ _id: sectionId, schoolId: tenant.schoolId });
  if (!section) throw ApiError.notFound('Section not found');
  if (access?.campusIds && !access.campusIds.includes(String(section.campusId))) {
    throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
  }
  if (section.status !== 'active') throw ApiError.badRequest('This section is inactive', { code: 'SECTION_INACTIVE' });
  const session = await getSessionOr404(tenant.schoolId, section.sessionId);
  assertSessionOpen(session);
  return { section, session };
}

/** Throws SECTION_FULL when `adding` more active students would exceed the section capacity. */
export async function assertCapacity(schoolId, section, adding = 1) {
  if (!section.capacity) return;
  const used = await Enrollment.countDocuments({ schoolId, sectionId: section._id, status: 'active' });
  if (used + adding > section.capacity) {
    throw ApiError.conflict(`Section is full (${used}/${section.capacity})`, { code: 'SECTION_FULL', details: { capacity: section.capacity, enrolled: used } });
  }
}

async function assertRollNoFree(schoolId, sectionId, rollNo, exceptId) {
  if (!rollNo) return;
  const taken = await Enrollment.exists({ schoolId, sectionId, rollNo, status: 'active', ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (taken) throw ApiError.conflict(`Roll number ${rollNo} is already used in this section`, { code: 'ROLL_NO_TAKEN' });
}

/**
 * Validates placing a (possibly not yet created) student in a section.
 * `student` may be null during student creation; then only section checks apply.
 */
export async function prepareEnrollment(tenant, student, { sectionId, rollNo }, access) {
  const { section, session } = await getEnrollableSection(tenant, sectionId, access);
  if (student) {
    if (student.status !== 'active') throw ApiError.badRequest('Only active students can be enrolled', { code: 'STUDENT_INACTIVE' });
    const existing = await Enrollment.findOne({ schoolId: tenant.schoolId, studentId: student._id, sessionId: session._id }).lean();
    if (existing) throw ApiError.conflict(`Student is already enrolled in session ${session.name}`, { code: 'ALREADY_ENROLLED', details: { enrollmentId: existing._id } });
  }
  await assertCapacity(tenant.schoolId, section);
  await assertRollNoFree(tenant.schoolId, section._id, rollNo);
  return { section, session };
}

/** Writes the enrollment; a current-session enrollment moves the student's home campus. */
export async function writeEnrollment(tenant, student, { section, session }, { rollNo }, ctx) {
  const enrollment = await Enrollment.create({
    schoolId: tenant.schoolId,
    studentId: student._id,
    sessionId: session._id,
    classId: section.classId,
    sectionId: section._id,
    campusId: section.campusId,
    rollNo: rollNo ?? null,
    createdBy: ctx.actorId,
  });
  if (session.isCurrent && String(student.campusId) !== String(section.campusId)) {
    await Student.updateOne({ _id: student._id, schoolId: tenant.schoolId }, { campusId: section.campusId });
  }
  return enrollment;
}

/** Enrollment rows with class/section/session names. */
export async function decorateEnrollments(schoolId, rows) {
  const [sessions, classes, sections] = await Promise.all([
    nameMap(AcademicSession, schoolId, rows.map((r) => r.sessionId), 'name isCurrent status startDate'),
    nameMap(SchoolClass, schoolId, rows.map((r) => r.classId), 'name code order'),
    nameMap(Section, schoolId, rows.map((r) => r.sectionId), 'name'),
  ]);
  return rows.map((r) => {
    const s = sessions.get(idStr(r.sessionId));
    const c = classes.get(idStr(r.classId));
    const sec = sections.get(idStr(r.sectionId));
    return {
      _id: r._id,
      studentId: r.studentId,
      sessionId: r.sessionId,
      classId: r.classId,
      sectionId: r.sectionId,
      campusId: r.campusId,
      rollNo: r.rollNo,
      status: r.status,
      enrolledOn: r.enrolledOn,
      endedOn: r.endedOn,
      session: s ? { id: s._id, name: s.name, isCurrent: s.isCurrent, status: s.status } : null,
      class: c ? { id: c._id, name: c.name, code: c.code } : null,
      section: sec ? { id: sec._id, name: sec.name } : null,
      displayName: `${c?.name ?? ''} - ${sec?.name ?? ''}`,
    };
  });
}

async function getEnrollmentDoc(tenant, enrollmentId) {
  const enrollment = await Enrollment.findOne({ _id: enrollmentId, schoolId: tenant.schoolId });
  if (!enrollment) throw ApiError.notFound('Enrollment not found');
  await getStudentDoc(tenant, enrollment.studentId); // access check
  return enrollment;
}

/* ------------------------------ operations ------------------------------ */

export async function enrollStudent(tenant, studentId, data, ctx) {
  const access = await studentAccess(tenant);
  const student = await getStudentDoc(tenant, studentId, access);
  const target = await prepareEnrollment(tenant, student, data, access);
  const enrollment = await writeEnrollment(tenant, student, target, data, ctx);
  await recordAudit({ ...ctx, action: 'student.enrolled', entityType: 'Student', entityId: student._id, metadata: { enrollmentId: enrollment._id, sectionId: enrollment.sectionId, sessionId: enrollment.sessionId } });
  const [row] = await decorateEnrollments(tenant.schoolId, [enrollment.toObject()]);
  return row;
}

/**
 * Changes section (within the same session), roll number or status of an enrollment.
 * Moving to another section clears the roll number unless a new one is given.
 */
export async function updateEnrollment(tenant, enrollmentId, data, ctx) {
  const access = await studentAccess(tenant);
  const enrollment = await getEnrollmentDoc(tenant, enrollmentId);
  const session = await getSessionOr404(tenant.schoolId, enrollment.sessionId);
  assertSessionOpen(session);
  const student = await Student.findOne({ _id: enrollment.studentId, schoolId: tenant.schoolId });
  const before = { sectionId: idStr(enrollment.sectionId), rollNo: enrollment.rollNo, status: enrollment.status };

  const nextStatus = data.status ?? enrollment.status;
  const becomingActive = nextStatus === 'active' && enrollment.status !== 'active';
  if (becomingActive && student.status !== 'active') throw ApiError.badRequest('Only active students can be enrolled', { code: 'STUDENT_INACTIVE' });

  if (data.sectionId && String(data.sectionId) !== String(enrollment.sectionId)) {
    const { section } = await getEnrollableSection(tenant, data.sectionId, access);
    if (String(section.sessionId) !== String(enrollment.sessionId)) {
      throw ApiError.badRequest('The new section must be in the same academic session. Use promotion to move to another session.', { code: 'SESSION_MISMATCH' });
    }
    if (nextStatus === 'active') await assertCapacity(tenant.schoolId, section);
    enrollment.set({ sectionId: section._id, classId: section.classId, campusId: section.campusId, rollNo: data.rollNo ?? null });
    if (session.isCurrent && String(student.campusId) !== String(section.campusId)) {
      student.campusId = section.campusId;
      await student.save();
    }
  } else if (becomingActive) {
    await assertCapacity(tenant.schoolId, await Section.findOne({ _id: enrollment.sectionId, schoolId: tenant.schoolId }));
  }

  if (data.rollNo !== undefined && !data.sectionId) enrollment.rollNo = data.rollNo;
  if (nextStatus === 'active') await assertRollNoFree(tenant.schoolId, enrollment.sectionId, enrollment.rollNo, enrollment._id);
  if (data.status) {
    enrollment.status = data.status;
    enrollment.endedOn = data.status === 'active' ? null : enrollment.endedOn || new Date();
  }
  enrollment.updatedBy = ctx.actorId;
  await enrollment.save();
  await recordAudit({ ...ctx, action: 'enrollment.updated', entityType: 'Enrollment', entityId: enrollment._id, metadata: { studentId: enrollment.studentId, before, changed: Object.keys(data) } });
  const [row] = await decorateEnrollments(tenant.schoolId, [enrollment.toObject()]);
  return row;
}

export async function deleteEnrollment(tenant, enrollmentId, ctx) {
  const enrollment = await getEnrollmentDoc(tenant, enrollmentId);
  assertSessionOpen(await getSessionOr404(tenant.schoolId, enrollment.sessionId));
  // Attendance, marks and fees (later phases) block deleting enrollments they reference.
  await assertDeletable('enrollment', tenant.schoolId, enrollment._id);
  await Enrollment.deleteOne({ _id: enrollment._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'enrollment.deleted', entityType: 'Enrollment', entityId: enrollment._id, metadata: { studentId: enrollment.studentId, sectionId: enrollment.sectionId, sessionId: enrollment.sessionId } });
}

/** Active students of a section ordered by roll number then name (attendance sheets, rosters). */
export async function sectionRoster(tenant, sectionId) {
  const section = await Section.findOne({ _id: sectionId, schoolId: tenant.schoolId }).lean();
  if (!section) throw ApiError.notFound('Section not found');
  const access = await studentAccess(tenant, { sessionId: section.sessionId });
  assertSectionAccess(access, section);
  const rows = await Enrollment.find({ schoolId: tenant.schoolId, sectionId: section._id, status: 'active' }).lean();
  const students = await Student.find({ schoolId: tenant.schoolId, _id: { $in: rows.map((r) => r.studentId) } })
    .select('admissionNo firstName lastName gender status photoUrl')
    .lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const items = rows
    .filter((r) => byId.has(String(r.studentId)))
    .map((r) => {
      const s = byId.get(String(r.studentId));
      return { enrollmentId: r._id, studentId: s._id, rollNo: r.rollNo, admissionNo: s.admissionNo, name: fullName(s), gender: s.gender, status: s.status, photoUrl: s.photoUrl ?? null };
    })
    .sort((a, b) => (a.rollNo ?? Infinity) - (b.rollNo ?? Infinity) || a.name.localeCompare(b.name));
  const cls = await SchoolClass.findOne({ _id: section.classId, schoolId: tenant.schoolId }).setOptions({ withDeleted: true }).select('name').lean();
  return {
    section: { id: section._id, name: section.name, displayName: `${cls?.name ?? ''} - ${section.name}`, sessionId: section.sessionId, campusId: section.campusId, capacity: section.capacity },
    count: items.length,
    items,
  };
}

/** Numbers the active students of a section 1..n by name or admission number. */
export async function assignRollNumbers(tenant, { sectionId, orderBy }, ctx) {
  const { section } = await getEnrollableSection(tenant, sectionId, await studentAccess(tenant));
  const rows = await Enrollment.find({ schoolId: tenant.schoolId, sectionId: section._id, status: 'active' }).lean();
  const students = await Student.find({ schoolId: tenant.schoolId, _id: { $in: rows.map((r) => r.studentId) } }).select('admissionNo firstName lastName').lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const key = (r) => {
    const s = byId.get(String(r.studentId));
    return orderBy === 'admissionNo' ? s?.admissionNo ?? '' : `${s?.firstName ?? ''} ${s?.lastName ?? ''}`.toLowerCase();
  };
  rows.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
  // Clear first so the unique (section, rollNo) index never sees a transient duplicate.
  await Enrollment.updateMany({ schoolId: tenant.schoolId, sectionId: section._id, status: 'active' }, { rollNo: null });
  if (rows.length) {
    await Enrollment.bulkWrite(rows.map((r, i) => ({ updateOne: { filter: { _id: r._id, schoolId: tenant.schoolId }, update: { rollNo: i + 1, updatedBy: ctx.actorId } } })));
  }
  await recordAudit({ ...ctx, action: 'section.roll_numbers_assigned', entityType: 'Section', entityId: section._id, metadata: { orderBy, count: rows.length } });
  return sectionRoster(tenant, section._id);
}

/**
 * Year-end promotion: moves selected students from a section to a section of a later session.
 * Their old enrollment becomes `promoted`. Students already enrolled in the target session or
 * not active in the source section are skipped and reported.
 */
export async function promoteStudents(tenant, { fromSectionId, toSectionId, studentIds }, ctx) {
  const access = await studentAccess(tenant);
  const from = await Section.findOne({ _id: fromSectionId, schoolId: tenant.schoolId });
  if (!from) throw ApiError.notFound('Source section not found');
  assertSectionAccess({ ...access, sectionIds: null }, from);
  const { section: to, session: toSession } = await getEnrollableSection(tenant, toSectionId, access);
  const fromSession = await getSessionOr404(tenant.schoolId, from.sessionId);
  if (toSession.startDate <= fromSession.startDate) {
    throw ApiError.badRequest('Students can only be promoted to a later academic session', { code: 'INVALID_PROMOTION' });
  }

  const unique = [...new Set(studentIds.map(String))];
  const [sourceRows, alreadyThere, students] = await Promise.all([
    Enrollment.find({ schoolId: tenant.schoolId, sectionId: from._id, studentId: { $in: unique }, status: { $in: ['active', 'completed'] } }).lean(),
    Enrollment.find({ schoolId: tenant.schoolId, sessionId: toSession._id, studentId: { $in: unique } }).select('studentId').lean(),
    Student.find({ schoolId: tenant.schoolId, _id: { $in: unique } }).select('status campusId').lean(),
  ]);
  const source = new Map(sourceRows.map((r) => [String(r.studentId), r]));
  const enrolledAlready = new Set(alreadyThere.map((r) => String(r.studentId)));
  const studentById = new Map(students.map((s) => [String(s._id), s]));

  const skipped = [];
  const toMove = [];
  for (const id of unique) {
    if (!source.has(id)) skipped.push({ studentId: id, reason: 'NOT_IN_SOURCE_SECTION' });
    else if (studentById.get(id)?.status !== 'active') skipped.push({ studentId: id, reason: 'STUDENT_INACTIVE' });
    else if (enrolledAlready.has(id)) skipped.push({ studentId: id, reason: 'ALREADY_ENROLLED' });
    else toMove.push(id);
  }
  if (toMove.length) await assertCapacity(tenant.schoolId, to, toMove.length);

  const now = new Date();
  if (toMove.length) {
    await Enrollment.insertMany(
      toMove.map((id) => ({ schoolId: tenant.schoolId, studentId: id, sessionId: toSession._id, classId: to.classId, sectionId: to._id, campusId: to.campusId, createdBy: ctx.actorId })),
    );
    await Enrollment.updateMany({ schoolId: tenant.schoolId, _id: { $in: toMove.map((id) => source.get(id)._id) } }, { status: 'promoted', endedOn: now, updatedBy: ctx.actorId });
    if (toSession.isCurrent) {
      await Student.updateMany({ schoolId: tenant.schoolId, _id: { $in: toMove }, campusId: { $ne: to.campusId } }, { campusId: to.campusId });
    }
  }
  await recordAudit({ ...ctx, action: 'students.promoted', entityType: 'Section', entityId: to._id, metadata: { fromSectionId: from._id, toSectionId: to._id, promoted: toMove.length, skipped: skipped.length } });
  return { promoted: toMove.length, skipped };
}
