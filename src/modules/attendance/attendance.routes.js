import { Router } from 'express';
import { z } from 'zod';
import { requirePermission, requireAnyPermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly, daysBetween } from '../../utils/dates.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { NOTIFICATION_STATUSES } from '../notifications/notification.model.js';
import { ATTENDANCE_STATUSES, LEAVE_STATUSES } from './attendance.models.js';
import * as svc from './attendance.service.js';
import * as leaves from './leave.service.js';
import './attendance.guards.js';

const router = Router();
const READ = requirePermission('attendance.read');
const STAFF = requireAnyPermission('attendance.mark', 'attendance.update', 'attendance.reports');
const MARK = requireAnyPermission('attendance.mark', 'attendance.update');

const sectionParams = z.object({ sectionId: objectId });
const dateQuery = z.object({ date: dateOnly.optional() });

const markSchema = z
  .object({
    date: dateOnly,
    defaultStatus: z.enum(ATTENDANCE_STATUSES).optional(),
    entries: z
      .array(z.object({ studentId: objectId, status: z.enum(ATTENDANCE_STATUSES), remark: z.string().trim().max(200).optional() }).strict())
      .max(500)
      .default([])
      .refine((a) => new Set(a.map((e) => e.studentId)).size === a.length, 'Each student may appear only once'),
  })
  .strict();

export const leaveSchema = z
  .object({ studentId: objectId, fromDate: dateOnly, toDate: dateOnly, reason: z.string().trim().min(3).max(500) })
  .strict()
  .refine((d) => d.toDate >= d.fromDate, { message: 'End date must be on or after the start date', path: ['toDate'] })
  .refine((d) => daysBetween(d.fromDate, d.toDate) < 60, { message: 'Leave can cover at most 60 days', path: ['toDate'] });

export const rangeQuery = z.object({ sessionId: objectId.optional(), from: dateOnly.optional(), to: dateOnly.optional() });

/* ------------------------------ marking ------------------------------ */
router.get('/daily', STAFF, validate({ query: dateQuery.extend({ campusId: objectId.optional() }) }), async (req, res) => ok(res, await svc.dailySummary(req.tenant, req.validatedQuery)));
router.get('/sections/:sectionId', READ, validate({ params: sectionParams, query: dateQuery }), async (req, res) =>
  ok(res, await svc.getSectionSheet(req.tenant, req.params.sectionId, req.validatedQuery.date)),
);
router.put('/sections/:sectionId', MARK, validate({ params: sectionParams, body: markSchema }), async (req, res) => {
  const data = await svc.markSection(req.tenant, req.params.sectionId, req.body, auditContext(req));
  return ok(res, data, { message: data.result.created ? 'Attendance submitted' : 'Attendance updated' });
});
router.get('/sections/:sectionId/register', READ, validate({ params: sectionParams, query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') }) }), async (req, res) =>
  ok(res, await svc.sectionRegister(req.tenant, req.params.sectionId, req.validatedQuery.month)),
);

/* ------------------------------ reports ------------------------------ */
router.get('/students/:studentId', READ, validate({ params: z.object({ studentId: objectId }), query: rangeQuery }), async (req, res) =>
  ok(res, await svc.studentAttendance(req.tenant, req.params.studentId, req.validatedQuery)),
);
router.get(
  '/reports/low',
  STAFF,
  validate({
    query: paginationQuery.extend({
      sessionId: objectId.optional(),
      classId: objectId.optional(),
      sectionId: objectId.optional(),
      threshold: z.coerce.number().min(1).max(100).optional(),
      minDays: z.coerce.number().int().min(1).max(400).optional(),
    }),
  }),
  async (req, res) => {
    const { items, meta } = await svc.lowAttendance(req.tenant, req.validatedQuery);
    return ok(res, items, { meta });
  },
);
router.get(
  '/alerts',
  STAFF,
  validate({ query: paginationQuery.extend({ date: dateOnly.optional(), status: z.enum(NOTIFICATION_STATUSES).optional(), sectionId: objectId.optional() }) }),
  async (req, res) => {
    const { items, meta } = await svc.listAlerts(req.tenant, req.validatedQuery);
    return ok(res, items, { meta });
  },
);

/* ------------------------------ leave ------------------------------ */
router.get(
  '/leave-requests',
  MARK,
  validate({ query: paginationQuery.extend({ status: z.enum(LEAVE_STATUSES).optional(), studentId: objectId.optional(), sectionId: objectId.optional() }) }),
  async (req, res) => {
    const { items, meta } = await leaves.listLeaves(req.tenant, req.validatedQuery);
    return ok(res, items, { meta });
  },
);
router.post('/leave-requests', MARK, validate({ body: leaveSchema }), async (req, res) => created(res, await leaves.createLeave(req.tenant, req.body, auditContext(req), { via: 'staff' }), 'Leave recorded'));
router.post(
  '/leave-requests/:id/review',
  MARK,
  validate({ params: z.object({ id: objectId }), body: z.object({ status: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).optional() }).strict() }),
  async (req, res) => ok(res, await leaves.reviewLeave(req.tenant, req.params.id, req.body, auditContext(req)), { message: `Leave ${req.body.status}` }),
);
router.post('/leave-requests/:id/cancel', MARK, validate({ params: z.object({ id: objectId }) }), async (req, res) =>
  ok(res, await leaves.cancelLeave(req.tenant, req.params.id, auditContext(req)), { message: 'Leave cancelled' }),
);

export default router;
