import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * One notification delivery: one recipient on one channel.
 *
 *  channel  in_app  stored for the recipient's portal inbox (sent on creation)
 *           email   delivered by the mail service (queued → sent | failed)
 *           sms, whatsapp  delivered through Twilio; 'delivered' only after the provider's receipt
 *           push    delivered through FCM to the recipient's registered devices
 *           none    the recipient could not be reached (status failed, see `error`)
 *  status   pending | queued | sent | delivered (only when a provider confirms) | failed | cancelled
 *
 * `dedupeKey` is unique per school, so the same event never notifies the same person twice
 * (e.g. re-submitting attendance or refreshing a page).
 */
export const CHANNELS = ['in_app', 'email', 'sms', 'whatsapp', 'push', 'none'];
/** Channels a school or an announcement may choose. */
export const SELECTABLE_CHANNELS = ['in_app', 'email', 'sms', 'whatsapp', 'push'];
/** Channels delivered by the background queue (in_app is final on creation). */
export const QUEUED_CHANNELS = ['email', 'sms', 'whatsapp', 'push'];
export const NOTIFICATION_STATUSES = ['pending', 'queued', 'sent', 'delivered', 'failed', 'cancelled'];

const notificationSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, maxlength: 60 },
    channel: { type: String, enum: CHANNELS, required: true },
    recipient: {
      guardianId: { type: ObjectId, ref: 'Guardian', default: null },
      membershipId: { type: ObjectId, ref: 'Membership', default: null },
      userId: { type: ObjectId, ref: 'User', default: null },
      phone: { type: String, maxlength: 20 },
      name: { type: String, maxlength: 120 },
      email: { type: String, maxlength: 254 },
    },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    data: {
      studentId: { type: ObjectId, ref: 'Student' },
      sectionId: { type: ObjectId, ref: 'Section' },
      date: { type: Date },
      invoiceId: { type: ObjectId, ref: 'FeeInvoice' },
      announcementId: { type: ObjectId, ref: 'Announcement' },
    },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'pending' },
    error: { type: String, maxlength: 300 },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    // Retry scheduling and a short claim so two queue runs never send the same message twice.
    nextAttemptAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    providerMessageId: { type: String, maxlength: 200 },
    readAt: { type: Date, default: null },
    dedupeKey: { type: String, required: true, maxlength: 200 },
  },
  { timestamps: true },
);
notificationSchema.plugin(tenantPlugin);
notificationSchema.index({ schoolId: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ schoolId: 1, 'recipient.membershipId': 1, channel: 1, createdAt: -1 });
notificationSchema.index({ schoolId: 1, type: 1, 'data.date': 1, status: 1 });
notificationSchema.index({ schoolId: 1, 'data.studentId': 1, 'data.date': 1 });
notificationSchema.index({ status: 1, channel: 1, createdAt: 1 });
notificationSchema.index({ providerMessageId: 1 }, { sparse: true });
notificationSchema.index({ schoolId: 1, 'data.announcementId': 1, status: 1 });
notificationSchema.index({ schoolId: 1, createdAt: -1 });
export const Notification = mongoose.model('Notification', notificationSchema);
