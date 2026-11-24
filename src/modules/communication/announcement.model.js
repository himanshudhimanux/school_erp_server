import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { SELECTABLE_CHANNELS } from '../notifications/notification.model.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A message from the school to a group of people.
 *
 *  kind      announcement  delivered once to the inbox (and any other chosen channels)
 *            notice        also stays on the notice board until `expiresAt` (or forever)
 *  audience  scope: everyone | staff | families (parents + students) | parents | students
 *            classIds / sectionIds narrow family scopes to those classes or sections (either
 *            matches); campusId narrows any scope to one campus.
 *  status    draft → scheduled → sending → sent; scheduled can go back to draft; drafts can be cancelled
 */
export const ANNOUNCEMENT_KINDS = ['announcement', 'notice'];
export const AUDIENCE_SCOPES = ['everyone', 'staff', 'families', 'parents', 'students'];
export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled'];

const announcementSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ANNOUNCEMENT_KINDS, default: 'announcement' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    audience: {
      scope: { type: String, enum: AUDIENCE_SCOPES, required: true },
      classIds: { type: [{ type: ObjectId, ref: 'SchoolClass' }], default: [] },
      sectionIds: { type: [{ type: ObjectId, ref: 'Section' }], default: [] },
    },
    campusId: { type: ObjectId, ref: 'Campus', default: null },
    channels: { type: [{ type: String, enum: SELECTABLE_CHANNELS }], default: ['in_app'] },
    status: { type: String, enum: ANNOUNCEMENT_STATUSES, default: 'draft' },
    scheduledAt: { type: Date, default: null },
    sendingStartedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    pinned: { type: Boolean, default: false },
    stats: {
      recipients: { type: Number, default: 0 },
      notifications: { type: Number, default: 0 },
      unreachable: { type: Number, default: 0 },
    },
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
    sentBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
announcementSchema.plugin(tenantPlugin);
announcementSchema.index({ schoolId: 1, status: 1, scheduledAt: 1 });
announcementSchema.index({ schoolId: 1, kind: 1, status: 1, sentAt: -1 });
announcementSchema.index({ status: 1, scheduledAt: 1 });
export const Announcement = mongoose.model('Announcement', announcementSchema);
