import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { PLAN_MODULES } from '../../constants/modules.js';
import { limitsSchema } from './plan.model.js';

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'];
export const BILLING_CYCLES = ['monthly', 'yearly', 'custom'];

/**
 * A school's current subscription (exactly one per school).
 * `modules` and `limits` are a snapshot taken from the plan at assignment and may be
 * overridden per school by a platform admin.
 */
const subscriptionSchema = new mongoose.Schema(
  {
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    planCode: { type: String, required: true },
    planName: { type: String, required: true },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true },
    billingCycle: { type: String, enum: BILLING_CYCLES, default: 'monthly' },
    startedAt: { type: Date, default: Date.now },
    trialEndsAt: { type: Date, default: null },
    currentPeriodEnd: { type: Date, required: true },
    // Days after currentPeriodEnd during which access continues (past_due grace).
    graceDays: { type: Number, min: 0, max: 60, default: 0 },
    modules: { type: [{ type: String, enum: PLAN_MODULES }], default: [] },
    limits: { type: limitsSchema, default: () => ({}) },
    priceAmount: { type: Number, min: 0, default: 0 },
    currency: { type: String, default: 'INR' },
    notes: { type: String, maxlength: 1000 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

subscriptionSchema.plugin(tenantPlugin, { index: false });
subscriptionSchema.index({ schoolId: 1 }, { unique: true });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
