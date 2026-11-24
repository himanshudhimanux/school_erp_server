import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { auditContext } from '../audit/audit.service.js';
import * as v from './campus.validators.js';
import * as svc from './campus.service.js';

const router = Router();

router.get('/', requirePermission('campuses.read'), validate({ query: v.listCampusQuery }), async (req, res) => {
  const { items, meta } = await svc.listCampuses(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});

router.post('/', requirePermission('campuses.create'), validate({ body: v.createCampusSchema }), async (req, res) => {
  const campus = await svc.createCampus(req.tenant, req.body, auditContext(req));
  return created(res, campus, 'Campus created');
});

router.get('/:campusId', requirePermission('campuses.read'), validate({ params: v.campusIdParams }), async (req, res) => {
  return ok(res, await svc.getCampus(req.tenant, req.params.campusId));
});

router.patch('/:campusId', requirePermission('campuses.update'), validate({ params: v.campusIdParams, body: v.updateCampusSchema }), async (req, res) => {
  const campus = await svc.updateCampus(req.tenant, req.params.campusId, req.body, auditContext(req));
  return ok(res, campus, { message: 'Campus updated' });
});

router.delete('/:campusId', requirePermission('campuses.delete'), validate({ params: v.campusIdParams }), async (req, res) => {
  const result = await svc.deleteCampus(req.tenant, req.params.campusId, auditContext(req));
  return ok(res, result, { message: 'Campus deleted' });
});

export default router;
