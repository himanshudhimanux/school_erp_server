import mongoose from 'mongoose';
import { School } from '../schools/school.model.js';
import { Campus } from '../campuses/campus.model.js';
import { Membership } from '../memberships/membership.model.js';
import { User } from '../users/user.model.js';
import { Plan } from '../subscriptions/plan.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { assignPlan, summarize, getUsage } from '../subscriptions/subscription.service.js';
import { welcomeToSchool } from '../memberships/welcome.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditLog } from '../audit/auditLog.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { randomToken } from '../../utils/crypto.js';
import { withTransaction } from '../../utils/transaction.js';
import { toDotPaths } from '../../utils/flatten.js';
import { SCHOOL_ROLES } from '../../constants/roles.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWNER = SCHOOL_ROLES.SCHOOL_OWNER;

/* ------------------------------ plans ------------------------------ */

export function listPlans({ includeInactive }) {
  const filter = includeInactive === 'false' ? { isActive: true } : {};
  return Plan.find(filter).sort('sortOrder priceMonthly').lean();
}

export async function getPlan(planId) {
  const plan = await Plan.findById(planId);
  if (!plan) throw ApiError.notFound('Plan not found');
  return plan;
}

export async function createPlan(data, ctx) {
  const plan = await Plan.create(data);
  await recordAudit({ ...ctx, schoolId: null, action: 'platform.plan_created', entityType: 'Plan', entityId: plan._id, metadata: { code: plan.code } });
  return plan;
}

/** Plan edits affect only future assignments; existing subscriptions keep their snapshot. */
export async function updatePlan(planId, data, ctx) {
  const plan = await getPlan(planId);
  if (data.limits) data.limits = { ...plan.limits.toObject(), ...data.limits };
  plan.set(data);
  await plan.save();
  await recordAudit({ ...ctx, schoolId: null, action: 'platform.plan_updated', entityType: 'Plan', entityId: plan._id, metadata: { changed: Object.keys(data) } });
  return plan;
}

export async function deletePlan(planId, ctx) {
  const plan = await getPlan(planId);
  // Intentional cross-tenant count: is any school on this plan?
  const inUse = await Subscription.countDocuments({ planId: plan._id }).setOptions({ skipTenantCheck: true });
  if (inUse) throw ApiError.conflict(`Plan is used by ${inUse} school(s). Deactivate it instead.`, { code: 'PLAN_IN_USE' });
  await Plan.deleteOne({ _id: plan._id });
  await recordAudit({ ...ctx, schoolId: null, action: 'platform.plan_deleted', entityType: 'Plan', entityId: plan._id, metadata: { code: plan.code } });
}

/* ------------------------------ schools ------------------------------ */

async function findOrCreateUser({ name, email, phone }, { session } = {}) {
  const existing = await User.findOne({ email }).session(session || null);
  if (existing) {
    if (existing.status !== 'active') throw ApiError.badRequest('The owner account is disabled');
    return { user: existing, isNew: false };
  }
  const user = new User({ name, email, phone: phone || null });
  await user.setPassword(randomToken(32)); // unusable until the owner sets a password
  await user.save({ session });
  return { user, isNew: true };
}

/**
 * Creates a school ready to use: School + main Campus + owner User/Membership + Subscription.
 * Runs in a transaction when available; otherwise compensates by deleting what was created.
 */
export async function onboardSchool(data, ctx) {
  const plan = await Plan.findById(data.planId);
  if (!plan || !plan.isActive) throw ApiError.badRequest('Plan not found or inactive', { code: 'INVALID_PLAN' });
  if (await School.exists({ code: data.school.code }).setOptions({ withDeleted: true })) {
    throw ApiError.conflict('A school with this code already exists', { code: 'DUPLICATE', details: { fields: ['code'] } });
  }

  const created = [];
  let result;
  try {
    result = await withTransaction(async (session) => {
      const [school] = await School.create([{ ...data.school, status: 'active', createdBy: ctx.actorId }], { session });
      created.push([School, school._id]);

      const [campus] = await Campus.create([{ ...data.campus, isMain: true, schoolId: school._id, createdBy: ctx.actorId }], { session });
      created.push([Campus, campus._id, school._id]);

      const { user: owner, isNew } = await findOrCreateUser(data.owner, { session });
      if (isNew) created.push([User, owner._id]);

      const [membership] = await Membership.create([{ schoolId: school._id, userId: owner._id, roles: [OWNER], status: 'active', invitedBy: ctx.actorId }], { session });
      created.push([Membership, membership._id, school._id]);

      const subscription = await assignPlan(school._id, plan, { trial: data.trial, billingCycle: data.billingCycle, actorId: ctx.actorId }, { session });
      created.push([Subscription, subscription._id, school._id]);

      return { school, campus, owner, ownerIsNew: isNew, subscription };
    });
  } catch (err) {
    // Compensation for standalone MongoDB (no-op inside a rolled-back transaction).
    for (const [Model, id, schoolId] of created.reverse()) {
      const filter = schoolId ? { _id: id, schoolId } : { _id: id };
      await Model.deleteOne(filter).catch(() => {});
    }
    throw err;
  }

  const email = await welcomeToSchool(result.owner, result.school.name, { isNew: result.ownerIsNew, role: OWNER });

  await recordAudit({
    ...ctx,
    schoolId: result.school._id,
    action: 'platform.school_onboarded',
    entityType: 'School',
    entityId: result.school._id,
    metadata: { code: result.school.code, plan: plan.code, trial: data.trial, ownerEmail: result.owner.email, ownerIsNew: result.ownerIsNew },
  });

  return {
    school: result.school,
    campus: result.campus,
    owner: result.owner.toPublic(),
    ownerIsNew: result.ownerIsNew,
    ...email,
    subscription: summarize(result.subscription.toObject()),
  };
}

