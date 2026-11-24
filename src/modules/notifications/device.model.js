import mongoose from 'mongoose';

/**
 * A device registered for push notifications (an FCM registration token).
 * Belongs to the user, not to a school: the same phone receives pushes from every school the
 * user is a member of. A token moves to whoever registered it last (a shared or resold phone).
 */
export const DEVICE_PLATFORMS = ['android', 'web'];
export const MAX_DEVICES_PER_USER = 10;

const deviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true, maxlength: 4096 },
    platform: { type: String, enum: DEVICE_PLATFORMS, default: 'android' },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
deviceSchema.index({ token: 1 }, { unique: true });
deviceSchema.index({ userId: 1, lastSeenAt: -1 });
export const DeviceToken = mongoose.model('DeviceToken', deviceSchema);
