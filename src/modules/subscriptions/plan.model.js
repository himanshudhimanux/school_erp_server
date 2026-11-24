import mongoose from 'mongoose';
import { PLAN_MODULES } from '../../constants/modules.js';

/**
 * Platform-level subscription plan (not tenant-scoped). Plans are templates: when assigned,
 * their modules and limits are copied onto the school's Subscription, so editing a plan never
 * silently changes what existing customers have.
 */
export const limitsSchema = new mongoose.Schema(
  {
    // null = unlimited
    maxStudents: { type: Number, min: 0, default: null },
    maxCampuses: { type: Number, min: 1, default: null },
    maxUsers: { type: Number, min: 1, default: null },
  },
  { _id: false },
);

const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, required: true, trim: true, lowercase: true, maxlength: 40, match: /^[a-z0-9][a-z0-9-]*$/ },
    description: { type: String, trim: true, maxlength: 500 },
    currency: { type: String, default: 'INR', uppercase: true, minlength: 3, maxlength: 3 },
    // Prices in the smallest currency unit (paise) to avoid floating point errors.
    priceMonthly: { type: Number, min: 0, default: 0 },
    priceYearly: { type: Number, min: 0, default: 0 },
    trialDays: { type: Number, min: 0, max: 365, default: 14 },
    modules: {
      type: [{ type: String, enum: PLAN_MODULES }],
      default: [],
      validate: { validator: (v) => new Set(v).size === v.length, message: 'Duplicate modules' },
    },
    limits: { type: limitsSchema, default: () => ({}) },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

planSchema.index({ code: 1 }, { unique: true });

export const Plan = mongoose.model('Plan', planSchema);
