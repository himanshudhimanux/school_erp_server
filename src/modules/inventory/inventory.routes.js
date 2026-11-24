import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import * as svc from './inventory.service.js';

const router = Router();
const id = z.object({ id: objectId });
const text = (max) => z.string().trim().max(max);
const qty = z.number().int().min(0).max(10_000_000);
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{0,29}$/, 'Code may contain letters, digits and hyphens');
const fields = { name: z.string().trim().min(2).max(120), code, category: text(60), unit: text(20), reorderLevel: qty, location: text(80), status: z.enum(['active', 'inactive']) };

router.get('/items', requirePermission('inventory.read'), validate({ query: paginationQuery.extend({ search: text(100).optional(), category: text(60).optional(), lowStock: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), status: z.enum(['active', 'inactive']).optional() }) }), async (req, res) => {
  const { items, meta } = await svc.listItems(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.post('/items', requirePermission('inventory.create'), validate({ body: z.object({ ...fields, openingQuantity: qty }).partial({ category: true, unit: true, reorderLevel: true, location: true, status: true, openingQuantity: true }).strict() }), async (req, res) =>
  created(res, await svc.createItem(req.tenant, req.body, auditContext(req)), 'Item added'),
);
router.patch('/items/:id', requirePermission('inventory.update'), validate({ params: id, body: z.object(fields).partial().strict().refine((d) => Object.keys(d).length > 0, 'Provide at least one field') }), async (req, res) =>
  ok(res, await svc.updateItem(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Item updated' }),
);
router.delete('/items/:id', requirePermission('inventory.delete'), validate({ params: id }), async (req, res) => {
  await svc.deleteItem(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Item removed' });
});
router.post(
  '/items/:id/movements',
  requirePermission('inventory.update'),
  validate({
    params: id,
    body: z
      .object({ type: z.enum(svc.MOVEMENT_TYPES), quantity: z.number().int().min(1).max(10_000_000).optional(), countedQuantity: qty.optional(), unitCost: z.number().int().min(0).max(1_000_000_000).optional(), reference: text(80).optional(), issuedTo: text(120).optional(), note: text(300).optional() })
      .strict()
      .refine((d) => (d.type === 'adjust' ? d.countedQuantity !== undefined : d.quantity !== undefined), { message: 'Give a quantity (or the counted quantity for an adjustment)', path: ['quantity'] })
      .refine((d) => d.type !== 'adjust' || Boolean(d.note), { message: 'Explain the adjustment', path: ['note'] }),
  }),
  async (req, res) => created(res, await svc.moveStock(req.tenant, req.params.id, req.body, auditContext(req)), 'Stock updated'),
);
router.get('/movements', requirePermission('inventory.read'), validate({ query: paginationQuery.extend({ itemId: objectId.optional(), type: z.enum(svc.MOVEMENT_TYPES).optional() }) }), async (req, res) => {
  const { items, meta } = await svc.listMovements(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});

export default router;
