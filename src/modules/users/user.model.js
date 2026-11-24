import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { PLATFORM_ROLES } from '../../constants/roles.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, unique: true },
    phone: { type: String, trim: true, maxlength: 20, default: null },
    passwordHash: { type: String, required: true, select: false },
    platformRole: { type: String, enum: [...Object.values(PLATFORM_ROLES), null], default: null },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
    emailVerifiedAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.failedLoginAttempts;
        delete ret.lockUntil;
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSchema.index({ phone: 1 }, { sparse: true });

userSchema.virtual('isEmailVerified').get(function isEmailVerified() {
  return Boolean(this.emailVerifiedAt);
});

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, env.BCRYPT_ROUNDS);
  if (!this.isNew) this.passwordChangedAt = new Date();
};

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil > new Date());
};

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    platformRole: this.platformRole,
    status: this.status,
    isEmailVerified: Boolean(this.emailVerifiedAt),
    lastLoginAt: this.lastLoginAt,
  };
};

export const User = mongoose.model('User', userSchema);
