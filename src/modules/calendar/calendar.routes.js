import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { dateOnly } from '../../utils/dates.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { EVENT_TYPES } from './calendarEvent.model.js';
import * as svc from './calendar.service.js';

const router = Router();

const eventFields = {
  sessionId: objectId,
  title: z.string().trim().min(2).max(150),
  description: z.string().trim().max(1000),
  type: z.enum(EVENT_TYPES),
  startDate: dateOnly,
  endDate: dateOnly,
  campusIds: z.array(objectId).max(50),
};

const createSchema = z
  .object(eventFields)
  .partial({ description: true, type: true, campusIds: true, endDate: true })
  .strict()
  .transform((d) => ({ ...d, endDate: d.endDate ?? d.startDate }));

const { sessionId: _fixedSession, ...updatable } = eventFields;
const updateSchema = z
  .object(updatable)
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

const listQuery = z.object({
  sessionId: objectId.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  type: z.enum(EVENT_TYPES).optional(),
  campusId: objectId.optional(),
});
const params = z.object({ id: objectId });

router.get('/', requirePermission('calendar.read'), validate({ query: listQuery }), async (req, res) => ok(res, await svc.listEvents(req.tenant, req.validatedQuery)));
router.post('/', requirePermission('calendar.create'), validate({ body: createSchema }), async (req, res) =>
  created(res, await svc.createEvent(req.tenant, req.body, auditContext(req)), 'Event created'),
);
router.patch('/:id', requirePermission('calendar.update'), validate({ params, body: updateSchema }), async (req, res) =>
  ok(res, await svc.updateEvent(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Event updated' }),
);
router.delete('/:id', requirePermission('calendar.delete'), validate({ params }), async (req, res) => {
  await svc.deleteEvent(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Event deleted' });
});

export default router;
