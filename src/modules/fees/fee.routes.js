import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly } from '../../utils/dates.js';
import { toDotPaths } from '../../utils/flatten.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext, recordAudit } from '../audit/audit.service.js';
import { School } from '../schools/school.model.js';
import { PAYMENT_METHODS, OFFLINE_METHODS, LATE_FEE_TYPES, ACCOUNTS } from './fee.models.js';
import * as setup from './setup.service.js';
import * as invoices from './invoice.service.js';
import * as payments from './payment.service.js';
import * as gateway from './gateway.service.js';
import * as reminders from './reminder.service.js';
import * as reports from './report.service.js';
import './fee.guards.js';
import { channelList } from '../schools/school.validators.js';
import { assertChannelsAvailable } from '../notifications/notification.service.js';

const router = Router();
const P = (p) => requirePermission(`fees.${p}`);
const id = z.object({ id: objectId });
const amount = z.number().int('Amounts are whole paise').positive().max(10_000_000_000);
const nonEmpty = (schema) => schema.refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');
const status = z.enum(['active', 'inactive']);
const list = (res, { items, meta }) => ok(res, items, { meta });
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Code may contain letters, digits and hyphens (max 20)');

/* ------------------------------ setup ------------------------------ */
const categoryFields = { name: z.string().trim().min(2).max(80), code, description: z.string().trim().max(300).optional(), status: status.optional() };
router.get('/categories', P('read'), validate({ query: paginationQuery.extend({ status: status.optional(), search: z.string().trim().max(100).optional() }) }), async (req, res) =>
  list(res, await setup.listCategories(req.tenant.schoolId, req.validatedQuery)),
);
router.post('/categories', P('create'), validate({ body: z.object(categoryFields).strict() }), async (req, res) => created(res, await setup.createCategory(req.tenant, req.body, auditContext(req)), 'Fee category created'));
router.patch('/categories/:id', P('update'), validate({ params: id, body: nonEmpty(z.object(categoryFields).partial().strict()) }), async (req, res) =>
  ok(res, await setup.updateCategory(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Fee category updated' }),
);
router.delete('/categories/:id', P('delete'), validate({ params: id }), async (req, res) => {
  await setup.deleteCategory(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Fee category deleted' });
});

const installment = z
  .object({ name: z.string().trim().min(1).max(60), dueDate: dateOnly, items: z.array(z.object({ categoryId: objectId, amount }).strict()).min(1).max(20) })
  .strict()
  .refine((i) => new Set(i.items.map((x) => x.categoryId)).size === i.items.length, 'A category may appear once per installment');
const lateFee = z
  .object({ type: z.enum(LATE_FEE_TYPES), amount: z.number().int().min(0).max(100_000_000).default(0), graceDays: z.number().int().min(0).max(90).default(0), maxAmount: z.number().int().min(0).max(100_000_000).default(0) })
  .strict()
  .refine((l) => l.type === 'none' || l.amount > 0, { message: 'Enter the late fee amount', path: ['amount'] });
const structureFields = {
  name: z.string().trim().min(2).max(100),
  classIds: z.array(objectId).min(1).max(50),
  campusId: objectId.nullable(),
  installments: z.array(installment).min(1).max(24),
  lateFee,
  status,
};
router.get('/structures', P('read'), validate({ query: z.object({ sessionId: objectId.optional(), classId: objectId.optional(), status: status.optional() }) }), async (req, res) =>
  ok(res, await setup.listStructures(req.tenant, req.validatedQuery)),
);
router.post('/structures', P('create'), validate({ body: z.object({ sessionId: objectId, ...structureFields }).partial({ campusId: true, lateFee: true, status: true }).strict() }), async (req, res) =>
  created(res, await setup.createStructure(req.tenant, req.body, auditContext(req)), 'Fee structure created'),
);
router.get('/structures/:id', P('read'), validate({ params: id }), async (req, res) => ok(res, await setup.getStructure(req.tenant, req.params.id)));
router.patch('/structures/:id', P('update'), validate({ params: id, body: nonEmpty(z.object(structureFields).partial().strict()) }), async (req, res) =>
  ok(res, await setup.updateStructure(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Fee structure updated (issued invoices are not changed)' }),
);
router.delete('/structures/:id', P('delete'), validate({ params: id }), async (req, res) => {
  await setup.deleteStructure(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Fee structure deleted' });
});

const discountFields = { name: z.string().trim().min(2).max(80), type: z.enum(['percent', 'fixed']), value: z.number().positive().max(100_000_000), categoryIds: z.array(objectId).max(50), description: z.string().trim().max(300).optional(), status };
router.get('/discounts', P('read'), validate({ query: paginationQuery.extend({ status: status.optional() }) }), async (req, res) => list(res, await setup.listDiscounts(req.tenant.schoolId, req.validatedQuery)));
router.post('/discounts', P('create'), validate({ body: z.object(discountFields).partial({ categoryIds: true, status: true }).strict() }), async (req, res) =>
  created(res, await setup.createDiscount(req.tenant, req.body, auditContext(req)), 'Discount created'),
);
router.patch('/discounts/:id', P('update'), validate({ params: id, body: nonEmpty(z.object(discountFields).partial().strict()) }), async (req, res) =>
  ok(res, await setup.updateDiscount(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Discount updated' }),
);
router.delete('/discounts/:id', P('delete'), validate({ params: id }), async (req, res) => {
  await setup.deleteDiscount(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Discount deleted' });
});

/* ------------------------------ assignments ------------------------------ */
router.post(
  '/assignments',
  P('create'),
  validate({
    body: z
      .object({ structureId: objectId, studentIds: z.array(objectId).min(1).max(500).optional(), sectionId: objectId.optional(), discountIds: z.array(objectId).max(10).default([]) })
      .strict()
      .refine((d) => Boolean(d.studentIds) !== Boolean(d.sectionId), { message: 'Provide either studentIds or sectionId', path: ['studentIds'] }),
  }),
  async (req, res) => ok(res, await invoices.assignFees(req.tenant, req.body, auditContext(req)), { message: 'Fees assigned' }),
);
router.get('/assignments', P('read'), validate({ query: paginationQuery.extend({ structureId: objectId.optional(), studentId: objectId.optional(), status: z.enum(['active', 'cancelled']).optional() }) }), async (req, res) =>
  list(res, await invoices.listAssignments(req.tenant, req.validatedQuery)),
);
router.post('/assignments/:id/cancel', P('delete'), validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(300) }).strict() }), async (req, res) =>
  ok(res, await invoices.cancelAssignment(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Assignment cancelled' }),
);

/* ------------------------------ invoices ------------------------------ */
const invoiceQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  sessionId: objectId.optional(),
  classId: objectId.optional(),
  sectionId: objectId.optional(),
  studentId: objectId.optional(),
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'cancelled', 'overdue', 'pending', 'outstanding']).optional(),
  dueFrom: dateOnly.optional(),
  dueTo: dateOnly.optional(),
  sort: z.enum(['dueDate', '-dueDate', 'invoiceNo', '-invoiceNo', '-createdAt']).optional(),
});
router.get('/invoices', P('read'), validate({ query: invoiceQuery }), async (req, res) => list(res, await invoices.listInvoices(req.tenant, req.validatedQuery)));
router.post(
  '/invoices',
  P('create'),
  validate({ body: z.object({ studentId: objectId, title: z.string().trim().min(2).max(120), dueDate: dateOnly, lines: z.array(z.object({ categoryId: objectId, amount, description: z.string().trim().max(120).optional() }).strict()).min(1).max(30) }).strict() }),
  async (req, res) => created(res, await invoices.createAdhocInvoice(req.tenant, req.body, auditContext(req)), 'Invoice created'),
);
router.get('/invoices/:id', P('read'), validate({ params: id }), async (req, res) => ok(res, await invoices.getInvoice(req.tenant, req.params.id)));
const reason = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
router.post('/invoices/:id/cancel', P('delete'), validate({ params: id, body: reason }), async (req, res) => ok(res, await invoices.cancelInvoice(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Invoice cancelled' }));
router.post('/invoices/:id/concession', P('update'), validate({ params: id, body: z.object({ amount, reason: z.string().trim().min(3).max(300) }).strict() }), async (req, res) =>
  ok(res, await invoices.addConcession(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Concession applied' }),
);
router.post('/invoices/:id/waive-late-fee', P('update'), validate({ params: id, body: reason }), async (req, res) =>
  ok(res, await invoices.waiveLateFee(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Late fee waived' }),
);
router.post('/invoices/:id/remind', P('update'), validate({ params: id }), async (req, res) => ok(res, await reminders.remindInvoice(req.tenant, req.params.id, auditContext(req)), { message: 'Reminder sent' }));
router.post('/late-fees/apply', P('update'), async (req, res) => ok(res, await invoices.applyLateFees(req.tenant.schoolId, await invoices.schoolToday(req.tenant)), { message: 'Late fees updated' }));
router.get('/students/:id', P('read'), validate({ params: id }), async (req, res) => ok(res, await payments.studentFeeAccount(req.tenant, req.params.id)));

/* ------------------------------ payments ------------------------------ */
router.post(
  '/payments',
  P('collect'),
  validate({
    body: z
      .object({
        studentId: objectId,
        allocations: z.array(z.object({ invoiceId: objectId, amount }).strict()).min(1).max(50).optional(),
        amount: amount.optional(),
        method: z.enum(OFFLINE_METHODS),
        reference: z.string().trim().max(100).optional(),
        notes: z.string().trim().max(500).optional(),
        paidAt: z.coerce.date().optional(),
        idempotencyKey: z.string().trim().min(8).max(100).optional(),
      })
      .strict()
      .refine((d) => Boolean(d.allocations) !== Boolean(d.amount), { message: 'Provide either allocations or amount', path: ['amount'] }),
  }),
  async (req, res) => {
    const receipt = await payments.collectPayment(req.tenant, req.body, auditContext(req));
    return receipt.replayed ? ok(res, receipt, { message: 'Payment already recorded' }) : created(res, receipt, 'Payment recorded');
  },
);
router.get(
  '/payments',
  P('read'),
  validate({
    query: paginationQuery.extend({
      from: dateOnly.optional(),
      to: dateOnly.optional(),
      method: z.enum(PAYMENT_METHODS).optional(),
      source: z.enum(['offline', 'online']).optional(),
      status: z.enum(['completed', 'partially_refunded', 'refunded']).optional(),
      studentId: objectId.optional(),
      search: z.string().trim().max(30).optional(),
    }),
  }),
  async (req, res) => list(res, await payments.listPayments(req.tenant, req.validatedQuery)),
);
router.get('/payments/:id/receipt', P('read'), validate({ params: id }), async (req, res) => ok(res, await payments.getReceipt(req.tenant, req.params.id)));
router.post(
  '/payments/:id/refund',
  P('refund'),
  validate({ params: id, body: z.object({ amount, reason: z.string().trim().min(3).max(300), method: z.enum(OFFLINE_METHODS).optional(), reference: z.string().trim().max(100).optional() }).strict() }),
  async (req, res) =>
    ok(res, await payments.refundPayment(req.tenant, req.params.id, req.body, auditContext(req), { gatewayRefund: (payment, amt) => gateway.gatewayRefund(req.tenant.schoolId, payment, amt) }), { message: 'Refund recorded' }),
);

/* ------------------------------ online payments ------------------------------ */
router.get('/gateway', P('read'), async (req, res) => ok(res, await gateway.getGatewaySettings(req.tenant.schoolId)));
router.put(
  '/gateway',
  requirePermission('fees.update', 'settings.update'),
  validate({
    body: z
      .object({
        keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'Use a Razorpay key id (rzp_test_… or rzp_live_…)').optional(),
        keySecret: z.string().trim().min(10).max(200).optional(),
        webhookSecret: z.string().trim().max(200).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => ok(res, await gateway.saveGatewaySettings(req.tenant, req.body, auditContext(req)), { message: 'Payment gateway saved' }),
);

/* ------------------------------ reminders ------------------------------ */
router.get('/reminders', P('read'), async (req, res) => ok(res, await reminders.reminderOverview(req.tenant)));
router.patch(
  '/reminders/settings',
  P('update'),
  validate({
    body: nonEmpty(
      z
        .object({
          enabled: z.boolean(),
          beforeDays: z.array(z.number().int().min(1).max(60)).max(6),
          onDueDate: z.boolean(),
          afterDays: z.array(z.number().int().min(1).max(120)).max(6),
          channels: channelList,
          sendHour: z.number().int().min(0).max(23),
        })
        .partial()
        .strict(),
    ),
  }),
  async (req, res) => {
    for (const k of ['beforeDays', 'afterDays', 'channels']) if (req.body[k]) req.body[k] = [...new Set(req.body[k])];
    if (req.body.channels) assertChannelsAvailable(req.body.channels);
    await School.updateOne({ _id: req.tenant.schoolId }, { $set: toDotPaths({ settings: { fees: { reminders: req.body } } }) }, { runValidators: true });
    await recordAudit({ ...auditContext(req), action: 'fees.reminder_settings_updated', entityType: 'School', entityId: req.tenant.schoolId, metadata: { changed: Object.keys(req.body), enabled: req.body.enabled } });
    return ok(res, (await reminders.reminderOverview(req.tenant)).settings, { message: 'Reminder settings saved' });
  },
);
router.post('/reminders/run', P('update'), async (req, res) => {
  const result = await reminders.runFeeReminders(req.tenant.schoolId, await invoices.schoolToday(req.tenant));
  return ok(res, result, { message: result.enabled ? 'Reminders processed' : 'Automatic reminders are turned off' });
});

/* ------------------------------ reports ------------------------------ */
router.get('/dashboard', P('read'), async (req, res) => ok(res, await reports.dashboard(req.tenant)));
router.get(
  '/defaulters',
  P('reports'),
  validate({ query: paginationQuery.extend({ sessionId: objectId.optional(), classId: objectId.optional(), sectionId: objectId.optional(), minAmount: z.coerce.number().int().min(1).optional() }) }),
  async (req, res) => list(res, await reports.defaulters(req.tenant, req.validatedQuery)),
);
router.get(
  '/reports/collections',
  P('reports'),
  validate({ query: z.object({ from: dateOnly, to: dateOnly, groupBy: z.enum(['day', 'method', 'category', 'class']).default('day') }).refine((q) => q.to >= q.from, { message: 'End date must be on or after the start date', path: ['to'] }) }),
  async (req, res) => ok(res, await reports.collections(req.tenant, req.validatedQuery)),
);
router.get('/reports/outstanding', P('reports'), validate({ query: z.object({ sessionId: objectId.optional() }) }), async (req, res) => ok(res, await reports.outstandingByClass(req.tenant, req.validatedQuery)));
router.get(
  '/reports/ledger',
  P('reports'),
  validate({ query: paginationQuery.extend({ from: dateOnly, to: dateOnly, account: z.enum(ACCOUNTS).optional() }) }),
  async (req, res) => list(res, await reports.ledger(req.tenant, req.validatedQuery)),
);

export default router;
