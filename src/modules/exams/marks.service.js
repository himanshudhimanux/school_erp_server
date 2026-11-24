import mongoose from 'mongoose';
import { Exam, ExamPaper, MarkEntry, ExamRemark, ExamResult } from './exam.models.js';
import { computeResult, assignRanks, combineResults, round2 } from './grading.js';
import { getExamDoc, assertDraft, bandsForExam, listPapers, defaultScale } from './exam.service.js';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { Section, SchoolClass, TeachingAssignment, AcademicSession } from '../academics/academics.models.js';
import { School } from '../schools/school.model.js';
import { AttendanceRecord } from '../attendance/attendance.models.js';
import { getSessionOr404, nameMap, idStr } from '../academics/academics.common.js';
import { studentAccess, getStudentDoc, assertSectionAccess } from '../students/access.js';
import { queueNotifications, buildDeliveries, alertChannels } from '../notifications/notification.service.js';
import { guardianRecipients } from '../notifications/recipients.js';
import { templateRenderer } from '../notifications/templates.js';
import { withTransaction } from '../../utils/transaction.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const canManage = (tenant) => tenant.permissions.has('exams.update');

/* ------------------------------ access ------------------------------ */

/** A section taking part in the exam that the caller may see (teachers: their own sections). */
async function loadSection(tenant, exam, sectionId) {
  const section = await Section.findOne({ _id: sectionId, schoolId: tenant.schoolId }).lean();
  if (!section) throw ApiError.notFound('Section not found');
  if (String(section.sessionId) !== String(exam.sessionId) || !exam.classIds.some((c) => String(c) === String(section.classId))) {
    throw ApiError.badRequest('This section is not part of the exam', { code: 'SECTION_NOT_IN_EXAM' });
  }
  assertSectionAccess(await studentAccess(tenant, { sessionId: exam.sessionId }), section);
  const cls = await SchoolClass.findOne({ _id: section.classId, schoolId: tenant.schoolId }).setOptions({ withDeleted: true }).select('name').lean();
  return { ...section, displayName: `${cls?.name ?? ''} - ${section.name}` };
}

async function getPaper(schoolId, exam, paperId) {
  const paper = await ExamPaper.findOne({ _id: paperId, schoolId, examId: exam._id }).lean();
  if (!paper) throw ApiError.notFound('Paper not found');
  return paper;
}

/**
 * Who may enter marks: managers (exams.update) until results are published; teachers
 * (exams.marks) only for subjects they teach in the section, and only while marks are unlocked.
 */
async function editState(tenant, exam, section, paper) {
  if (exam.status === 'published') return { canEdit: false, reason: 'EXAM_PUBLISHED' };
  if (canManage(tenant)) return { canEdit: true, reason: null };
  if (!tenant.permissions.has('exams.marks')) return { canEdit: false, reason: 'PERMISSION_DENIED' };
  if (exam.marksLocked) return { canEdit: false, reason: 'MARKS_LOCKED' };
  const teaches = await TeachingAssignment.exists({ schoolId: tenant.schoolId, sectionId: section._id, subjectId: paper.subjectId, teacherId: tenant.membershipId });
  return teaches ? { canEdit: true, reason: null } : { canEdit: false, reason: 'NOT_SUBJECT_TEACHER' };
}

/* ------------------------------ marks entry ------------------------------ */

async function roster(schoolId, sectionId, extraStudentIds = []) {
  const enrollments = await Enrollment.find({ schoolId, sectionId, status: 'active' }).select('studentId rollNo').lean();
  const rollBy = new Map(enrollments.map((e) => [String(e.studentId), e.rollNo]));
  const ids = [...new Set([...rollBy.keys(), ...extraStudentIds.map(String)])];
  const students = await Student.find({ schoolId, _id: { $in: ids } }).select('admissionNo firstName lastName').lean();
  return students
    .map((s) => ({ studentId: s._id, rollNo: rollBy.get(String(s._id)) ?? null, admissionNo: s.admissionNo, name: fullName(s), inSection: rollBy.has(String(s._id)) }))
    .sort((a, b) => (a.rollNo ?? Infinity) - (b.rollNo ?? Infinity) || a.name.localeCompare(b.name));
}

