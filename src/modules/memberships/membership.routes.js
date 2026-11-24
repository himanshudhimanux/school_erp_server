import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { paginationQuery } from '../../utils/pagination.js';
import { ok, created } from '../../utils/response.js';
import { SCHOOL_ROLE_VALUES, STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { objectId, email } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { MEMBERSHIP_STATUSES } from './membership.model.js';
import * as svc from './membership.service.js';
import { welcomeMessage } from './welcome.service.js';

const router = Router();

const listQuery = paginationQuery.extend({
  role: z.enum(SCHOOL_ROLE_VALUES).optional(),
  customRoleId: objectId.optional(),
  campusId: objectId.optional(),
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
});

const staffRoles = z.array(z.enum(STAFF_ROLE_VALUES)).max(6);
const idList = (max) => z.array(objectId).max(max);

const addSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email,
    phone: z.string().trim().max(20).optional(),
    roles: staffRoles.default([]),
    customRoleIds: idList(10).default([]),
    campusIds: idList(50).default([]),
  })
  .strict()
  .refine((d) => d.roles.length + d.customRoleIds.length > 0, { message: 'Assign at least one role', path: ['roles'] });

const updateSchema = z
  .object({
    roles: staffRoles.optional(),
    customRoleIds: idList(10).optional(),
    campusIds: idList(50).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const params = z.object({ memberId: objectId });

router.get('/', requirePermission('users.read'), validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await svc.listSchoolMembers(req.tenant.schoolId, req.validatedQuery);
  return ok(res, items, { meta });
});

router.post('/', requirePermission('users.create'), validate({ body: addSchema }), async (req, res) => {
  const result = await svc.addMember(req.tenant, req.body, auditContext(req));
  return created(res, result, `Member added. ${welcomeMessage({ isNew: result.isNewUser, ...result })}`);
});

router.get('/:memberId', requirePermission('users.read'), validate({ params }), async (req, res) => {
  return ok(res, await svc.getMember(req.tenant.schoolId, req.params.memberId));
});

router.patch('/:memberId', requirePermission('users.update'), validate({ params, body: updateSchema }), async (req, res) => {
  return ok(res, await svc.updateMember(req.tenant, req.params.memberId, req.body, auditContext(req)), { message: 'Member updated' });
});

router.delete('/:memberId', requirePermission('users.delete'), validate({ params }), async (req, res) => {
  await svc.removeMember(req.tenant, req.params.memberId, auditContext(req));
  return ok(res, null, { message: 'Member removed from school' });
});

export default router;
