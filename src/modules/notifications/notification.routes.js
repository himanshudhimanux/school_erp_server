import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { ok } from '../../utils/response.js';
import { ApiError } from '../../utils/ApiError.js';
import { DEVICE_PLATFORMS } from './device.model.js';
import { registerDevice, unregisterDevice, applyProviderReceipt } from './notification.service.js';
import { verifyTwilioSignature, statusCallbackUrl } from '../../services/twilio.service.js';

/**
 * Push device registration for the signed-in user (not school-scoped: one phone receives pushes
 * from every school the user belongs to). The app registers after sign-in and removes the token
 * on sign-out.
 */
export const deviceRoutes = Router();
deviceRoutes.use(authenticate);
const token = z.string().trim().min(20).max(4096);
deviceRoutes.post('/', validate({ body: z.object({ token, platform: z.enum(DEVICE_PLATFORMS).default('android') }).strict() }), async (req, res) => {
  await registerDevice(req.auth.userId, req.body);
  return ok(res, null, { message: 'Device registered for notifications' });
});
deviceRoutes.delete('/', validate({ body: z.object({ token }).strict() }), async (req, res) => ok(res, await unregisterDevice(req.auth.userId, req.body.token), { message: 'Device removed' }));

/**
 * Twilio delivery receipts (StatusCallback). Authenticated by X-Twilio-Signature over the
 * configured public callback URL and the posted fields.
 */
export const twilioWebhookRoutes = Router();
twilioWebhookRoutes.post('/status', async (req, res) => {
  const url = statusCallbackUrl();
  const params = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, String(v)]));
  if (!url || !verifyTwilioSignature(url, params, req.get('x-twilio-signature'))) throw ApiError.forbidden('Invalid signature', { code: 'INVALID_SIGNATURE' });
  if (!params.MessageSid || !params.MessageStatus) throw ApiError.badRequest('MessageSid and MessageStatus are required');
  const result = await applyProviderReceipt(params.MessageSid, params.MessageStatus, params.ErrorCode);
  return ok(res, result, { message: 'Receipt processed' });
});
