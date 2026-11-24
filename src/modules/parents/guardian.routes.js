import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { auditContext } from '../audit/audit.service.js';
import { guardianFields, newGuardianSchema, portalSchema, idParams } from '../students/student.validators.js';
import { nonEmpty, search } from '../common/person.validators.js';
import * as svc from './guardian.service.js';
import '../students/student.guards.js';

const router = Router();
const byId = validate({ params: idParams });

const listQuery = paginationQuery.extend({
  search,
  hasPortal: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
const updateSchema = nonEmpty(z.object(guardianFields).partial().strict());

router.get('/', requirePermission('parents.read'), validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await svc.listGuardians(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.post('/', requirePermission('parents.create'), validate({ body: newGuardianSchema }), async (req, res) =>
  created(res, await svc.createGuardian(req.tenant, req.body, auditContext(req)), 'Parent created'),
);
router.get('/:id', requirePermission('parents.read'), byId, async (req, res) => ok(res, await svc.getGuardian(req.tenant, req.params.id)));
router.patch('/:id', requirePermission('parents.update'), validate({ params: idParams, body: updateSchema }), async (req, res) =>
  ok(res, await svc.updateGuardian(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Parent updated' }),
);
router.delete('/:id', requirePermission('parents.delete'), byId, async (req, res) => {
  await svc.deleteGuardian(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Parent deleted' });
});

router.post('/:id/portal-access', requirePermission('parents.update', 'users.create'), validate({ params: idParams, body: portalSchema }), async (req, res) =>
  ok(res, await svc.grantGuardianPortal(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Portal access granted' }),
);
router.delete('/:id/portal-access', requirePermission('parents.update', 'users.update'), byId, async (req, res) =>
  ok(res, await svc.revokeGuardianPortal(req.tenant, req.params.id, auditContext(req)), { message: 'Portal access revoked' }),
);

export default router;
