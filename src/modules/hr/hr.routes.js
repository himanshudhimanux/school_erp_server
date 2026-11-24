import { Router } from 'express';
import { z } from 'zod';
import { requirePermission, requireAnyPermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly, daysBetween } from '../../utils/dates.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import * as svc from './hr.service.js';

const router = Router();
const id = z.object({ id: objectId });
const amount = z.number().int('Amounts are whole paise').min(0).max(100_000_000_00);
const lines = z.array(z.object({ name: z.string().trim().min(1).max(60), amount }).strict()).max(15);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const list = (res, { items, meta }) => ok(res, items, { meta });

/* ------------------------------ self service (every staff member) ------------------------------ */
router.get('/my/leave-balance', requirePermission('hr.self'), async (req, res) => ok(res, await svc.leaveBalance(req.tenant.schoolId, req.tenant.membershipId)));
router.get('/my/leaves', requirePermission('hr.self'), validate({ query: paginationQuery }), async (req, res) => list(res, await svc.listLeaves(req.tenant, { ...req.validatedQuery, mine: true })));
router.post(
  '/my/leaves',
  requirePermission('hr.self'),
  validate({ body: z.object({ type: z.enum(svc.LEAVE_TYPES), fromDate: dateOnly, toDate: dateOnly, reason: z.string().trim().min(3).max(500) }).strict().refine((d) => d.toDate >= d.fromDate, { message: 'End date must be on or after the start date', path: ['toDate'] }).refine((d) => daysBetween(d.fromDate, d.toDate) < 90, { message: 'Leave can cover at most 90 days', path: ['toDate'] }) }),
  async (req, res) => created(res, await svc.applyLeave(req.tenant, req.body, auditContext(req)), 'Leave request sent'),
);
router.post('/my/leaves/:id/cancel', requirePermission('hr.self'), validate({ params: id }), async (req, res) => ok(res, await svc.cancelMyLeave(req.tenant, req.params.id, auditContext(req)), { message: 'Leave cancelled' }));
router.get('/my/payslips', requirePermission('hr.self'), async (req, res) => ok(res, await svc.myPayslips(req.tenant)));
router.get('/my/payslips/:id', requirePermission('hr.self'), validate({ params: id }), async (req, res) => ok(res, await svc.getPayslip(req.tenant, req.params.id, { own: true })));

/* ------------------------------ leave management ------------------------------ */
router.get('/settings', requirePermission('hr.read'), async (req, res) => ok(res, await svc.hrSettings(req.tenant.schoolId)));
router.patch('/settings', requirePermission('hr.update'), validate({ body: z.object({ leaveQuota: z.object({ casual: z.number().int().min(0).max(365), sick: z.number().int().min(0).max(365), earned: z.number().int().min(0).max(365), other: z.number().int().min(0).max(365) }).partial().strict() }).strict() }), async (req, res) =>
  ok(res, await svc.updateHrSettings(req.tenant, req.body, auditContext(req)), { message: 'Leave policy saved' }),
);
router.get('/leaves', requirePermission('hr.read'), validate({ query: paginationQuery.extend({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), membershipId: objectId.optional() }) }), async (req, res) => list(res, await svc.listLeaves(req.tenant, req.validatedQuery)));
router.get('/leave-balance/:id', requirePermission('hr.read'), validate({ params: id }), async (req, res) => ok(res, await svc.leaveBalance(req.tenant.schoolId, req.params.id)));
router.post('/leaves/:id/review', requirePermission('hr.update'), validate({ params: id, body: z.object({ status: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).optional() }).strict() }), async (req, res) =>
  ok(res, await svc.reviewLeave(req.tenant, req.params.id, req.body, auditContext(req)), { message: `Leave ${req.body.status}` }),
);

/* ------------------------------ salaries & payroll ------------------------------ */
router.get('/salaries', requirePermission('hr.payroll'), async (req, res) => ok(res, await svc.listSalaries(req.tenant)));
router.put('/salaries/:id', requirePermission('hr.payroll'), validate({ params: id, body: z.object({ basic: amount, allowances: lines.default([]), deductions: lines.default([]), bankAccount: z.string().trim().max(40).optional() }).strict() }), async (req, res) =>
  ok(res, await svc.saveSalary(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Salary saved' }),
);
router.get('/payroll', requirePermission('hr.payroll'), async (req, res) => ok(res, await svc.listRuns(req.tenant)));
router.post('/payroll', requirePermission('hr.payroll'), validate({ body: z.object({ month }).strict() }), async (req, res) => created(res, await svc.createRun(req.tenant, req.body, auditContext(req)), 'Payroll prepared'));
router.get('/payroll/:id', requirePermission('hr.payroll'), validate({ params: id }), async (req, res) => ok(res, await svc.getRun(req.tenant, req.params.id)));
router.post('/payroll/:id/recalculate', requirePermission('hr.payroll'), validate({ params: id }), async (req, res) => ok(res, await svc.regenerateRun(req.tenant, req.params.id, auditContext(req)), { message: 'Payroll recalculated' }));
router.post('/payroll/:id/finalize', requirePermission('hr.payroll'), validate({ params: id }), async (req, res) => ok(res, await svc.finalizeRun(req.tenant, req.params.id, auditContext(req)), { message: 'Payroll finalized' }));
router.post(
  '/payroll/:id/pay',
  requirePermission('hr.payroll'),
  validate({ params: id, body: z.object({ method: z.enum(['bank_transfer', 'cash', 'cheque']), paidAt: z.coerce.date().optional(), reference: z.string().trim().max(100).optional() }).strict() }),
  async (req, res) => ok(res, await svc.payRun(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Payroll marked as paid' }),
);
router.delete('/payroll/:id', requirePermission('hr.payroll'), validate({ params: id }), async (req, res) => {
  await svc.deleteRun(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Draft payroll deleted' });
});
router.get('/payslips/:id', requireAnyPermission('hr.payroll'), validate({ params: id }), async (req, res) => ok(res, await svc.getPayslip(req.tenant, req.params.id, { own: false })));

export default router;