export async function getPaperMarks(tenant, examId, paperId, sectionId) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  const paper = await getPaper(schoolId, exam, paperId);
  const section = await loadSection(tenant, exam, sectionId);
  if (String(section.classId) !== String(paper.classId)) throw ApiError.badRequest('This paper belongs to another class', { code: 'SECTION_MISMATCH' });
  const entries = await MarkEntry.find({ schoolId, paperId: paper._id, sectionId: section._id }).lean();
  const byStudent = new Map(entries.map((e) => [String(e.studentId), e]));
  const students = (await roster(schoolId, section._id, entries.map((e) => e.studentId))).map((s) => {
    const e = byStudent.get(String(s.studentId));
    return { ...s, marks: e?.marks ?? null, status: e?.status ?? null, remarks: e?.remarks ?? null };
  });
  const [subject] = await listPapers(schoolId, exam._id, paper.classId).then((ps) => ps.filter((p) => String(p._id) === String(paper._id)));
  const edit = await editState(tenant, exam, section, paper);
  return {
    exam: { id: exam._id, name: exam.name, status: exam.status, marksLocked: exam.marksLocked },
    paper: { id: paper._id, subject: subject?.subject ?? null, date: paper.date, maxMarks: paper.maxMarks, passMarks: paper.passMarks },
    section: { id: section._id, displayName: section.displayName },
    canEdit: edit.canEdit,
    lockedReason: edit.reason,
    entered: students.filter((s) => s.status).length,
    total: students.filter((s) => s.inSection).length,
    students,
  };
}

/** Saves marks for some or all students of a section (safe to re-submit). */
export async function saveMarks(tenant, examId, paperId, { sectionId, entries }, ctx) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  const paper = await getPaper(schoolId, exam, paperId);
  const section = await loadSection(tenant, exam, sectionId);
  if (String(section.classId) !== String(paper.classId)) throw ApiError.badRequest('This paper belongs to another class', { code: 'SECTION_MISMATCH' });
  const edit = await editState(tenant, exam, section, paper);
  if (!edit.canEdit) {
    const messages = { EXAM_PUBLISHED: 'Results are published. Unpublish them to change marks.', MARKS_LOCKED: 'Marks entry is locked for this exam', NOT_SUBJECT_TEACHER: 'You can only enter marks for subjects you teach in this section' };
    throw ApiError.forbidden(messages[edit.reason] || undefined, { code: edit.reason });
  }

  const active = new Set((await Enrollment.distinct('studentId', { schoolId, sectionId: section._id, status: 'active' })).map(String));
  const outsiders = entries.filter((e) => !active.has(String(e.studentId))).map((e) => e.studentId);
  if (outsiders.length) throw ApiError.badRequest('Some students are not active in this section', { code: 'STUDENT_NOT_IN_SECTION', details: { studentIds: outsiders } });
  const invalid = [];
  for (const e of entries) {
    if (e.status === 'present' && (e.marks === null || e.marks === undefined)) invalid.push({ studentId: e.studentId, message: 'Marks are required for present students' });
    else if (e.status === 'present' && e.marks > paper.maxMarks) invalid.push({ studentId: e.studentId, message: `Marks cannot exceed ${paper.maxMarks}` });
    else if (e.status !== 'present' && e.marks !== null && e.marks !== undefined) invalid.push({ studentId: e.studentId, message: 'Leave marks empty for absent or exempt students' });
  }
  if (invalid.length) throw ApiError.validation(invalid.map((i) => ({ field: `body.entries.${i.studentId}`, message: i.message })));

  const before = await MarkEntry.find({ schoolId, paperId: paper._id, studentId: { $in: entries.map((e) => e.studentId) } }).select('studentId marks status').lean();
  await MarkEntry.bulkWrite(
    entries.map((e) => ({
      updateOne: {
        filter: { schoolId, paperId: paper._id, studentId: e.studentId },
        update: { $set: { examId: exam._id, sectionId: section._id, classId: section.classId, marks: e.status === 'present' ? round2(e.marks) : null, status: e.status, remarks: e.remarks, enteredBy: ctx.actorId } },
        upsert: true,
      },
    })),
  );
  const prev = new Map(before.map((b) => [String(b.studentId), b]));
  const changed = entries.filter((e) => {
    const p = prev.get(String(e.studentId));
    return p && (p.marks !== (e.status === 'present' ? round2(e.marks) : null) || p.status !== e.status);
  });
  await recordAudit({
    ...ctx,
    action: 'exam.marks_saved',
    entityType: 'ExamPaper',
    entityId: paper._id,
    metadata: { examId: exam._id, sectionId: section._id, saved: entries.length, corrections: changed.slice(0, 50).map((c) => ({ studentId: c.studentId, from: prev.get(String(c.studentId)), to: { marks: c.marks ?? null, status: c.status } })) },
  });
  return getPaperMarks(tenant, exam._id, paper._id, section._id);
}

