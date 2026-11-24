import { Router } from 'express';
import { z } from 'zod';
import { requirePermission, requireAnyPermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { dateOnly } from '../../utils/dates.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { hasStaffRole } from '../students/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { EXAM_TYPES, MARK_STATUSES } from './exam.models.js';
import * as exams from './exam.service.js';
import * as marks from './marks.service.js';
import './exam.guards.js';

const router = Router();

// Staff endpoints. Parents and students use /portal, which only shows published results.
router.use((req, _res, next) => (hasStaffRole(req.tenant) ? next() : next(ApiError.forbidden('Use the family portal for exam results', { code: 'STAFF_ONLY' }))));

const R = requirePermission('exams.read');
const MARKS = requireAnyPermission('exams.marks', 'exams.update');
const id = z.object({ id: objectId });
const nonEmpty = (s) => s.refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour)');

/* ------------------------------ grading scales ------------------------------ */
const band = z.object({ grade: z.string().trim().min(1).max(10), minPercent: z.number().min(0).max(100), gradePoint: z.number().min(0).max(10).nullable().optional(), remark: z.string().trim().max(60).optional() }).strict();
const scaleFields = { name: z.string().trim().min(2).max(80), bands: z.array(band).min(1).max(20), isDefault: z.boolean() };
router.get('/grading-scales', R, async (req, res) => ok(res, await exams.listScales(req.tenant.schoolId)));
router.post('/grading-scales', requirePermission('exams.create'), validate({ body: z.object(scaleFields).partial({ isDefault: true }).strict() }), async (req, res) =>
  created(res, await exams.createScale(req.tenant, req.body, auditContext(req)), 'Grading scale created'),
);
router.patch('/grading-scales/:id', requirePermission('exams.update'), validate({ params: id, body: nonEmpty(z.object(scaleFields).partial().strict()) }), async (req, res) =>
  ok(res, await exams.updateScale(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Grading scale updated' }),
);
router.delete('/grading-scales/:id', requirePermission('exams.delete'), validate({ params: id }), async (req, res) => {
  await exams.deleteScale(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Grading scale deleted' });
});

/* ------------------------------ exams ------------------------------ */
const examFields = {
  name: z.string().trim().min(2).max(100),
  type: z.enum(EXAM_TYPES),
  classIds: z.array(objectId).min(1).max(50),
  startDate: dateOnly,
  endDate: dateOnly,
  gradingScaleId: objectId.nullable(),
  weightage: z.number().min(0).max(100),
  description: z.string().trim().max(500).optional(),
};
router.get('/', R, validate({ query: z.object({ sessionId: objectId.optional(), classId: objectId.optional(), status: z.enum(['draft', 'published']).optional(), type: z.enum(EXAM_TYPES).optional() }) }), async (req, res) =>
  ok(res, await exams.listExams(req.tenant, req.validatedQuery)),
);
router.post(
  '/',
  requirePermission('exams.create'),
  validate({ body: z.object({ sessionId: objectId, ...examFields }).partial({ type: true, gradingScaleId: true, weightage: true }).strict().refine((d) => d.endDate >= d.startDate, { message: 'End date must be on or after the start date', path: ['endDate'] }) }),
  async (req, res) => created(res, await exams.createExam(req.tenant, req.body, auditContext(req)), 'Exam created'),
);
router.get('/students/:studentId/results', R, validate({ params: z.object({ studentId: objectId }), query: z.object({ sessionId: objectId.optional() }) }), async (req, res) =>
  ok(res, await marks.studentResults(req.tenant, req.params.studentId, req.validatedQuery)),
);
router.get('/students/:studentId/report-card', R, validate({ params: z.object({ studentId: objectId }), query: z.object({ sessionId: objectId.optional() }) }), async (req, res) =>
  ok(res, await marks.sessionReportCard(req.tenant, req.params.studentId, req.validatedQuery)),
);
router.get('/:id', R, validate({ params: id }), async (req, res) => ok(res, await exams.getExam(req.tenant, req.params.id)));
router.patch('/:id', requirePermission('exams.update'), validate({ params: id, body: nonEmpty(z.object(examFields).partial().strict()) }), async (req, res) =>
  ok(res, await exams.updateExam(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Exam updated' }),
);
router.delete('/:id', requirePermission('exams.delete'), validate({ params: id }), async (req, res) => {
  await exams.deleteExam(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Exam deleted' });
});

/* ------------------------------ schedule ------------------------------ */
const paper = z
  .object({ subjectId: objectId, date: dateOnly, startTime: time.optional(), endTime: time.optional(), maxMarks: z.number().int().min(1).max(1000), passMarks: z.number().min(0).max(1000), room: z.string().trim().max(50).optional() })
  .strict()
  .refine((p) => !p.startTime || !p.endTime || p.endTime > p.startTime, { message: 'End time must be after start time', path: ['endTime'] });
router.get('/:id/papers', R, validate({ params: id, query: z.object({ classId: objectId.optional() }) }), async (req, res) => {
  await exams.getExamDoc(req.tenant.schoolId, req.params.id);
  return ok(res, await exams.listPapers(req.tenant.schoolId, req.params.id, req.validatedQuery.classId));
});
router.put('/:id/papers', requirePermission('exams.update'), validate({ params: id, body: z.object({ classId: objectId, papers: z.array(paper).max(30) }).strict() }), async (req, res) =>
  ok(res, await exams.setClassPapers(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Exam schedule saved' }),
);

/* ------------------------------ marks ------------------------------ */
const paperParams = z.object({ id: objectId, paperId: objectId });
const marksValue = z
  .number()
  .min(0)
  .max(1000)
  .refine((v) => Math.round(v * 100) === v * 100, 'Use at most two decimal places');
router.get('/:id/papers/:paperId/marks', R, validate({ params: paperParams, query: z.object({ sectionId: objectId }) }), async (req, res) =>
  ok(res, await marks.getPaperMarks(req.tenant, req.params.id, req.params.paperId, req.validatedQuery.sectionId)),
);
router.put(
  '/:id/papers/:paperId/marks',
  MARKS,
  validate({
    params: paperParams,
    body: z
      .object({
        sectionId: objectId,
        entries: z
          .array(z.object({ studentId: objectId, marks: marksValue.nullable().optional(), status: z.enum(MARK_STATUSES).default('present'), remarks: z.string().trim().max(200).optional() }).strict())
          .min(1)
          .max(500)
          .refine((a) => new Set(a.map((e) => e.studentId)).size === a.length, 'Each student may appear only once'),
      })
      .strict(),
  }),
  async (req, res) => ok(res, await marks.saveMarks(req.tenant, req.params.id, req.params.paperId, req.body, auditContext(req)), { message: 'Marks saved' }),
);
router.get('/:id/progress', MARKS, validate({ params: id }), async (req, res) => ok(res, await marks.examProgress(req.tenant, req.params.id)));
router.post('/:id/lock', requirePermission('exams.update'), validate({ params: id }), async (req, res) => ok(res, await marks.setMarksLock(req.tenant, req.params.id, true, auditContext(req)), { message: 'Marks entry locked' }));
router.post('/:id/unlock', requirePermission('exams.update'), validate({ params: id }), async (req, res) => ok(res, await marks.setMarksLock(req.tenant, req.params.id, false, auditContext(req)), { message: 'Marks entry unlocked' }));

/* ------------------------------ results ------------------------------ */
router.get('/:id/results', R, validate({ params: id, query: z.object({ sectionId: objectId }) }), async (req, res) => ok(res, await marks.sectionResults(req.tenant, req.params.id, req.validatedQuery.sectionId)));
router.put(
  '/:id/remarks',
  MARKS,
  validate({ params: id, body: z.object({ sectionId: objectId, entries: z.array(z.object({ studentId: objectId, remark: z.string().trim().max(500) }).strict()).min(1).max(500) }).strict() }),
  async (req, res) => ok(res, await marks.saveRemarks(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Remarks saved' }),
);
router.post('/:id/publish', requirePermission('exams.publish'), validate({ params: id, body: z.object({ allowIncomplete: z.boolean().optional() }).strict() }), async (req, res) =>
  ok(res, await marks.publishResults(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Results published' }),
);
router.post('/:id/unpublish', requirePermission('exams.publish'), validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(300) }).strict() }), async (req, res) =>
  ok(res, await marks.unpublishResults(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Results unpublished' }),
);
router.get('/:id/report-cards/:studentId', R, validate({ params: z.object({ id: objectId, studentId: objectId }) }), async (req, res) =>
  ok(res, await marks.examReportCard(req.tenant, req.params.id, req.params.studentId)),
);

export default router;
