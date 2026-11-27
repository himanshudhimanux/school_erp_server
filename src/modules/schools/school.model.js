import mongoose from 'mongoose';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';

export const INSTITUTION_TYPES = ['school', 'college', 'coaching', 'preschool', 'other'];
export const SCHOOL_STATUSES = ['active', 'suspended', 'cancelled'];
/** Statuses whose members may use the tenant API. */
export const USABLE_SCHOOL_STATUSES = ['active'];
export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];

/**
 * The tenant root. Not tenant-scoped itself; access is controlled through Membership.
 * Campuses (Campus) and entitlements (Subscription) reference it by schoolId; trials live on the Subscription.
 */
const schoolSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 40,
      match: [/^[a-z0-9][a-z0-9-]*$/, 'Code may contain lowercase letters, digits and hyphens'],
    },
    type: { type: String, enum: INSTITUTION_TYPES, default: 'school' },
    status: { type: String, enum: SCHOOL_STATUSES, default: 'active', index: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20 },
    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      line2: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      postalCode: { type: String, trim: true, maxlength: 20 },
      country: { type: String, trim: true, maxlength: 100, default: 'India' },
    },
    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, default: 'INR', uppercase: true, minlength: 3, maxlength: 3 },
    settings: {
      dateFormat: { type: String, enum: DATE_FORMATS, default: 'DD/MM/YYYY' },
      weekStartsOn: { type: Number, min: 0, max: 6, default: 1 },
      academicYearStartMonth: { type: Number, min: 1, max: 12, default: 4 },
      attendance: {
        // Weekly days off (0 = Sunday … 6 = Saturday); attendance is not taken on these days.
        weeklyOffDays: { type: [{ type: Number, min: 0, max: 6 }], default: [0] },
        // How many past days a teacher (attendance.mark without attendance.update) may still edit. 0 = today only.
        teacherEditDays: { type: Number, min: 0, max: 30, default: 1 },
        absentAlerts: { type: Boolean, default: true },
        alertOnLate: { type: Boolean, default: false },
        lowAttendanceThreshold: { type: Number, min: 1, max: 100, default: 75 },
      },
      library: {
        loanDays: { type: Number, min: 1, max: 120 },
        maxBooksStudent: { type: Number, min: 1, max: 20 },
        maxBooksStaff: { type: Number, min: 1, max: 50 },
        finePerDay: { type: Number, min: 0 },
        // Most a single late return can be fined (minor units); null = no cap.
        maxFine: { type: Number, min: 1, default: null },
        fineCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeCategory', default: null },
      },
      hr: {
        leaveQuota: { casual: Number, sick: Number, earned: Number, other: Number },
      },
      fees: {
        reminders: {
          enabled: { type: Boolean, default: false },
          // Days before the due date to remind (e.g. 7, 3, 1).
          beforeDays: { type: [{ type: Number, min: 1, max: 60 }], default: [3, 1] },
          onDueDate: { type: Boolean, default: true },
          // Days after the due date while unpaid (e.g. 3, 7, 15).
          afterDays: { type: [{ type: Number, min: 1, max: 120 }], default: [3, 7] },
          channels: { type: [{ type: String, enum: ['in_app', 'email', 'sms', 'whatsapp', 'push'] }], default: ['in_app', 'email'] },
          // Local hour (school timezone) from which the daily run may send.
          sendHour: { type: Number, min: 0, max: 23, default: 9 },
        },
      },
      notifications: {
        // Channels for automatic alerts (absences, results). In-app is always included.
        alertChannels: { type: [{ type: String, enum: ['in_app', 'email', 'sms', 'whatsapp', 'push'] }], default: undefined },
      },
      branding: {
        primaryColor: { type: String, match: /^#[0-9a-fA-F]{6}$/, default: '#2563EB' },
        logoUrl: { type: String, maxlength: 500, default: null },
      },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

schoolSchema.plugin(softDeletePlugin);
schoolSchema.index({ code: 1 }, { unique: true });

export const School = mongoose.model('School', schoolSchema);