/** Marks entry progress per section and paper. Teachers see their own sections. */
export async function examProgress(tenant, examId) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  const access = await studentAccess(tenant, { sessionId: exam.sessionId });
  const filter = { schoolId, sessionId: exam.sessionId, classId: { $in: exam.classIds }, status: 'active' };
  if (access.campusIds) filter.campusId = { $in: access.campusIds };
  if (access.sectionIds) filter._id = { $in: access.sectionIds };
  const [sections, papers] = await Promise.all([Section.find(filter).lean(), listPapers(schoolId, exam._id)]);
  const sectionIds = sections.map((s) => s._id);
  const [enrolled, entered, classes] = await Promise.all([
    Enrollment.aggregate([{ $match: { schoolId: oid(schoolId), sectionId: { $in: sectionIds }, status: 'active' } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]),
    MarkEntry.aggregate([{ $match: { schoolId: oid(schoolId), examId: exam._id, sectionId: { $in: sectionIds } } }, { $group: { _id: { section: '$sectionId', paper: '$paperId' }, n: { $sum: 1 } } }]),
    nameMap(SchoolClass, schoolId, sections.map((s) => s.classId), 'name order'),
  ]);
  const enrolledBy = new Map(enrolled.map((e) => [String(e._id), e.n]));
  const enteredBy = new Map(entered.map((e) => [`${e._id.section}:${e._id.paper}`, e.n]));
  const rows = sections
    .map((s) => {
      const total = enrolledBy.get(String(s._id)) || 0;
      const sp = papers.filter((p) => String(p.classId) === String(s.classId)).map((p) => ({ paperId: p._id, subject: p.subject, date: p.date, entered: Math.min(enteredBy.get(`${s._id}:${p._id}`) || 0, total), total }));
      const c = classes.get(idStr(s.classId));
      return { sectionId: s._id, displayName: `${c?.name ?? ''} - ${s.name}`, order: c?.order ?? 9999, students: total, papers: sp, complete: sp.length > 0 && sp.every((p) => p.entered >= p.total) };
    })
    .sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
  return { exam: { id: exam._id, name: exam.name, status: exam.status, marksLocked: exam.marksLocked }, sections: rows, complete: rows.length > 0 && rows.every((r) => r.complete) };
}

export async function setMarksLock(tenant, examId, locked, ctx) {
  const exam = await getExamDoc(tenant.schoolId, examId);
  assertDraft(exam);
  exam.marksLocked = locked;
  exam.updatedBy = ctx.actorId;
  await exam.save();
  await recordAudit({ ...ctx, action: locked ? 'exam.marks_locked' : 'exam.marks_unlocked', entityType: 'Exam', entityId: exam._id, metadata: {} });
  return { id: exam._id, marksLocked: exam.marksLocked };
}

/* ------------------------------ results ------------------------------ */

/**
 * Live results for students actively enrolled in the exam's classes (optionally some classes),
 * with section and class ranks. Used for previews and at publication.
 */
