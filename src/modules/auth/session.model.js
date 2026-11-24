import mongoose from 'mongoose';

/**
 * One login = one session (device). Refresh tokens rotate within a session;
 * revoking the session invalidates its access tokens on the next request.
 */
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Active tenant chosen for this session. Always validated against Membership on use.
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
    client: { type: String, enum: ['web', 'mobile'], default: 'web' },
    userAgent: { type: String, maxlength: 500 },
    ip: { type: String, maxlength: 64 },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, enum: ['logout', 'logout_all', 'revoked', 'token_reuse', 'password_change', 'password_reset', null], default: null },
  },
  { timestamps: true },
);

sessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });
// Clean up long-dead sessions a week after expiry.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

sessionSchema.methods.isActive = function isActive() {
  return !this.revokedAt && this.expiresAt > new Date();
};

export const Session = mongoose.model('Session', sessionSchema);
