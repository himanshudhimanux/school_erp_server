import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly } from '../../utils/dates.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { hasStaffRole } from '../students/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { registerDeleteGuard, countGuard } from '../../utils/dependencyGuards.js';
import { BookIssue } from './library.models.js';
import * as svc from './library.service.js';

registerDeleteGuard('student', countGuard((schoolId, id) => BookIssue.countDocuments({ schoolId, studentId: id, $or: [{ status: 'issued' }, { fineStatus: 'pending' }] }), (n) => `they have ${n} library loan(s) or unpaid fine(s)`));
registerDeleteGuard('member', countGuard((schoolId, id) => BookIssue.countDocuments({ schoolId, membershipId: id, status: 'issued' }), (n) => `they have ${n} library book(s) on loan`));

const router = Router();
// Desk operations are for staff; families see their own loans through /portal/library.
router.use((req, _res, next) => (hasStaffRole(req.tenant) ? next() : next(ApiError.forbidden('Use the family portal', { code: 'STAFF_ONLY' }))));

const id = z.object({ id: objectId });
const text = (max) => z.string().trim().max(max);
const bookFields = { title: z.string().trim().min(1).max(200), author: text(150), isbn: text(20), publisher: text(120), category: text(60), edition: text(40), shelf: text(40), copies: z.number().int().min(0).max(10000), status: z.enum(['active', 'inactive']) };

router.get('/summary', requirePermission('library.read'), async (req, res) => ok(res, await svc.librarySummary(req.tenant)));
router.get('/settings', requirePermission('library.read'), async (req, res) => ok(res, await svc.librarySettings(req.tenant.schoolId)));
router.patch(
  '/settings',
  requirePermission('library.update'),
  validate({ body: z.object({ loanDays: z.number().int().min(1).max(120), maxBooksStudent: z.number().int().min(1).max(20), maxBooksStaff: z.number().int().min(1).max(50), finePerDay: z.number().int().min(0).max(100000), fineCategoryId: objectId.nullable() }).partial().strict().refine((d) => Object.keys(d).length > 0, 'Provide at least one setting') }),
  async (req, res) => ok(res, await svc.updateLibrarySettings(req.tenant, req.body, auditContext(req)), { message: 'Library settings saved' }),
);

router.get('/books', requirePermission('library.read'), validate({ query: paginationQuery.extend({ search: text(100).optional(), category: text(60).optional(), available: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), status: z.enum(['active', 'inactive']).optional() }) }), async (req, res) => {
  const { items, meta } = await svc.listBooks(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.post('/books', requirePermission('library.create'), validate({ body: z.object(bookFields).partial({ author: true, isbn: true, publisher: true, category: true, edition: true, shelf: true, status: true }).strict() }), async (req, res) =>
  created(res, await svc.createBook(req.tenant, req.body, auditContext(req)), 'Book added'),
);
router.patch('/books/:id', requirePermission('library.update'), validate({ params: id, body: z.object(bookFields).partial().strict().refine((d) => Object.keys(d).length > 0, 'Provide at least one field') }), async (req, res) =>
  ok(res, await svc.updateBook(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Book updated' }),
);
router.delete('/books/:id', requirePermission('library.delete'), validate({ params: id }), async (req, res) => {
  await svc.deleteBook(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Book removed' });
});

router.get(
  '/issues',
  requirePermission('library.read'),
  validate({ query: paginationQuery.extend({ status: z.enum(['issued', 'returned', 'lost', 'overdue']).optional(), studentId: objectId.optional(), membershipId: objectId.optional(), bookId: objectId.optional(), fineStatus: z.enum(['none', 'pending', 'charged', 'waived']).optional() }) }),
  async (req, res) => {
    const { items, meta } = await svc.listIssues(req.tenant, req.validatedQuery);
    return ok(res, items, { meta });
  },
);
router.post(
  '/issues',
  requirePermission('library.issue'),
  validate({ body: z.object({ bookId: objectId, studentId: objectId.optional(), membershipId: objectId.optional(), dueDate: dateOnly.optional(), note: text(300).optional() }).strict().refine((d) => Boolean(d.studentId) !== Boolean(d.membershipId), { message: 'Choose a student or a staff member', path: ['studentId'] }) }),
  async (req, res) => created(res, await svc.issueBook(req.tenant, req.body, auditContext(req)), 'Book issued'),
);
router.post('/issues/:id/return', requirePermission('library.issue'), validate({ params: id, body: z.object({ waiveFine: z.boolean().optional(), note: text(300).optional() }).strict() }), async (req, res) =>
  ok(res, await svc.returnBook(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Book returned' }),
);
router.post('/issues/:id/lost', requirePermission('library.issue'), validate({ params: id, body: z.object({ charge: z.number().int().min(0).max(10_000_000).optional(), note: text(300).optional() }).strict() }), async (req, res) =>
  ok(res, await svc.markLost(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Marked as lost' }),
);
router.post('/issues/:id/waive-fine', requirePermission('library.update'), validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(300) }).strict() }), async (req, res) =>
  ok(res, await svc.waiveFine(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Fine waived' }),
);
router.post('/issues/:id/charge-fine', requirePermission('library.update'), validate({ params: id }), async (req, res) =>
  ok(res, await svc.chargeFine(req.tenant, req.params.id, auditContext(req)), { message: 'Fine added to fees' }),
);

export default router;