async function computeResults(schoolId, exam, { classIds } = {}) {
  const classes = (classIds || exam.classIds).map(String);
  const [papers, enrollments, bands] = await Promise.all([
    listPapers(schoolId, exam._id),
    Enrollment.find({ schoolId, sessionId: exam.sessionId, classId: { $in: classes }, status: 'active' }).select('studentId sectionId classId').lean(),
    bandsForExam(schoolId, exam),
  ]);
  const studentIds = enrollments.map((e) => e.studentId);
  const [marks, remarks, students] = await Promise.all([
    MarkEntry.find({ schoolId, examId: exam._id, studentId: { $in: studentIds } }).lean(),
    ExamRemark.find({ schoolId, examId: exam._id, studentId: { $in: studentIds } }).lean(),
    Student.find({ schoolId, _id: { $in: studentIds } }).select('admissionNo firstName lastName').lean(),
  ]);
  const marksBy = new Map();
  for (const m of marks) {
    if (!marksBy.has(String(m.studentId))) marksBy.set(String(m.studentId), new Map());
    marksBy.get(String(m.studentId)).set(String(m.paperId), m);
  }
  const remarkBy = new Map(remarks.map((r) => [String(r.studentId), r.remark]));
  const studentBy = new Map(students.map((s) => [String(s._id), s]));
  const results = enrollments.map((e) => {
    const classPapers = papers.filter((p) => String(p.classId) === String(e.classId));
    const r = computeResult(classPapers, marksBy.get(String(e.studentId)) || new Map(), bands);
    const s = studentBy.get(String(e.studentId));
    return { studentId: e.studentId, classId: e.classId, sectionId: e.sectionId, student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo } : null, ...r, remark: remarkBy.get(String(e.studentId)) ?? null };
  });
  const group = (key) => {
    const m = new Map();
    for (const r of results) m.set(String(r[key]), [...(m.get(String(r[key])) || []), r]);
    return [...m.values()];
  };
  for (const g of group('sectionId')) assignRanks(g, 'rankInSection');
  for (const g of group('classId')) assignRanks(g, 'rankInClass');
  return { results, papers, bands };
}

const resultSort = (a, b) => (a.rankInSection ?? Infinity) - (b.rankInSection ?? Infinity) || (a.student?.name ?? '').localeCompare(b.student?.name ?? '');

/** Results of one section: the published snapshot, or a live preview for staff while in draft. */
export async function sectionResults(tenant, examId, sectionId) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  const section = await loadSection(tenant, exam, sectionId);
  let rows;
  if (exam.status === 'published') {
    const snaps = await ExamResult.find({ schoolId, examId: exam._id, sectionId: section._id }).lean();
    const students = await nameMap(Student, schoolId, snaps.map((s) => s.studentId), 'firstName lastName admissionNo');
    rows = snaps.map((r) => {
      const s = students.get(idStr(r.studentId));
      return { ...r, student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo } : null };
    });
  } else {
    rows = (await computeResults(schoolId, exam, { classIds: [section.classId] })).results.filter((r) => String(r.sectionId) === String(section._id));
  }
  rows.sort(resultSort);
  const summary = { students: rows.length, pass: 0, fail: 0, incomplete: 0 };
  for (const r of rows) summary[r.result] += 1;
  const complete = rows.filter((r) => r.percentage !== null);
  summary.average = complete.length ? round2(complete.reduce((t, r) => t + r.percentage, 0) / complete.length) : null;
  return { exam: { id: exam._id, name: exam.name, status: exam.status, publishedAt: exam.publishedAt }, section: { id: section._id, displayName: section.displayName }, preview: exam.status !== 'published', summary, results: rows };
}

