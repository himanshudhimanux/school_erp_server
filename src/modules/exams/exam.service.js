import { GradingScale, Exam, ExamPaper, MarkEntry } from './exam.models.js';
import { normalizeBands } from './grading.js';
import { SchoolClass, Subject, ClassSubject } from '../academics/academics.models.js';
import { getSessionOr404, assertSessionOpen, resolveSession, nameMap, idStr } from '../academics/academics.common.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const dup = (err, message, code) => (err?.code === 11000 ? ApiError.conflict(message, { code }) : err);

/* ------------------------------ grading scales ------------------------------ */

export const listScales = (schoolId) => GradingScale.find({ schoolId }).sort({ isDefault: -1, name: 1 }).lean();

async function getScaleDoc(schoolId, id) {
  const s = await GradingScale.findOne({ _id: id, schoolId });
  if (!s) throw ApiError.notFound('Grading scale not found');
  return s;
}

function checkBands(bands) {
  const { bands: sorted, errors } = normalizeBands(bands);
  if (errors.length) throw ApiError.validation(errors.map((message) => ({ field: 'body.bands', message })));
  return sorted;
}

/** Exams graded by a scale: those naming it, plus (for the default scale) those naming none. */
const usingScale = (schoolId, scale) => ({ schoolId, $or: [{ gradingScaleId: scale._id }, ...(scale.isDefault ? [{ gradingScaleId: null }] : [])] });

/** The school's default scale (null when none is set). */
export const defaultScale = (schoolId) => GradingScale.findOne({ schoolId, isDefault: true }).lean();

export async function createScale(tenant, data, ctx) {
  const schoolId = tenant.schoolId;
  const bands = checkBands(data.bands);
  const makeDefault = data.isDefault || !(await GradingScale.exists({ schoolId }));
  if (makeDefault) await GradingScale.updateMany({ schoolId, isDefault: true }, { isDefault: false });
  try {
    const s = await GradingScale.create({ ...data, bands, isDefault: makeDefault, schoolId, createdBy: ctx.actorId });
    await recordAudit({ ...ctx, action: 'grading_scale.created', entityType: 'GradingScale', entityId: s._id, metadata: { name: s.name } });
    return s;
  } catch (err) {
    throw dup(err, 'A grading scale with this name already exists', 'NAME_TAKEN');
  }
}

export async function updateScale(tenant, id, data, ctx) {
  const s = await getScaleDoc(tenant.schoolId, id);
  if (data.bands) {
    if (await Exam.exists({ ...usingScale(tenant.schoolId, s), status: 'published' })) {
      throw ApiError.conflict('This scale is used by published results. Create a new scale instead.', { code: 'SCALE_IN_USE' });
    }
    data.bands = checkBands(data.bands);
  }
  if (data.isDefault === true && !s.isDefault) await GradingScale.updateMany({ schoolId: tenant.schoolId, isDefault: true }, { isDefault: false });
  if (data.isDefault === false && s.isDefault) throw ApiError.badRequest('Make another scale the default instead', { code: 'DEFAULT_REQUIRED' });
  s.set({ ...data, updatedBy: ctx.actorId });
  try {
    await s.save();
  } catch (err) {
    throw dup(err, 'A grading scale with this name already exists', 'NAME_TAKEN');
  }
  await recordAudit({ ...ctx, action: 'grading_scale.updated', entityType: 'GradingScale', entityId: s._id, metadata: { changed: Object.keys(data) } });
  return s;
}

export async function deleteScale(tenant, id, ctx) {
  const s = await getScaleDoc(tenant.schoolId, id);
  if (await Exam.exists(usingScale(tenant.schoolId, s))) throw ApiError.conflict('This scale is used by exams', { code: 'SCALE_IN_USE' });
  if (s.isDefault && (await GradingScale.countDocuments({ schoolId: tenant.schoolId })) > 1) throw ApiError.badRequest('Make another scale the default first', { code: 'DEFAULT_REQUIRED' });
  await GradingScale.deleteOne({ _id: s._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'grading_scale.deleted', entityType: 'GradingScale', entityId: s._id, metadata: { name: s.name } });
}

/** Bands used for an exam: its own scale, else the school default, else none (no grades). */
export async function bandsForExam(schoolId, exam) {
  const scale = exam.gradingScaleId ? await GradingScale.findOne({ _id: exam.gradingScaleId, schoolId }).lean() : await defaultScale(schoolId);
  return scale?.bands ?? [];
}

/* ------------------------------ exams ------------------------------ */

export async function getExamDoc(schoolId, id) {
  const e = await Exam.findOne({ _id: id, schoolId });
  if (!e) throw ApiError.notFound('Exam not found');
  return e;
}

export function assertDraft(exam) {
  if (exam.status === 'published') throw ApiError.conflict('Results are published. Unpublish them to make changes.', { code: 'EXAM_PUBLISHED' });
}

