import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { auditContext } from '../audit/audit.service.js';
import { objectId } from '../auth/auth.validators.js';
import { isValidPermission } from '../../constants/permissions.js';
import * as svc from './role.service.js';

const permissionList = z
  .array(z.string().refine(isValidPermission, (v) => ({ message: `Unknown permission: ${v}` })))
  .max(200);

const createSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9_]{1,49}$/, 'Key must start with a letter and contain lowercase letters, digits or underscores'),
    description: z.string().trim().max(300).optional(),
    permissions: permissionList.min(1, 'Select at least one permission'),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    permissions: permissionList.min(1, 'Select at least one permission').optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const params = z.object({ roleId: objectId });

const router = Router();

router.get('/', requirePermission('roles.read'), async (req, res) => ok(res, await svc.listRoles(req.tenant)));

router.get('/permissions', requirePermission('roles.read'), (req, res) => ok(res, svc.permissionCatalogue(req.tenant)));

router.post('/', requirePermission('roles.create'), validate({ body: createSchema }), async (req, res) => {
  return created(res, await svc.createRole(req.tenant, req.body, auditContext(req)), 'Role created');
});

router.get('/:roleId', requirePermission('roles.read'), validate({ params }), async (req, res) => {
  return ok(res, await svc.getRole(req.tenant.schoolId, req.params.roleId));
});

router.patch('/:roleId', requirePermission('roles.update'), validate({ params, body: updateSchema }), async (req, res) => {
  return ok(res, await svc.updateRole(req.tenant, req.params.roleId, req.body, auditContext(req)), { message: 'Role updated' });
});

router.delete('/:roleId', requirePermission('roles.delete'), validate({ params }), async (req, res) => {
  await svc.deleteRole(req.tenant, req.params.roleId, auditContext(req));
  return ok(res, null, { message: 'Role deleted' });
});

export default router;