/** Class teacher (or a manager) records report card remarks while results are in draft. */
export async function saveRemarks(tenant, examId, { sectionId, entries }, ctx) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  assertDraft(exam);
  const section = await loadSection(tenant, exam, sectionId);
  if (!canManage(tenant) && String(section.classTeacherId) !== String(tenant.membershipId)) {
    throw ApiError.forbidden('Only the class teacher can write report card remarks', { code: 'NOT_CLASS_TEACHER' });
  }
  const active = new Set((await Enrollment.distinct('studentId', { schoolId, sectionId: section._id, status: 'active' })).map(String));
  const outsiders = entries.filter((e) => !active.has(String(e.studentId)));
  if (outsiders.length) throw ApiError.badRequest('Some students are not active in this section', { code: 'STUDENT_NOT_IN_SECTION' });
  const toDelete = entries.filter((e) => !e.remark).map((e) => e.studentId);
  if (toDelete.length) await ExamRemark.deleteMany({ schoolId, examId: exam._id, studentId: { $in: toDelete } });
  const toSave = entries.filter((e) => e.remark);
  if (toSave.length) {
    await ExamRemark.bulkWrite(toSave.map((e) => ({ updateOne: { filter: { schoolId, examId: exam._id, studentId: e.studentId }, update: { $set: { remark: e.remark, updatedBy: ctx.actorId } }, upsert: true } })));
  }
  await recordAudit({ ...ctx, action: 'exam.remarks_saved', entityType: 'Exam', entityId: exam._id, metadata: { sectionId: section._id, saved: toSave.length, cleared: toDelete.length } });
  return { saved: toSave.length, cleared: toDelete.length };
}

/**
 * Publishes results: computes every student's result, stores the snapshot, locks marks and
 * notifies families. Refused while marks are missing unless `allowIncomplete` is set.
 */
export async function publishResults(tenant, examId, { allowIncomplete = false }, ctx) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  assertDraft(exam);
  if (!(await ExamPaper.exists({ schoolId, examId: exam._id }))) throw ApiError.badRequest('Schedule the exam papers first', { code: 'NO_PAPERS' });
  const { results } = await computeResults(schoolId, exam);
  if (!results.length) throw ApiError.badRequest('No students are enrolled in the exam classes', { code: 'NO_STUDENTS' });
  const incomplete = results.filter((r) => r.result === 'incomplete');
  if (incomplete.length && !allowIncomplete) {
    throw ApiError.conflict(`Marks are missing for ${incomplete.length} student(s)`, {
      code: 'MARKS_INCOMPLETE',
      details: { incomplete: incomplete.length, students: incomplete.slice(0, 20).map((r) => ({ studentId: r.studentId, name: r.student?.name, missing: r.subjects.filter((s) => s.status === 'missing').map((s) => s.name) })) },
    });
  }

  const publishedAt = new Date();
  await withTransaction(async (session) => {
    await ExamResult.deleteMany({ schoolId, examId: exam._id }, { session });
    await ExamResult.insertMany(
      results.map((r) => ({ schoolId, examId: exam._id, sessionId: exam.sessionId, studentId: r.studentId, classId: r.classId, sectionId: r.sectionId, subjects: r.subjects, total: r.total, maxTotal: r.maxTotal, percentage: r.percentage, grade: r.grade, gradePoint: r.gradePoint, result: r.result, rankInSection: r.rankInSection, rankInClass: r.rankInClass, remark: r.remark, publishedAt })),
      { session },
    );
    await Exam.updateOne({ _id: exam._id, schoolId }, { status: 'published', marksLocked: true, publishedAt, publishedBy: ctx.actorId, updatedBy: ctx.actorId }, { session });
  });

  const notified = await notifyFamilies(schoolId, exam, results.map((r) => r.studentId));
  const summary = { students: results.length, pass: results.filter((r) => r.result === 'pass').length, fail: results.filter((r) => r.result === 'fail').length, incomplete: incomplete.length };
  await recordAudit({ ...ctx, action: 'exam.published', entityType: 'Exam', entityId: exam._id, metadata: { ...summary, notified } });
  return { ...summary, notificationsQueued: notified, publishedAt };
}