export async function listSchools({ page, limit, status, search, sort }) {
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { email: rx }, { 'address.city': rx }];
  }
  const result = await paginate(School, filter, { page, limit, sort: sort || '-createdAt', select: 'name code type status email phone address.city createdAt' });
  const ids = result.items.map((s) => s._id);
  const subs = ids.length ? await Subscription.find({ schoolId: { $in: ids } }).lean() : [];
  const subBySchool = new Map(subs.map((s) => [String(s.schoolId), s]));
  result.items = result.items.map((s) => ({ ...s, subscription: summarize(subBySchool.get(String(s._id))) }));
  return result;
}

async function loadSchool(schoolId) {
  const school = await School.findById(schoolId);
  if (!school) throw ApiError.notFound('School not found');
  return school;
}

export async function getSchoolDetail(schoolId) {
  const school = await loadSchool(schoolId);
  const [subscription, usage, owners] = await Promise.all([
    Subscription.findOne({ schoolId }).lean(),
    getUsage(school._id),
    Membership.find({ schoolId, roles: OWNER }).populate('userId', 'name email phone status lastLoginAt').lean(),
  ]);
  return {
    school,
    subscription: summarize(subscription),
    subscriptionRecord: subscription,
    usage,
    owners: owners.map((m) => ({ membershipId: m._id, status: m.status, user: m.userId })),
  };
}

export async function updateSchool(schoolId, data, ctx) {
  const school = await loadSchool(schoolId);
  if (data.code && data.code !== school.code && (await School.exists({ code: data.code }).setOptions({ withDeleted: true }))) {
    throw ApiError.conflict('A school with this code already exists', { code: 'DUPLICATE', details: { fields: ['code'] } });
  }
  await School.updateOne({ _id: school._id }, { $set: toDotPaths(data) }, { runValidators: true });
  await recordAudit({ ...ctx, schoolId: school._id, action: 'platform.school_updated', entityType: 'School', entityId: school._id, metadata: { changed: Object.keys(toDotPaths(data)) } });
  return loadSchool(schoolId);
}

/** Suspending/cancelling blocks every member immediately (checked on each request). */
export async function setSchoolStatus(schoolId, { status, reason }, ctx) {
  const school = await loadSchool(schoolId);
  const previous = school.status;
  if (previous === status) return school;
  school.status = status;
  await school.save();
  await recordAudit({ ...ctx, schoolId: school._id, action: 'platform.school_status_changed', entityType: 'School', entityId: school._id, metadata: { from: previous, to: status, reason } });
  return school;
}

export async function changeSubscriptionPlan(schoolId, data, ctx) {
  const school = await loadSchool(schoolId);
  const before = await Subscription.findOne({ schoolId: school._id }).lean();
  const sub = await assignPlan(school._id, data.planId, { ...data, actorId: ctx.actorId });
  await recordAudit({
    ...ctx,
    schoolId: school._id,
    action: 'platform.subscription_assigned',
    entityType: 'Subscription',
    entityId: sub._id,
    metadata: { fromPlan: before?.planCode ?? null, toPlan: sub.planCode, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, overrides: { modules: data.modules, limits: data.limits } },
  });
  return summarize(sub.toObject());
}

/** Adjust status, period, grace or per-school overrides without changing plan. */
export async function updateSubscription(schoolId, data, ctx) {
  const sub = await Subscription.findOne({ schoolId });
  if (!sub) throw ApiError.notFound('This school has no subscription. Assign a plan first.');
  const before = summarize(sub.toObject());
  const { limits, ...rest } = data;
  sub.set({ ...rest, updatedBy: ctx.actorId });
  if (limits) sub.set('limits', { ...sub.limits.toObject(), ...limits });
  await sub.save();
  const after = summarize(sub.toObject());
  await recordAudit({ ...ctx, schoolId, action: 'platform.subscription_updated', entityType: 'Subscription', entityId: sub._id, metadata: { changed: Object.keys(data), before, after } });
  return after;
}

/** Recovery path: add an owner to a school (e.g. the only owner left the institution). */
export async function addSchoolOwner(schoolId, person, ctx) {
  const school = await loadSchool(schoolId);
  const { user, isNew } = await findOrCreateUser(person);
  const existing = await Membership.findOne({ schoolId: school._id, userId: user._id });
  let membership;
  if (existing) {
    if (!existing.roles.includes(OWNER)) existing.roles.push(OWNER);
    existing.status = 'active';
    membership = await existing.save();
  } else {
    membership = await Membership.create({ schoolId: school._id, userId: user._id, roles: [OWNER], status: 'active', invitedBy: ctx.actorId });
  }
  const email = await welcomeToSchool(user, school.name, { isNew, role: OWNER });
  await recordAudit({ ...ctx, schoolId: school._id, action: 'platform.owner_added', entityType: 'Membership', entityId: membership._id, metadata: { userId: user._id, email: user.email, newUser: isNew } });
  return { membershipId: membership._id, owner: user.toPublic(), ownerIsNew: isNew, ...email };
}

/* ------------------------------ audit ------------------------------ */

export function listPlatformAudit({ page, limit, schoolId, action, actorId, platformOnly }) {
  const filter = {};
  if (platformOnly === 'true') filter.schoolId = null;
  else if (schoolId) filter.schoolId = new mongoose.Types.ObjectId(schoolId);
  if (action) filter.action = action;
  if (actorId) filter.actorId = actorId;
  return paginate(AuditLog, filter, { page, limit, sort: '-createdAt', populate: { path: 'actorId', select: 'name email' } });
}
