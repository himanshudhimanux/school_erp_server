import mongoose from 'mongoose';

/**
 * Rotating refresh tokens. Only the SHA-256 hash is stored.
 * A token can be exchanged exactly once (`usedAt`). Presenting a used token again means it
 * was stolen or replayed, so the whole session is revoked (reuse detection).
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