async function notifyFamilies(schoolId, exam, studentIds) {
  const [students, contacts, school, render, channels] = await Promise.all([
    Student.find({ schoolId, _id: { $in: studentIds } }).select('firstName lastName membershipId').lean(),
    guardianRecipients(schoolId, studentIds),
    School.findById(schoolId).select('name').lean(),
    templateRenderer(schoolId),
    alertChannels(schoolId),
  ]);
  const items = [];
  for (const s of students) {
    const { title, body } = render('exam.results', { exam: exam.name, student: fullName(s), school: school?.name ?? '' });
    const data = { studentId: s._id };
    const base = `exam.results:${exam._id}:${s._id}`;
    // Students with their own login get the in-app notice (and push); guardians get every alert channel.
    if (s.membershipId) items.push({ recipient: { membershipId: s.membershipId, name: fullName(s) }, type: 'exam.results', title, body, data, key: `${base}:student`, studentOnly: true });
    for (const recipient of contacts.get(String(s._id)) || []) items.push({ recipient, type: 'exam.results', title, body, data, key: `${base}:${recipient.guardianId}` });
  }
  const studentDocs = await buildDeliveries(schoolId, items.filter((i) => i.studentOnly), channels.filter((c) => c === 'in_app' || c === 'push'));
  const guardianDocs = await buildDeliveries(schoolId, items.filter((i) => !i.studentOnly), channels);
  return queueNotifications(schoolId, [...studentDocs, ...guardianDocs]);
}

export async function unpublishResults(tenant, examId, { reason }, ctx) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  if (exam.status !== 'published') throw ApiError.badRequest('Results are not published', { code: 'NOT_PUBLISHED' });
  await withTransaction(async (session) => {
    await ExamResult.deleteMany({ schoolId, examId: exam._id }, { session });
    await Exam.updateOne({ _id: exam._id, schoolId }, { status: 'draft', publishedAt: null, publishedBy: null, updatedBy: ctx.actorId }, { session });
  });
  await recordAudit({ ...ctx, action: 'exam.unpublished', entityType: 'Exam', entityId: exam._id, metadata: { reason } });
  return { id: exam._id, status: 'draft', marksLocked: exam.marksLocked };
}

/* ------------------------------ report cards ------------------------------ */

