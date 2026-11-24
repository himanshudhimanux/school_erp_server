import { Subscription } from './subscription.model.js';
import { Plan } from './plan.model.js';
import { CORE_MODULES } from '../../constants/modules.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { ApiError } from '../../utils/ApiError.js';
import { Campus } from '../campuses/campus.model.js';
import { Membership } from '../memberships/membership.model.js';

const USABLE_STATUSES = new Set(['trialing', 'active', 'past_due']);
const DAY = 24 * 3600 * 1000;

/** Status after applying the period end + grace: a lapsed trial/active/past_due becomes 'expired'. */
export function effectiveStatus(sub, now = new Date()) {
  if (!sub) return 'none';
  if (USABLE_STATUSES.has(sub.status)) {
    const hardEnd = new Date(new Date(sub.currentPeriodEnd).getTime() + (sub.graceDays || 0) * DAY);
    if (now > hardEnd) return 'expired';
  }
  return sub.status;
}

export const isUsableStatus = (status) => USABLE_STATUSES.has(status);

/** Modules a school may use right now: core always; plan modules only with a usable subscription. */
export function enabledModules(sub) {
  const set = new Set(CORE_MODULES);
  if (sub && isUsableStatus(effectiveStatus(sub))) for (const m of sub.modules || []) set.add(m);
  return set;
}

export function summarize(sub) {
  if (!sub) return { status: 'none', usable: false, modules: [], limits: {}, planCode: null, planName: null };
  const status = effectiveStatus(sub);
  return {
    planId: sub.planId,
    planCode: sub.planCode,
    planName: sub.planName,
    status,
    storedStatus: sub.status,
    usable: isUsableStatus(status),
    billingCycle: sub.billingCycle,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodEnd: sub.currentPeriodEnd,
    graceDays: sub.graceDays,
    modules: sub.modules,
    limits: { maxStudents: sub.limits?.maxStudents ?? null, maxCampuses: sub.limits?.maxCampuses ?? null, maxUsers: sub.limits?.maxUsers ?? null },
  };
}

export const getSubscription = (schoolId) => Subscription.findOne({ schoolId }).lean();

/**
 * Usage counters per limit. Each later phase registers its counter here
 * (e.g. Phase 4 adds maxStudents → active students).
 */
const USAGE_COUNTERS = {
  maxCampuses: (schoolId) => Campus.countDocuments({ schoolId }),
  // A staff seat = any non-suspended member holding a staff role or any custom role.
  maxUsers: (schoolId) =>
    Membership.countDocuments({
      schoolId,
      status: { $in: ['active', 'invited'] },
      $or: [{ roles: { $in: STAFF_ROLE_VALUES } }, { 'customRoleIds.0': { $exists: true } }],
    }),
};

export function registerUsageCounter(limitKey, fn) {
  USAGE_COUNTERS[limitKey] = fn;
}

export async function getUsage(schoolId) {
  const entries = await Promise.all(Object.entries(USAGE_COUNTERS).map(async ([k, fn]) => [k, await fn(schoolId)]));
  return Object.fromEntries(entries);
}

/**
 * Throws 403 PLAN_LIMIT_REACHED if adding `increment` items would exceed the plan limit.
 * Note: count-then-insert is not atomic; a concurrent request can overshoot by a small amount.
 */
export async function assertWithinLimit(schoolId, limitKey, increment = 1) {
  const sub = await getSubscription(schoolId);
  const limit = sub?.limits?.[limitKey];
  if (limit === null || limit === undefined) return;
  const counter = USAGE_COUNTERS[limitKey];
  if (!counter) return;
  const used = await counter(schoolId);
  if (used + increment > limit) {
    throw ApiError.forbidden(`Your plan allows a maximum of ${limit} for ${limitKey.replace('max', '').toLowerCase()}. Upgrade to add more.`, {
      code: 'PLAN_LIMIT_REACHED',
      details: { limit: limitKey, max: limit, used },
    });
  }
}

/**
 * Creates or replaces a school's subscription from a plan.
 * `trial: true` starts a trial of plan.trialDays; otherwise an active period of the billing cycle
 * (or `currentPeriodEnd` when given explicitly).
 */
export async function assignPlan(schoolId, planOrId, opts = {}, { session } = {}) {
  const plan = planOrId?._id ? planOrId : await Plan.findById(planOrId).session(session || null);
  if (!plan) throw ApiError.notFound('Plan not found');
  if (!plan.isActive && !opts.allowInactive) throw ApiError.badRequest('Plan is not active');

  const now = new Date();
  const billingCycle = opts.billingCycle || 'monthly';
  const trial = Boolean(opts.trial) && plan.trialDays > 0;
  let currentPeriodEnd = opts.currentPeriodEnd ? new Date(opts.currentPeriodEnd) : null;
  if (!currentPeriodEnd) {
    if (trial) currentPeriodEnd = new Date(now.getTime() + plan.trialDays * DAY);
    else if (billingCycle === 'yearly') currentPeriodEnd = new Date(new Date(now).setFullYear(now.getFullYear() + 1));
    else currentPeriodEnd = new Date(new Date(now).setMonth(now.getMonth() + 1));
  }

  const doc = {
    schoolId,
    planId: plan._id,
    planCode: plan.code,
    planName: plan.name,
    status: opts.status || (trial ? 'trialing' : 'active'),
    billingCycle,
    startedAt: now,
    trialEndsAt: trial ? currentPeriodEnd : null,
    currentPeriodEnd,
    graceDays: opts.graceDays ?? 0,
    modules: opts.modules ?? plan.modules,
    limits: { ...plan.limits?.toObject?.() ?? plan.limits, ...(opts.limits || {}) },
    priceAmount: billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly,
    currency: plan.currency,
    notes: opts.notes,
    updatedBy: opts.actorId,
  };

  return Subscription.findOneAndUpdate({ schoolId }, { $set: doc }, { upsert: true, returnDocument: 'after', runValidators: true, session, setDefaultsOnInsert: true });
}
