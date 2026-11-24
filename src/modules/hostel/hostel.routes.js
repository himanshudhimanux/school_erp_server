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
import * as svc from './hostel.service.js';

registerDeleteGuard('student', countGuard((schoolId, id) => svc.HostelAllocation.countDocuments({ schoolId, studentId: id }), (n) => `they have ${n} hostel allocation(s)`));
registerDeleteGuard('member', countGuard((schoolId, id) => svc.Hostel.countDocuments({ schoolId, wardenId: id }), (n) => `they are warden of ${n} hostel(s)`));

const router = Router();
router.use((req, _res, next) => (hasStaffRole(req.tenant) ? next() : next(ApiError.forbidden('Use the family portal', { code: 'STAFF_ONLY' }))));

const id = z.object({ id: objectId });
const nonEmpty = (s) => s.refine((d) => Object.keys(d).length > 0, 'Provide at least one field');
const hostelFields = { name: z.string().trim().min(2).max(100), type: z.enum(['boys', 'girls', 'mixed']), wardenId: objectId.nullable(), address: z.string().trim().max(200), status: z.enum(['active', 'inactive']) };
const roomFields = { number: z.string().trim().min(1).max(20), floor: z.string().trim().max(20), capacity: z.number().int().min(1).max(50), status: z.enum(['active', 'inactive']) };

router.get('/', requirePermission('hostel.read'), async (req, res) => ok(res, await svc.listHostels(req.tenant)));
router.post('/', requirePermission('hostel.create'), validate({ body: z.object(hostelFields).partial({ wardenId: true, address: true, status: true }).strict() }), async (req, res) =>
  created(res, await svc.saveHostel(req.tenant, null, req.body, auditContext(req)), 'Hostel created'),
);
router.patch('/:id', requirePermission('hostel.update'), validate({ params: id, body: nonEmpty(z.object(hostelFields).partial().strict()) }), async (req, res) =>
  ok(res, await svc.saveHostel(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Hostel updated' }),
);
router.delete('/:id', requirePermission('hostel.delete'), validate({ params: id }), async (req, res) => {
  await svc.deleteHostel(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Hostel deleted' });
});
router.post('/:id/rooms', requirePermission('hostel.create'), validate({ params: id, body: z.object(roomFields).partial({ floor: true, status: true }).strict() }), async (req, res) =>
  created(res, await svc.createRoom(req.tenant, req.params.id, req.body, auditContext(req)), 'Room added'),
);
router.patch('/rooms/:id', requirePermission('hostel.update'), validate({ params: id, body: nonEmpty(z.object(roomFields).partial().strict()) }), async (req, res) =>
  ok(res, await svc.updateRoom(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Room updated' }),
);
router.delete('/rooms/:id', requirePermission('hostel.delete'), validate({ params: id }), async (req, res) => {
  await svc.deleteRoom(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Room deleted' });
});

router.get('/allocations/list', requirePermission('hostel.read'), validate({ query: paginationQuery.extend({ hostelId: objectId.optional(), roomId: objectId.optional(), studentId: objectId.optional(), status: z.enum(['active', 'ended']).optional() }) }), async (req, res) => {
  const { items, meta } = await svc.listAllocations(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.post('/allocations', requirePermission('hostel.update'), validate({ body: z.object({ studentId: objectId, roomId: objectId, fromDate: dateOnly.optional(), note: z.string().trim().max(300).optional() }).strict() }), async (req, res) =>
  created(res, await svc.allocate(req.tenant, req.body, auditContext(req)), 'Room allocated'),
);
router.post('/allocations/:id/vacate', requirePermission('hostel.update'), validate({ params: id, body: z.object({ toDate: dateOnly.optional(), note: z.string().trim().max(300).optional() }).strict() }), async (req, res) =>
  ok(res, await svc.vacate(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Room vacated' }),
);

export default router;