async function attendanceSummary(schoolId, studentId, sessionId) {
  const rows = await AttendanceRecord.aggregate([{ $match: { schoolId: oid(schoolId), studentId: oid(studentId), sessionId: oid(sessionId) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const c = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const total = rows.reduce((t, r) => t + r.n, 0);
  return { daysMarked: total, present: (c.present || 0) + (c.late || 0), absent: c.absent || 0, leave: c.leave || 0, percentage: total ? round2((((c.present || 0) + (c.late || 0)) / total) * 100) : null };
}

async function cardHeader(schoolId, student, sectionId, sessionId) {
  const [school, section, session] = await Promise.all([
    School.findById(schoolId).select('name address phone email settings.branding').lean(),
    sectionId ? Section.findOne({ _id: sectionId, schoolId }).select('name classId classTeacherId').lean() : null,
    AcademicSession.findOne({ _id: sessionId, schoolId }).select('name').lean(),
  ]);
  const cls = section ? await SchoolClass.findOne({ _id: section.classId, schoolId }).setOptions({ withDeleted: true }).select('name').lean() : null;
  return {
    school: school ? { name: school.name, address: school.address ?? null, phone: school.phone ?? null, email: school.email ?? null, logoUrl: school.settings?.branding?.logoUrl ?? null } : null,
    session: session ? { id: session._id, name: session.name } : null,
    student: { id: student._id, name: fullName(student), admissionNo: student.admissionNo, dateOfBirth: student.dateOfBirth ?? null, classSection: cls ? `${cls.name} - ${section.name}` : null },
  };
}

/**
 * Report card for one exam. Families only see published results; staff may also preview a
 * draft (marked `preview: true`).
 */
export async function examReportCard(tenant, examId, studentId, { family = false } = {}) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  const exam = await getExamDoc(schoolId, examId);
  let result = await ExamResult.findOne({ schoolId, examId: exam._id, studentId: student._id }).lean();
  let preview = false;
  if (!result) {
    if (family || exam.status === 'published') throw ApiError.notFound('Results for this exam are not available');
    const enrollment = await Enrollment.findOne({ schoolId, studentId: student._id, sessionId: exam.sessionId, status: 'active' }).lean();
    if (!enrollment || !exam.classIds.some((c) => String(c) === String(enrollment.classId))) throw ApiError.notFound('This student does not take this exam');
    result = (await computeResults(schoolId, exam, { classIds: [enrollment.classId] })).results.find((r) => String(r.studentId) === String(student._id));
    preview = true;
  }
  const bands = await bandsForExam(schoolId, exam);
  return {
    ...(await cardHeader(schoolId, student, result.sectionId, exam.sessionId)),
    exam: { id: exam._id, name: exam.name, type: exam.type, startDate: exam.startDate, endDate: exam.endDate, publishedAt: exam.publishedAt },
    preview,
    subjects: result.subjects,
    total: result.total,
    maxTotal: result.maxTotal,
    percentage: result.percentage,
    grade: result.grade,
    gradePoint: result.gradePoint,
    result: result.result,
    rankInSection: result.rankInSection,
    rankInClass: result.rankInClass,
    remark: result.remark,
    attendance: await attendanceSummary(schoolId, student._id, exam.sessionId),
    gradingScale: bands,
  };
}

/** Published results of a student in a session (staff, parents and the student). */
export async function studentResults(tenant, studentId, { sessionId }) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  const session = sessionId ? await getSessionOr404(schoolId, sessionId) : await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  if (!session) throw ApiError.badRequest('No current academic session. Pass sessionId.', { code: 'NO_CURRENT_SESSION' });
  const results = await ExamResult.find({ schoolId, studentId: student._id, sessionId: session._id }).lean();
  const exams = await nameMap(Exam, schoolId, results.map((r) => r.examId), 'name type startDate weightage publishedAt');
  return {
    student: { id: student._id, name: fullName(student), admissionNo: student.admissionNo },
    session: { id: session._id, name: session.name },
    results: results
      .map((r) => ({ examId: r.examId, exam: exams.get(idStr(r.examId)) ?? null, total: r.total, maxTotal: r.maxTotal, percentage: r.percentage, grade: r.grade, result: r.result, rankInSection: r.rankInSection, publishedAt: r.publishedAt }))
      .sort((a, b) => new Date(a.exam?.startDate) - new Date(b.exam?.startDate)),
  };
}

/** Whole-session report card combining published exams by their weightage. */
export async function sessionReportCard(tenant, studentId, { sessionId }) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  const session = sessionId ? await getSessionOr404(schoolId, sessionId) : await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  if (!session) throw ApiError.badRequest('No current academic session. Pass sessionId.', { code: 'NO_CURRENT_SESSION' });
  const results = await ExamResult.find({ schoolId, studentId: student._id, sessionId: session._id }).lean();
  const exams = await Exam.find({ schoolId, _id: { $in: results.map((r) => r.examId) } }).lean();
  const examBy = new Map(exams.map((e) => [String(e._id), e]));
  const entries = results.map((r) => ({ exam: examBy.get(String(r.examId)), result: r })).filter((e) => e.exam).sort((a, b) => a.exam.startDate - b.exam.startDate);
  const bands = (await defaultScale(schoolId))?.bands ?? [];
  const combined = combineResults(entries, bands);
  const latest = entries.at(-1)?.result;
  return {
    ...(await cardHeader(schoolId, student, latest?.sectionId, session._id)),
    exams: entries.map(({ exam, result }) => ({ id: exam._id, name: exam.name, weightage: exam.weightage, percentage: result.percentage, grade: result.grade, result: result.result, rankInSection: result.rankInSection })),
    ...combined,
    attendance: await attendanceSummary(schoolId, student._id, session._id),
    gradingScale: bands,
  };
}

/** Exams scheduled for a student's current class (papers with dates), for family views. */
export async function studentExamSchedule(tenant, studentId) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  const enrollment = session && (await Enrollment.findOne({ schoolId, studentId: student._id, sessionId: session._id, status: 'active' }).lean());
  if (!enrollment) return { exams: [] };
  const exams = await Exam.find({ schoolId, sessionId: session._id, classIds: enrollment.classId }).sort({ startDate: 1 }).lean();
  const out = [];
  for (const e of exams) {
    const papers = await listPapers(schoolId, e._id, enrollment.classId);
    out.push({ id: e._id, name: e.name, type: e.type, startDate: e.startDate, endDate: e.endDate, status: e.status, papers: papers.map((p) => ({ subject: p.subject, date: p.date, startTime: p.startTime, endTime: p.endTime, maxMarks: p.maxMarks, room: p.room ?? null })) });
  }
  return { exams: out };
}
