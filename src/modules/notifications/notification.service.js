import { Notification, QUEUED_CHANNELS } from './notification.model.js';
import { DeviceToken, MAX_DEVICES_PER_USER } from './device.model.js';
import { Membership } from '../memberships/membership.model.js';
import { School } from '../schools/school.model.js';
import { sendMail } from '../../services/mail.service.js';
import { sendTwilioMessage, ProviderError } from '../../services/twilio.service.js';
import { sendPush } from '../../services/push.service.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ApiError } from '../../utils/ApiError.js';

const BATCH = 50;
const MAX_ATTEMPTS = 3;
const CLAIM_MS = 2 * 60 * 1000;
/** Background delivery runs, so scripts and shutdown can wait for them (settleBackgroundWork). */
const inFlight = new Set();
export const settleBackgroundWork = () => Promise.allSettled([...inFlight]);

/* ------------------------------ channels ------------------------------ */

export const CHANNEL_LABELS = Object.freeze({ in_app: 'App inbox', email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', push: 'Push notification' });

/** Whether the platform has a provider for each channel (independent of any school's choice). */
export function providerStatus() {
  return { in_app: true, email: env.emailConfigured, sms: env.smsConfigured, whatsapp: env.whatsappConfigured, push: env.pushConfigured };
}

/**
 * SMS, WhatsApp and push can be chosen only when the server has a provider for them, so a school
 * never believes it is sending messages that cannot go out. (Email may be chosen before Resend is set
 * up; those messages are recorded as EMAIL_NOT_CONFIGURED.)
 */
export function assertChannelsAvailable(channels) {
  const status = providerStatus();
  const missing = channels.filter((c) => ['sms', 'whatsapp', 'push'].includes(c) && !status[c]);
  if (missing.length) throw ApiError.badRequest(`${missing.map((c) => CHANNEL_LABELS[c]).join(', ')} is not set up on this server`, { code: 'CHANNEL_NOT_CONFIGURED', details: { channels: missing } });
}

/** Channels a school uses for automatic alerts (attendance, results). In-app is always on. */
export const DEFAULT_ALERT_CHANNELS = ['in_app', 'email', 'push'];
export async function alertChannels(schoolId) {
  const s = await School.findById(schoolId).select('settings.notifications').lean();
  const list = s?.settings?.notifications?.alertChannels;
  return [...new Set(['in_app', ...(list?.length ? list : DEFAULT_ALERT_CHANNELS)])];
}

/**
 * Builds notification documents for a batch of messages.
 * Each item: { recipient: { guardianId?, membershipId?, userId?, name, email?, phone? }, type, title, body, data, key }
 * where `key` is the dedupe prefix for that recipient and message. One document is created per
 * channel the recipient can be reached on; push only for users with a registered device.
 * A recipient reachable on none of the channels gets a single failed record (NO_CONTACT_CHANNEL).
 */
export async function buildDeliveries(schoolId, items, channels) {
  const wanted = new Set(channels);
  let pushUsers = new Set();
  if (wanted.has('push') && env.pushConfigured) {
    const missing = [...new Set(items.filter((i) => !i.recipient.userId && i.recipient.membershipId).map((i) => String(i.recipient.membershipId)))];
    if (missing.length) {
      const rows = await Membership.find({ schoolId, _id: { $in: missing }, status: 'active' }).select('userId').lean();
      const userBy = new Map(rows.map((m) => [String(m._id), m.userId]));
      for (const i of items) if (!i.recipient.userId && i.recipient.membershipId) i.recipient = { ...i.recipient, userId: userBy.get(String(i.recipient.membershipId)) || null };
    }
    const userIds = [...new Set(items.map((i) => i.recipient.userId).filter(Boolean).map(String))];
    if (userIds.length) pushUsers = new Set((await DeviceToken.distinct('userId', { userId: { $in: userIds } })).map(String));
  }
  const docs = [];
  for (const { recipient, type, title, body, data, key } of items) {
    const reach = {
      in_app: Boolean(recipient.membershipId),
      email: Boolean(recipient.email),
      sms: Boolean(recipient.phone),
      whatsapp: Boolean(recipient.phone),
      push: Boolean(recipient.userId && pushUsers.has(String(recipient.userId))),
    };
    const usable = [...wanted].filter((c) => reach[c]);
    if (!usable.length) {
      docs.push({ type, channel: 'none', recipient, title, body, data, error: 'NO_CONTACT_CHANNEL', dedupeKey: `${key}:none` });
      continue;
    }
    for (const c of usable) docs.push({ type, channel: c, recipient, title, body, data, dedupeKey: `${key}:${c}` });
  }
  return docs;
}

/* ------------------------------ queue ------------------------------ */

function kickQueue(schoolId) {
  const job = new Promise((resolve) => setImmediate(resolve))
    .then(() => processDeliveryQueue({ schoolId }))
    .catch((e) => logger.error({ err: e }, 'Notification delivery failed'))
    .finally(() => inFlight.delete(job));
  inFlight.add(job);
  return job;
}

/**
 * Inserts notifications, silently skipping any whose dedupeKey already exists.
 * In-app notifications are final immediately; email/SMS/WhatsApp/push are queued and delivered
 * in the background. Returns the number inserted.
 */
export async function queueNotifications(schoolId, docs) {
  if (!docs.length) return 0;
  const rows = docs.map((d) => ({
    ...d,
    schoolId,
    status: d.status || (d.channel === 'in_app' ? 'sent' : QUEUED_CHANNELS.includes(d.channel) ? 'queued' : 'failed'),
    sentAt: d.channel === 'in_app' ? new Date() : null,
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    try {
      inserted += (await Notification.insertMany(chunk, { ordered: false })).length;
    } catch (err) {
      // Duplicate keys mean "already notified"; anything else is a real error.
      if (err?.code !== 11000 && !err?.writeErrors?.every?.((e) => e.code === 11000)) throw err;
      inserted += err.insertedDocs?.length ?? err.result?.insertedCount ?? 0;
    }
  }
  if (rows.some((r) => r.status === 'queued')) kickQueue(schoolId);
  return inserted;
}

const SHORT_CODES = new Set(['EMAIL_NOT_CONFIGURED', 'SMS_NOT_CONFIGURED', 'WHATSAPP_NOT_CONFIGURED', 'PUSH_NOT_CONFIGURED', 'NO_DEVICE', 'INVALID_PHONE', 'NO_EMAIL']);
const errorText = (err) => (err instanceof ProviderError ? (SHORT_CODES.has(err.code) ? err.code : `${err.code}: ${err.message}`) : String(err?.message || err)).slice(0, 300);

async function deliverPush(n) {
  if (!env.pushConfigured) throw new ProviderError('Push is not configured', { code: 'PUSH_NOT_CONFIGURED', permanent: true });
  const devices = n.recipient.userId ? await DeviceToken.find({ userId: n.recipient.userId }).select('token').lean() : [];
  if (!devices.length) throw new ProviderError('No registered device', { code: 'NO_DEVICE', permanent: true });
  const data = { type: n.type, notificationId: n._id, ...(n.data?.studentId ? { studentId: n.data.studentId } : {}) };
  let sent = null;
  let lastError = null;
  for (const d of devices) {
    try {
      const r = await sendPush({ token: d.token, title: n.title, body: n.body, data });
      sent = sent || r;
    } catch (err) {
      if (err.invalidToken) await DeviceToken.deleteOne({ _id: d._id });
      lastError = err;
    }
  }
  if (sent) return sent;
  throw lastError;
}

async function deliverOne(n) {
  switch (n.channel) {
    case 'email':
      if (!env.emailConfigured) throw new ProviderError('Email is not configured', { code: 'EMAIL_NOT_CONFIGURED', permanent: true });
      if (!n.recipient.email) throw new ProviderError('No email address', { code: 'NO_EMAIL', permanent: true });
      return { providerMessageId: (await sendMail({ to: n.recipient.email, subject: n.title, text: n.body, idempotencyKey: `notification-${n._id}` })).messageId };
    case 'sms':
    case 'whatsapp':
      if (!n.recipient.phone) throw new ProviderError('No phone number', { code: 'INVALID_PHONE', permanent: true });
      return sendTwilioMessage({ channel: n.channel, to: n.recipient.phone, body: n.body });
    case 'push':
      return deliverPush(n);
    default:
      throw new ProviderError(`Unsupported channel ${n.channel}`, { permanent: true });
  }
}

/**
 * Delivers queued notifications. A channel without a configured provider fails immediately with
 * <CHANNEL>_NOT_CONFIGURED so the school sees the real status; temporary provider errors are
 * retried with backoff (1, 5 minutes) up to three attempts. Each message is claimed before it
 * is sent, so overlapping runs never send it twice.
 * Called after queuing, by the hourly scheduler and on server start (schoolId omitted = every school).
 */
export async function processDeliveryQueue({ schoolId } = {}) {
  let processed = 0;
  for (;;) {
    const now = new Date();
    const filter = {
      status: 'queued',
      channel: { $in: QUEUED_CHANNELS },
      attempts: { $lt: MAX_ATTEMPTS },
      $and: [{ $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }, { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] }],
    };
    if (schoolId) filter.schoolId = schoolId;
    const batch = await Notification.find(filter).setOptions({ skipTenantCheck: !schoolId }).sort({ createdAt: 1 }).limit(BATCH).lean();
    if (!batch.length) break;
    for (const candidate of batch) {
      const n = await Notification.findOneAndUpdate(
        { _id: candidate._id, schoolId: candidate.schoolId, status: 'queued', $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
        { $set: { lockedUntil: new Date(Date.now() + CLAIM_MS) } },
        { returnDocument: 'after' },
      ).lean();
      if (!n) continue;
      const scope = { _id: n._id, schoolId: n.schoolId };
      try {
        const r = await deliverOne(n);
        await Notification.updateOne(scope, {
          $set: { status: 'sent', sentAt: new Date(), lockedUntil: null, nextAttemptAt: null, ...(r?.providerMessageId ? { providerMessageId: r.providerMessageId } : {}) },
          $inc: { attempts: 1 },
          $unset: { error: 1 },
        });
      } catch (err) {
        const attempts = (n.attempts || 0) + 1;
        const final = err?.permanent || attempts >= MAX_ATTEMPTS;
        await Notification.updateOne(scope, {
          $set: { status: final ? 'failed' : 'queued', error: errorText(err), attempts, lockedUntil: null, nextAttemptAt: final ? null : new Date(Date.now() + 60_000 * 5 ** (attempts - 1)) },
        });
      }
      processed += 1;
    }
    if (batch.length < BATCH) break;
  }
  return processed;
}

/** Former name, kept for callers from earlier phases. */
export const processEmailQueue = processDeliveryQueue;

/** Cancels notifications that have not gone out yet (e.g. an absence corrected to present). */
export function cancelUnsent(schoolId, filter) {
  return Notification.updateMany({ schoolId, ...filter, status: { $in: ['pending', 'queued'] } }, { status: 'cancelled' });
}

/** Puts a failed email/SMS/WhatsApp/push notification back in the queue. */
export async function retryNotification(schoolId, id) {
  const n = await Notification.findOneAndUpdate(
    { _id: id, schoolId, status: 'failed', channel: { $in: QUEUED_CHANNELS } },
    { $set: { status: 'queued', attempts: 0, nextAttemptAt: null, lockedUntil: null }, $unset: { error: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!n) {
    const exists = await Notification.exists({ _id: id, schoolId });
    if (!exists) throw ApiError.notFound('Notification not found');
    throw ApiError.badRequest('Only failed email, SMS, WhatsApp or push notifications can be retried', { code: 'NOT_RETRYABLE' });
  }
  await kickQueue(schoolId);
  return Notification.findOne({ _id: id, schoolId }).lean();
}

/**
 * Applies a delivery receipt from Twilio. Statuses only move forward: a late "sent" callback
 * never overwrites "delivered".
 */
export async function applyProviderReceipt(providerMessageId, providerStatus, errorCode) {
  const n = await Notification.findOne({ providerMessageId }).setOptions({ skipTenantCheck: true }).lean();
  if (!n) return { matched: false };
  const scope = { _id: n._id, schoolId: n.schoolId };
  if (['delivered', 'read'].includes(providerStatus)) {
    await Notification.updateOne({ ...scope, status: { $in: ['queued', 'sent'] } }, { $set: { status: 'delivered', deliveredAt: new Date() } });
  } else if (['failed', 'undelivered'].includes(providerStatus)) {
    await Notification.updateOne({ ...scope, status: { $in: ['queued', 'sent'] } }, { $set: { status: 'failed', error: `PROVIDER_${providerStatus.toUpperCase()}${errorCode ? `: ${errorCode}` : ''}` } });
  }
  return { matched: true };
}

/* ------------------------------ inbox ------------------------------ */

export async function listInbox(tenant, { page, limit, unread }) {
  const filter = { schoolId: tenant.schoolId, channel: 'in_app', 'recipient.membershipId': tenant.membershipId, status: { $ne: 'cancelled' } };
  if (unread) filter.readAt = null;
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).select('type title body data status readAt createdAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit), unread: unreadCount } };
}

export async function markRead(tenant, id) {
  const r = await Notification.updateOne(
    { _id: id, schoolId: tenant.schoolId, channel: 'in_app', 'recipient.membershipId': tenant.membershipId },
    { $set: { readAt: new Date() } },
  );
  if (!r.matchedCount) throw ApiError.notFound('Notification not found');
}

export async function markAllRead(tenant) {
  const r = await Notification.updateMany(
    { schoolId: tenant.schoolId, channel: 'in_app', 'recipient.membershipId': tenant.membershipId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { updated: r.modifiedCount };
}

/* ------------------------------ devices ------------------------------ */

/** Registers (or moves) a push token to the signed-in user, keeping at most MAX_DEVICES_PER_USER devices per user. */
export async function registerDevice(userId, { token, platform }) {
  await DeviceToken.findOneAndUpdate({ token }, { $set: { userId, platform, lastSeenAt: new Date() } }, { upsert: true, setDefaultsOnInsert: true });
  const extra = await DeviceToken.find({ userId }).sort({ lastSeenAt: -1 }).skip(MAX_DEVICES_PER_USER).select('_id').lean();
  if (extra.length) await DeviceToken.deleteMany({ _id: { $in: extra.map((d) => d._id) } });
}

export async function unregisterDevice(userId, token) {
  const r = await DeviceToken.deleteOne({ userId, token });
  return { removed: r.deletedCount };
}