async function decorateExams(schoolId, rows) {
  const [classes, scales, counts] = await Promise.all([
    nameMap(SchoolClass, schoolId, rows.flatMap((r) => r.classIds), 'name order'),
    nameMap(GradingScale, schoolId, rows.map((r) => r.gradingScaleId), 'name'),
    ExamPaper.aggregate([{ $match: { schoolId: rows[0]?.schoolId ?? schoolId, examId: { $in: rows.map((r) => r._id) } } }, { $group: { _id: '$examId', n: { $sum: 1 } } }]),
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((r) => ({
    ...r,
    classes: r.classIds.map((id) => classes.get(idStr(id))).filter(Boolean).sort((a, b) => a.order - b.order).map((c) => ({ id: c._id, name: c.name })),
    gradingScale: r.gradingScaleId ? scales.get(idStr(r.gradingScaleId)) ?? null : null,
    paperCount: countBy.get(String(r._id)) || 0,
  }));
}

export async function listExams(tenant, { sessionId, classId, status, type }) {
  const session = await resolveSession(tenant.schoolId, sessionId);
  const filter = { schoolId: tenant.schoolId, sessionId: session._id };
  if (classId) filter.classIds = classId;
  if (status) filter.status = status;
  if (type) filter.type = type;
  const rows = await Exam.find(filter).sort({ startDate: 1, name: 1 }).lean();
  return { session: { id: session._id, name: session.name }, items: rows.length ? await decorateExams(tenant.schoolId, rows) : [] };
}

async function validateExam(schoolId, session, data) {
  if (data.classIds) {
    const n = await SchoolClass.countDocuments({ schoolId, _id: { $in: data.classIds } });
    if (n !== new Set(data.classIds.map(String)).size) throw ApiError.badRequest('One or more classes do not belong to this school', { code: 'INVALID_CLASS' });
  }
  if (data.gradingScaleId && !(await GradingScale.exists({ _id: data.gradingScaleId, schoolId }))) throw ApiError.badRequest('Grading scale not found', { code: 'INVALID_SCALE' });
  for (const k of ['startDate', 'endDate']) {
    if (data[k] && (data[k] < session.startDate || data[k] > session.endDate)) throw ApiError.badRequest(`Exam dates must be inside session ${session.name}`, { code: 'OUTSIDE_SESSION' });
  }
}

export async function createExam(tenant, data, ctx) {
  const session = await getSessionOr404(tenant.schoolId, data.sessionId);
  assertSessionOpen(session);
  await validateExam(tenant.schoolId, session, data);
  try {
    const e = await Exam.create({ ...data, schoolId: tenant.schoolId, createdBy: ctx.actorId });
    await recordAudit({ ...ctx, action: 'exam.created', entityType: 'Exam', entityId: e._id, metadata: { name: e.name } });
    return getExam(tenant, e._id);
  } catch (err) {
    throw dup(err, 'An exam with this name already exists in the session', 'NAME_TAKEN');
  }
}

export async function getExam(tenant, id) {
  const e = await getExamDoc(tenant.schoolId, id);
  const [row] = await decorateExams(tenant.schoolId, [e.toObject()]);
  return { ...row, papers: await listPapers(tenant.schoolId, e._id) };
}

export async function updateExam(tenant, id, data, ctx) {
  const schoolId = tenant.schoolId;
  const e = await getExamDoc(schoolId, id);
  assertDraft(e);
  const session = await getSessionOr404(schoolId, e.sessionId);
  assertSessionOpen(session);
  await validateExam(schoolId, session, data);
  const start = data.startDate || e.startDate;
  const end = data.endDate || e.endDate;
  if (end < start) throw ApiError.validation([{ field: 'body.endDate', message: 'End date must be on or after the start date' }]);
  if (await ExamPaper.exists({ schoolId, examId: e._id, $or: [{ date: { $lt: start } }, { date: { $gt: end } }] })) {
    throw ApiError.conflict('Some papers are scheduled outside the new dates. Move them first.', { code: 'PAPERS_OUTSIDE_DATES' });
  }
  if (data.classIds) {
    const removed = e.classIds.filter((c) => !data.classIds.some((x) => String(x) === String(c)));
    if (removed.length && (await ExamPaper.exists({ schoolId, examId: e._id, classId: { $in: removed } }))) {
      throw ApiError.conflict('A removed class still has papers scheduled. Remove its papers first.', { code: 'CLASS_HAS_PAPERS' });
    }
  }
  e.set({ ...data, updatedBy: ctx.actorId });
  try {
    await e.save();
  } catch (err) {
    throw dup(err, 'An exam with this name already exists in the session', 'NAME_TAKEN');
  }
  await recordAudit({ ...ctx, action: 'exam.updated', entityType: 'Exam', entityId: e._id, metadata: { changed: Object.keys(data) } });
  return getExam(tenant, e._id);
}

export async function deleteExam(tenant, id, ctx) {
  const schoolId = tenant.schoolId;
  const e = await getExamDoc(schoolId, id);
  assertDraft(e);
  if (await MarkEntry.exists({ schoolId, examId: e._id })) throw ApiError.conflict('Marks have been entered for this exam', { code: 'EXAM_IN_USE' });
  await ExamPaper.deleteMany({ schoolId, examId: e._id });
  await Exam.deleteOne({ _id: e._id, schoolId });
  await recordAudit({ ...ctx, action: 'exam.deleted', entityType: 'Exam', entityId: e._id, metadata: { name: e.name } });
}

/* ------------------------------ papers ------------------------------ */

export async function listPapers(schoolId, examId, classId) {
  const filter = { schoolId, examId };
  if (classId) filter.classId = classId;
  const rows = await ExamPaper.find(filter).sort({ date: 1, startTime: 1 }).lean();
  const [subjects, classes] = await Promise.all([nameMap(Subject, schoolId, rows.map((r) => r.subjectId), 'name code'), nameMap(SchoolClass, schoolId, rows.map((r) => r.classId), 'name')]);
  return rows.map((r) => ({ ...r, subject: subjects.get(idStr(r.subjectId)) ?? null, class: classes.get(idStr(r.classId)) ?? null }));
}

const overlaps = (a, b) => a.date.getTime() === b.date.getTime() && (!a.startTime || !b.startTime || (a.startTime < (b.endTime || '24:00') && b.startTime < (a.endTime || '24:00')));

/**
 * Replaces the papers of one class in an exam. Subjects must be in the class curriculum, dates
 * inside the exam, and two papers of the class cannot overlap. Papers that already have marks
 * cannot be removed or given a maximum below marks already entered.
 */
export async function setClassPapers(tenant, examId, { classId, papers }, ctx) {
  const schoolId = tenant.schoolId;
  const exam = await getExamDoc(schoolId, examId);
  assertDraft(exam);
  assertSessionOpen(await getSessionOr404(schoolId, exam.sessionId));
  if (!exam.classIds.some((c) => String(c) === String(classId))) throw ApiError.badRequest('This class is not part of the exam', { code: 'CLASS_NOT_IN_EXAM' });

  const curriculum = new Set((await ClassSubject.distinct('subjectId', { schoolId, sessionId: exam.sessionId, classId })).map(String));
  const seen = new Set();
  for (const p of papers) {
    if (seen.has(String(p.subjectId))) throw ApiError.validation([{ field: 'body.papers', message: 'Each subject may appear once' }]);
    seen.add(String(p.subjectId));
    if (!curriculum.has(String(p.subjectId))) throw ApiError.badRequest('A subject is not part of this class’s curriculum', { code: 'SUBJECT_NOT_IN_CLASS', details: { subjectId: p.subjectId } });
    if (p.date < exam.startDate || p.date > exam.endDate) throw ApiError.badRequest('Paper dates must be within the exam dates', { code: 'OUTSIDE_EXAM_DATES', details: { subjectId: p.subjectId } });
    if (p.passMarks > p.maxMarks) throw ApiError.validation([{ field: 'body.papers', message: 'Pass marks cannot exceed maximum marks' }]);
  }
  for (let i = 0; i < papers.length; i += 1) {
    for (let j = i + 1; j < papers.length; j += 1) {
      if (overlaps(papers[i], papers[j])) throw ApiError.conflict('Two papers of this class overlap', { code: 'PAPER_CLASH', details: { subjectIds: [papers[i].subjectId, papers[j].subjectId] } });
    }
  }

  const existing = await ExamPaper.find({ schoolId, examId: exam._id, classId }).lean();
  const bySubject = new Map(existing.map((p) => [String(p.subjectId), p]));
  const removed = existing.filter((p) => !seen.has(String(p.subjectId)));
  if (removed.length && (await MarkEntry.exists({ schoolId, paperId: { $in: removed.map((p) => p._id) } }))) {
    throw ApiError.conflict('A paper being removed already has marks', { code: 'PAPER_HAS_MARKS' });
  }
  for (const p of papers) {
    const old = bySubject.get(String(p.subjectId));
    if (old && p.maxMarks < old.maxMarks) {
      const over = await MarkEntry.exists({ schoolId, paperId: old._id, marks: { $gt: p.maxMarks } });
      if (over) throw ApiError.conflict('Some marks already entered are above the new maximum', { code: 'MARKS_EXCEED_MAX', details: { subjectId: p.subjectId } });
    }
  }

  if (removed.length) await ExamPaper.deleteMany({ schoolId, _id: { $in: removed.map((p) => p._id) } });
  for (const p of papers) {
    const fields = { date: p.date, startTime: p.startTime ?? null, endTime: p.endTime ?? null, maxMarks: p.maxMarks, passMarks: p.passMarks, room: p.room, updatedBy: ctx.actorId };
    await ExamPaper.updateOne(
      { schoolId, examId: exam._id, classId, subjectId: p.subjectId },
      { $set: fields, $setOnInsert: { sessionId: exam.sessionId, createdBy: ctx.actorId } },
      { upsert: true, runValidators: true },
    );
  }
  await recordAudit({ ...ctx, action: 'exam.papers_saved', entityType: 'Exam', entityId: exam._id, metadata: { classId, papers: papers.length, removed: removed.length } });
  return listPapers(schoolId, exam._id, classId);
}
