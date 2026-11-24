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
import { SELECTABLE_CHANNELS, CHANNELS, NOTIFICATION_STATUSES } from '../notifications/notification.model.js';
import { TEMPLATE_KEYS } from '../notifications/templates.js';
import { ANNOUNCEMENT_KINDS, AUDIENCE_SCOPES, ANNOUNCEMENT_STATUSES } from './announcement.model.js';
import * as svc from './communication.service.js';

/**
 * Communication: announcements and notices, the notice board, notification history and retry,
 * delivery channels and message templates.
 *
 *   communication.read    notice board; staff also see announcements, channels and templates
 *   communication.create  write and edit drafts
 *   communication.send    send / schedule / cancel, notification history and retry
 *   settings.update       choose alert channels, edit message templates
 */
const router = Router();
const staffOnly = (req, _res, next) => (hasStaffRole(req.tenant) ? next() : next(ApiError.forbidden('Staff only', { code: 'STAFF_ONLY' })));
const id = z.object({ id: objectId });

/* ------------------------------ notice board (everyone) ------------------------------ */
router.get('/notices', requirePermission('communication.read'), validate({ query: paginationQuery }), async (req, res) => {
  const { items, meta } = await svc.noticeBoard(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});

router.use(staffOnly);

/* ------------------------------ announcements ------------------------------ */
const audience = z.object({
  scope: z.enum(AUDIENCE_SCOPES),
  classIds: z.array(objectId).max(50).optional(),
  sectionIds: z.array(objectId).max(100).optional(),
}).strict();
const futureDate = z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid date');
const fields = {
  kind: z.enum(ANNOUNCEMENT_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  audience,
  campusId: objectId.nullable(),
  channels: z.array(z.enum(SELECTABLE_CHANNELS)).min(1).max(5),
  expiresAt: futureDate.nullable(),
  pinned: z.boolean(),
};

router.get(
  '/announcements',
  requirePermission('communication.read'),
  validate({ query: paginationQuery.extend({ status: z.enum(ANNOUNCEMENT_STATUSES).optional(), kind: z.enum(ANNOUNCEMENT_KINDS).optional(), search: z.string().trim().max(100).optional() }) }),
  async (req, res) => {
    const { items, meta } = await svc.listAnnouncements(req.tenant, req.validatedQuery);
    return ok(res, items, { meta });
  },
);
router.post('/announcements', requirePermission('communication.create'), validate({ body: z.object(fields).partial({ kind: true, campusId: true, channels: true, expiresAt: true, pinned: true }).strict() }), async (req, res) =>
  created(res, await svc.createAnnouncement(req.tenant, req.body, auditContext(req)), 'Draft saved'),
);
router.get('/announcements/:id', requirePermission('communication.read'), validate({ params: id }), async (req, res) => ok(res, await svc.getAnnouncement(req.tenant, req.params.id)));
router.patch(
  '/announcements/:id',
  requirePermission('communication.create'),
  validate({ params: id, body: z.object(fields).partial().strict().refine((d) => Object.keys(d).length > 0, 'Provide at least one field') }),
  async (req, res) => ok(res, await svc.updateAnnouncement(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Announcement updated' }),
);
router.delete('/announcements/:id', requirePermission('communication.create'), validate({ params: id }), async (req, res) => {
  await svc.deleteAnnouncement(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Announcement deleted' });
});
router.post('/announcements/:id/send', requirePermission('communication.send'), validate({ params: id, body: z.object({ scheduledAt: futureDate.optional() }).strict() }), async (req, res) => {
  const result = await svc.sendAnnouncement(req.tenant, req.params.id, req.body, auditContext(req));
  return ok(res, result, { message: result.status === 'scheduled' ? 'Announcement scheduled' : `Sent to ${result.stats.recipients} recipient(s)` });
});
router.post('/announcements/:id/unschedule', requirePermission('communication.send'), validate({ params: id }), async (req, res) =>
  ok(res, await svc.unscheduleAnnouncement(req.tenant, req.params.id, auditContext(req)), { message: 'Moved back to draft' }),
);
router.post('/announcements/:id/cancel', requirePermission('communication.send'), validate({ params: id }), async (req, res) =>
  ok(res, await svc.cancelAnnouncement(req.tenant, req.params.id, auditContext(req)), { message: 'Announcement cancelled' }),
);

/* ------------------------------ notification history ------------------------------ */
router.get(
  '/notifications',
  requirePermission('communication.send'),
  validate({
    query: paginationQuery.extend({
      type: z.string().trim().regex(/^[a-z_.*]+$/).max(60).optional(),
      channel: z.enum(CHANNELS).optional(),
      status: z.enum([...NOTIFICATION_STATUSES, 'retrying']).optional(),
      from: dateOnly.optional(),
      to: dateOnly.optional(),
      search: z.string().trim().max(100).optional(),
      announcementId: objectId.optional(),
      studentId: objectId.optional(),
    }),
  }),
  async (req, res) => {
    const { items, meta } = await svc.listNotifications(req.tenant, req.validatedQuery);
    return ok(res, items, { meta });
  },
);
router.post('/notifications/:id/retry', requirePermission('communication.send'), validate({ params: id }), async (req, res) =>
  ok(res, await svc.retry(req.tenant, req.params.id, auditContext(req)), { message: 'Queued for another attempt' }),
);

/* ------------------------------ channels & templates ------------------------------ */
router.get('/channels', requirePermission('communication.read'), async (req, res) => ok(res, await svc.channelOverview(req.tenant)));
router.patch('/channels', requirePermission('settings.update'), validate({ body: z.object({ alertChannels: z.array(z.enum(SELECTABLE_CHANNELS)).min(1).max(5) }).strict() }), async (req, res) =>
  ok(res, await svc.updateChannelSettings(req.tenant, req.body, auditContext(req)), { message: 'Alert channels saved' }),
);

const templateKey = z.object({ key: z.enum(TEMPLATE_KEYS) });
router.get('/templates', requirePermission('communication.read'), async (req, res) => ok(res, await svc.listTemplates(req.tenant)));
router.put(
  '/templates/:key',
  requirePermission('settings.update'),
  validate({ params: templateKey, body: z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(1000) }).strict() }),
  async (req, res) => ok(res, await svc.saveTemplate(req.tenant, req.params.key, req.body, auditContext(req)), { message: 'Template saved' }),
);
router.delete('/templates/:key', requirePermission('settings.update'), validate({ params: templateKey }), async (req, res) =>
  ok(res, await svc.resetTemplate(req.tenant, req.params.key, auditContext(req)), { message: 'Template reset to default' }),
);

export default router;
