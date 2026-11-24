import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { paginationQuery } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import { objectId } from '../auth/auth.validators.js';
import { listSchoolAudit } from './audit.service.js';

const router = Router();

const listQuery = paginationQuery.extend({
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: objectId.optional(),
});

router.get('/', requirePermission('audit.read'), validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await listSchoolAudit(req.tenant.schoolId, req.validatedQuery);
  return ok(res, items, { meta });
});

export default router;
