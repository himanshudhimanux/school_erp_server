import mongoose from 'mongoose';
import { Membership } from './membership.model.js';
import { School, USABLE_SCHOOL_STATUSES } from '../schools/school.model.js';
import { User } from '../users/user.model.js';
import { Role } from '../roles/role.model.js';
import { permissionsForRoles, SCHOOL_ROLES, FAMILY_ROLE_VALUES, STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { moduleOfPermission } from '../../constants/modules.js';
import { enabledModules, summarize, getSubscription, assertWithinLimit } from '../subscriptions/subscription.service.js';
import { assertCanGrant, loadSchoolRoles } from '../roles/role.service.js';
import { assertCampusesBelongToSchool } from '../campuses/campus.service.js';
import { isCampusRestricted } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { randomToken } from '../../utils/crypto.js';
import { recordAudit } from '../audit/audit.service.js';
import { assertDeletable, runDeleteHooks } from '../../utils/dependencyGuards.js';
import { welcomeToSchool } from './welcome.service.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWNER = SCHOOL_ROLES.SCHOOL_OWNER;

/** Union of permissions granted by built-in roles and custom role documents. */
export function grantedPermissions(roles, customRoles = []) {
  const set = permissionsForRoles(roles);
  for (const r of customRoles) for (const p of r.permissions) set.add(p);
  return set;
}

/**
 * Verifies that `userId` has an active membership in an active `schoolId` and builds the
 * tenant context. Returns null when access must be denied.
 *
 * - rolePermissions: everything the user's roles grant (used for escalation checks)
 * - permissions:     rolePermissions limited to modules the school's subscription enables
 */
export async function resolveMembership(userId, schoolId) {
  if (!mongoose.isValidObjectId(schoolId)) return null;
  const [membership, school, subscription] = await Promise.all([
    Membership.findOne({ schoolId, userId, status: 'active' }).lean(),
    School.findOne({ _id: schoolId, status: { $in: USABLE_SCHOOL_STATUSES } }).select('name code type status timezone currency').lean(),
    getSubscription(schoolId),
  ]);
  if (!membership || !school) return null;

  const customRoles = membership.customRoleIds?.length
    ? await Role.find({ schoolId, _id: { $in: membership.customRoleIds } }).select('key name permissions').lean()
    : [];

  const rolePermissions = grantedPermissions(membership.roles, customRoles);
  const modules = enabledModules(subscription);
  const permissions = new Set([...rolePermissions].filter((p) => modules.has(moduleOfPermission(p))));

  return {
    schoolId: school._id,
    school,
    membershipId: membership._id,
    roles: membership.roles,
    customRoles: customRoles.map((r) => ({ id: r._id, key: r.key, name: r.name })),
    campusIds: membership.campusIds,
    isOwner: membership.roles.includes(OWNER),
    rolePermissions,
    permissions,
    enabledModules: modules,
    subscription: summarize(subscription),
  };
}

/** Client-facing view of a tenant context (permissions are the effective, plan-limited set). */
export function tenantSummary(ctx) {
  if (!ctx) return null;
  return {
    schoolId: ctx.schoolId,
    school: ctx.school,
    roles: ctx.roles,
    customRoles: ctx.customRoles,
    campusIds: ctx.campusIds,
    isOwner: ctx.isOwner,
    permissions: [...ctx.permissions].sort(),
    modules: [...ctx.enabledModules].sort(),
    subscription: ctx.subscription,
  };
}

/**
 * All schools a user can enter. This is an intentional cross-tenant read, scoped to the
 * authenticated user's own userId, used at login and for the school switcher.
 */
export async function listUserSchools(userId) {
  const memberships = await Membership.find({ userId, status: 'active' })
    .setOptions({ skipTenantCheck: true })
    .select('schoolId roles campusIds')
    .lean();
  if (!memberships.length) return [];
  const schools = await School.find({ _id: { $in: memberships.map((m) => m.schoolId) }, status: { $in: USABLE_SCHOOL_STATUSES } })
    .select('name code type status')
    .lean();
  const byId = new Map(schools.map((s) => [String(s._id), s]));
  return memberships
    .filter((m) => byId.has(String(m.schoolId)))
    .map((m) => {
      const s = byId.get(String(m.schoolId));
      return { schoolId: s._id, name: s.name, code: s.code, type: s.type, status: s.status, roles: m.roles };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const memberProjection = {
  _id: 0,
  id: '$_id',
  roles: 1,
  customRoleIds: 1,
  campusIds: 1,
  status: 1,
  createdAt: 1,
  user: {
    id: '$user._id',
    name: '$user.name',
    email: '$user.email',
    phone: '$user.phone',
    status: '$user.status',
    isEmailVerified: { $ne: [{ $ifNull: ['$user.emailVerifiedAt', null] }, null] },
    lastLoginAt: '$user.lastLoginAt',
  },
};

/** Members of the caller's school (tenant-scoped, paginated, searchable by name/email/phone). */
export async function listSchoolMembers(schoolId, { page, limit, role, customRoleId, campusId, status, search }) {
  const match = { schoolId: new mongoose.Types.ObjectId(String(schoolId)) };
  if (role) match.roles = role;
  if (customRoleId) match.customRoleIds = new mongoose.Types.ObjectId(customRoleId);
  if (campusId) match.campusIds = new mongoose.Types.ObjectId(campusId);
  if (status) match.status = status;

  const pipeline = [
    { $match: match },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
  ];
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    pipeline.push({ $match: { $or: [{ 'user.name': rx }, { 'user.email': rx }, { 'user.phone': rx }] } });
  }
  pipeline.push({
    $facet: {
      items: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: memberProjection }],
      total: [{ $count: 'n' }],
    },
  });

  const [res] = await Membership.aggregate(pipeline);
  const total = res.total[0]?.n ?? 0;
  return { items: res.items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getMember(schoolId, memberId) {
  const [row] = await Membership.aggregate([
    { $match: { schoolId: new mongoose.Types.ObjectId(String(schoolId)), _id: new mongoose.Types.ObjectId(String(memberId)) } },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $project: memberProjection },
  ]);
  if (!row) throw ApiError.notFound('Member not found');
  return row;
}

/* ----------------------------- guards ----------------------------- */

function assertCampusSubset(tenant, campusIds) {
  if (!isCampusRestricted(tenant)) return;
  const mine = new Set(tenant.campusIds.map(String));
  if (!campusIds.length || !campusIds.every((id) => mine.has(String(id)))) {
    throw ApiError.forbidden('You can only assign members to your own campuses', { code: 'CAMPUS_ACCESS_DENIED' });
  }
}

async function assertAnotherActiveOwner(schoolId, excludingMembershipId) {
  const others = await Membership.countDocuments({ schoolId, roles: OWNER, status: 'active', _id: { $ne: excludingMembershipId } });
  if (!others) throw ApiError.badRequest('A school must keep at least one active owner', { code: 'LAST_OWNER' });
}

/* ----------------------------- mutations ----------------------------- */

/**
 * Adds a staff member. Existing users (matched by email) get a membership; new users are
 * created without a usable password and receive an account-setup email.
 * Parent/student memberships are created by the student & parent modules, not here.
 */
export async function addMember(tenant, data, ctx) {
  const roles = [...new Set(data.roles || [])];
  const campusIds = data.campusIds || [];
  if (roles.includes(OWNER) && !tenant.isOwner) throw ApiError.forbidden('Only a school owner can add another owner', { code: 'OWNER_REQUIRED' });

  const customRoles = await loadSchoolRoles(tenant.schoolId, data.customRoleIds || []);
  assertCanGrant(tenant, [...grantedPermissions(roles, customRoles)]);
  await assertCampusesBelongToSchool(tenant.schoolId, campusIds);
  assertCampusSubset(tenant, campusIds);

  let user = await User.findOne({ email: data.email });
  if (user) {
    const existing = await Membership.findOne({ schoolId: tenant.schoolId, userId: user._id }).lean();
    if (existing) throw ApiError.conflict('This person is already a member of the school', { code: 'ALREADY_MEMBER', details: { memberId: existing._id } });
    if (user.status !== 'active') throw ApiError.badRequest('This user account is disabled');
  }
  await assertWithinLimit(tenant.schoolId, 'maxUsers');

  let isNewUser = false;
  if (!user) {
    user = new User({ name: data.name, email: data.email, phone: data.phone || null });
    await user.setPassword(randomToken(32)); // unusable until the person sets their own
    await user.save();
    isNewUser = true;
  }

  let membership;
  try {
    membership = await Membership.create({
      schoolId: tenant.schoolId,
      userId: user._id,
      roles,
      customRoleIds: customRoles.map((r) => r._id),
      campusIds,
      status: 'active',
      invitedBy: ctx.actorId,
    });
  } catch (err) {
    if (isNewUser) await User.deleteOne({ _id: user._id });
    throw err;
  }

  const email = await welcomeToSchool(user, tenant.school.name, { isNew: isNewUser, role: roles.includes(OWNER) ? OWNER : 'staff' });

  await recordAudit({
    ...ctx,
    action: 'member.added',
    entityType: 'Membership',
    entityId: membership._id,
    metadata: { userId: user._id, email: user.email, roles, customRoleIds: membership.customRoleIds, campusIds, newUser: isNewUser },
  });

  return { member: await getMember(tenant.schoolId, membership._id), isNewUser, ...email };
}

async function loadTargetForChange(tenant, memberId, ctx) {
  const target = await Membership.findOne({ _id: memberId, schoolId: tenant.schoolId });
  if (!target) throw ApiError.notFound('Member not found');
  if (String(target.userId) === String(ctx.actorId)) {
    throw ApiError.forbidden('You cannot change your own membership', { code: 'SELF_MODIFICATION' });
  }
  if (target.roles.includes(OWNER) && !tenant.isOwner) throw ApiError.forbidden('Only a school owner can change an owner', { code: 'OWNER_REQUIRED' });

  // Cannot manage someone more privileged than yourself.
  const currentCustom = await Role.find({ schoolId: tenant.schoolId, _id: { $in: target.customRoleIds } }).lean();
  assertCanGrant(tenant, [...grantedPermissions(target.roles, currentCustom)]);

  if (isCampusRestricted(tenant)) assertCampusSubset(tenant, target.campusIds);
  return target;
}

export async function updateMember(tenant, memberId, data, ctx) {
  const target = await loadTargetForChange(tenant, memberId, ctx);
  const before = { roles: [...target.roles], customRoleIds: target.customRoleIds.map(String), campusIds: target.campusIds.map(String), status: target.status };

  if (data.roles) {
    // Parent/student roles are owned by the family modules and preserved as-is.
    const familyRoles = target.roles.filter((r) => FAMILY_ROLE_VALUES.includes(r));
    const nextRoles = [...new Set([...data.roles, ...familyRoles])];
    const ownerChange = nextRoles.includes(OWNER) !== target.roles.includes(OWNER);
    if (ownerChange && !tenant.isOwner) throw ApiError.forbidden('Only a school owner can grant or remove the owner role', { code: 'OWNER_REQUIRED' });
    if (target.roles.includes(OWNER) && !nextRoles.includes(OWNER)) await assertAnotherActiveOwner(tenant.schoolId, target._id);
    target.roles = nextRoles;
  }
  if (data.customRoleIds) {
    const roles = await loadSchoolRoles(tenant.schoolId, data.customRoleIds);
    target.customRoleIds = roles.map((r) => r._id);
  }
  if (data.roles || data.customRoleIds) {
    const custom = await Role.find({ schoolId: tenant.schoolId, _id: { $in: target.customRoleIds } }).lean();
    assertCanGrant(tenant, [...grantedPermissions(target.roles, custom)]);
  }
  if (data.campusIds) {
    await assertCampusesBelongToSchool(tenant.schoolId, data.campusIds);
    assertCampusSubset(tenant, data.campusIds);
    target.campusIds = data.campusIds;
  }
  if (data.status && data.status !== target.status) {
    if (data.status !== 'active' && target.roles.includes(OWNER)) await assertAnotherActiveOwner(tenant.schoolId, target._id);
    // A suspended member does not occupy a seat; reactivating takes one.
    if (data.status === 'active' && target.status === 'suspended') await assertWithinLimit(tenant.schoolId, 'maxUsers', 1);
    target.status = data.status;
  }

  await target.save();
  await recordAudit({
    ...ctx,
    action: 'member.updated',
    entityType: 'Membership',
    entityId: target._id,
    metadata: {
      userId: target.userId,
      before,
      after: { roles: target.roles, customRoleIds: target.customRoleIds.map(String), campusIds: target.campusIds.map(String), status: target.status },
    },
  });
  return getMember(tenant.schoolId, target._id);
}

export async function removeMember(tenant, memberId, ctx) {
  const target = await loadTargetForChange(tenant, memberId, ctx);
  if (target.roles.some((r) => FAMILY_ROLE_VALUES.includes(r))) {
    throw ApiError.conflict('This member is linked as a parent or student. Remove their staff roles instead.', { code: 'FAMILY_MEMBERSHIP' });
  }
  if (target.roles.includes(OWNER)) await assertAnotherActiveOwner(tenant.schoolId, target._id);
  // e.g. academics blocks removing someone who is still assigned as a teacher.
  await assertDeletable('member', tenant.schoolId, target._id, 'member');
  await Membership.deleteOne({ _id: target._id, schoolId: tenant.schoolId });
  await runDeleteHooks('member', tenant.schoolId, target._id); // e.g. staff profile cleanup
  await recordAudit({ ...ctx, action: 'member.removed', entityType: 'Membership', entityId: target._id, metadata: { userId: target.userId, roles: target.roles } });
}

/**
 * Validates that `membershipId` can be assigned teaching duties: an active member of this
 * school holding a staff role or a custom role, with access to `campusId` when given.
 */
export async function assertAssignableStaff(schoolId, membershipId, { campusId } = {}) {
  const m = await Membership.findOne({ _id: membershipId, schoolId, status: 'active' }).lean();
  const isStaff = m && (m.roles.some((r) => STAFF_ROLE_VALUES.includes(r)) || m.customRoleIds?.length > 0);
  if (!isStaff) throw ApiError.badRequest('Teacher must be an active staff member of this school', { code: 'INVALID_TEACHER' });
  if (campusId && m.campusIds?.length && !m.campusIds.some((id) => String(id) === String(campusId))) {
    throw ApiError.badRequest('This teacher is not assigned to the section’s campus', { code: 'TEACHER_CAMPUS_MISMATCH' });
  }
  return m;
}

/* ------------------------ family (parent/student) logins ------------------------ */

/**
 * Gives a parent or student portal access. Finds or creates the user by email and adds the
 * family role to their membership (a teacher who is also a parent keeps one membership with
 * both roles). New users receive an account-setup email. Family roles never occupy staff seats.
 * Existing users are emailed that they now have access.
 * Returns { membership, user, isNewUser, emailDelivered, emailError, setupEmailDelivered }.
 */
export async function grantFamilyRole(tenant, { name, email, phone }, role, ctx) {
  if (!FAMILY_ROLE_VALUES.includes(role)) throw new Error(`Not a family role: ${role}`);
  let user = await User.findOne({ email });
  if (user && user.status !== 'active') throw ApiError.badRequest('This user account is disabled', { code: 'USER_DISABLED' });

  let isNewUser = false;
  if (!user) {
    user = new User({ name, email, phone: phone || null });
    await user.setPassword(randomToken(32));
    await user.save();
    isNewUser = true;
  }

  let membership;
  let roleAdded = false;
  try {
    membership = await Membership.findOne({ schoolId: tenant.schoolId, userId: user._id });
    if (membership) {
      if (!membership.roles.includes(role)) {
        roleAdded = true;
        membership.roles.push(role);
        await membership.save();
      }
    } else {
      membership = await Membership.create({ schoolId: tenant.schoolId, userId: user._id, roles: [role], status: 'active', invitedBy: ctx.actorId });
      roleAdded = true;
    }
  } catch (err) {
    if (isNewUser) await User.deleteOne({ _id: user._id });
    throw err;
  }

  // Only when the role is new to them (re-enabling an existing login sends nothing).
  const welcome = isNewUser || roleAdded ? await welcomeToSchool(user, tenant.school.name, { isNew: isNewUser, role }) : { emailDelivered: null, emailError: null, setupEmailDelivered: null };
  await recordAudit({ ...ctx, action: 'member.family_role_granted', entityType: 'Membership', entityId: membership._id, metadata: { userId: user._id, email: user.email, role, newUser: isNewUser } });
  return { membership, user, isNewUser, ...welcome };
}

/** Removes a family role; the membership is deleted when no other role remains. */
export async function revokeFamilyRole(schoolId, membershipId, role, ctx) {
  const m = await Membership.findOne({ _id: membershipId, schoolId });
  if (!m) return;
  m.roles = m.roles.filter((r) => r !== role);
  if (!m.roles.length && !m.customRoleIds.length) await Membership.deleteOne({ _id: m._id, schoolId });
  else await m.save();
  await recordAudit({ ...ctx, action: 'member.family_role_revoked', entityType: 'Membership', entityId: m._id, metadata: { userId: m.userId, role } });
}

/** Short user info (name, email, last login) for a set of membership ids. */
export async function membershipUsers(schoolId, membershipIds) {
  const ids = [...new Set(membershipIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await Membership.find({ schoolId, _id: { $in: ids } }).select('userId status roles').populate('userId', 'name email lastLoginAt emailVerifiedAt').lean();
  return new Map(
    rows.map((m) => [
      String(m._id),
      { membershipId: m._id, status: m.status, userId: m.userId?._id, email: m.userId?.email, name: m.userId?.name, lastLoginAt: m.userId?.lastLoginAt ?? null, isEmailVerified: Boolean(m.userId?.emailVerifiedAt) },
    ]),
  );
}
