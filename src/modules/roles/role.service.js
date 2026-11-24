import mongoose from 'mongoose';
import { Role } from './role.model.js';
import { Membership } from '../memberships/membership.model.js';
import { ROLE_PERMISSIONS, ROLE_LABELS, SCHOOL_ROLE_VALUES } from '../../constants/roles.js';
import { PERMISSIONS } from '../../constants/permissions.js';
import { MODULE_LABELS, isCoreModule, moduleOfPermission } from '../../constants/modules.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const MAX_CUSTOM_ROLES = 50;

/** Prevents privilege escalation: a user may only grant permissions they hold themselves. */
export function assertCanGrant(tenant, permissions) {
  const missing = permissions.filter((p) => !tenant.rolePermissions.has(p));
  if (missing.length) {
    throw ApiError.forbidden('You cannot grant permissions you do not have', { code: 'PRIVILEGE_ESCALATION', details: { missing } });
  }
}

/** Loads custom roles by id, ensuring all belong to this school. */
export async function loadSchoolRoles(schoolId, roleIds = []) {
  if (!roleIds.length) return [];
  const unique = [...new Set(roleIds.map(String))];
  const roles = await Role.find({ schoolId, _id: { $in: unique } }).lean();
  if (roles.length !== unique.length) throw ApiError.badRequest('One or more roles do not belong to this school', { code: 'INVALID_ROLE' });
  return roles;
}

async function memberCounts(schoolId) {
  const rows = await Membership.aggregate([
    { $match: { schoolId: new mongoose.Types.ObjectId(String(schoolId)) } },
    { $project: { roles: 1, customRoleIds: 1 } },
    {
      $facet: {
        system: [{ $unwind: '$roles' }, { $group: { _id: '$roles', n: { $sum: 1 } } }],
        custom: [{ $unwind: '$customRoleIds' }, { $group: { _id: '$customRoleIds', n: { $sum: 1 } } }],
      },
    },
  ]);
  const [res] = rows;
  return {
    system: new Map(res.system.map((r) => [r._id, r.n])),
    custom: new Map(res.custom.map((r) => [String(r._id), r.n])),
  };
}

export async function listRoles(tenant) {
  const [custom, counts] = await Promise.all([Role.find({ schoolId: tenant.schoolId }).sort('name').lean(), memberCounts(tenant.schoolId)]);
  const system = SCHOOL_ROLE_VALUES.map((key) => ({
    id: key,
    key,
    name: ROLE_LABELS[key],
    isSystem: true,
    permissions: ROLE_PERMISSIONS[key],
    memberCount: counts.system.get(key) || 0,
  }));
  const customRoles = custom.map((r) => ({
    id: r._id,
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: false,
    permissions: r.permissions,
    memberCount: counts.custom.get(String(r._id)) || 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return [...system, ...customRoles];
}

/** Permission catalogue grouped by module, with whether the school's plan includes the module. */
export function permissionCatalogue(tenant) {
  const groups = new Map();
  for (const p of PERMISSIONS) {
    const mod = moduleOfPermission(p);
    if (!groups.has(mod)) {
      groups.set(mod, {
        module: mod,
        label: MODULE_LABELS[mod] || mod.charAt(0).toUpperCase() + mod.slice(1),
        core: isCoreModule(mod),
        enabled: tenant.enabledModules.has(mod),
        permissions: [],
      });
    }
    groups.get(mod).permissions.push({ key: p, action: p.split('.')[1], grantableByYou: tenant.rolePermissions.has(p) });
  }
  return [...groups.values()];
}

export async function getRole(schoolId, roleId) {
  const role = await Role.findOne({ _id: roleId, schoolId });
  if (!role) throw ApiError.notFound('Role not found');
  return role;
}

export async function createRole(tenant, data, ctx) {
  if (SCHOOL_ROLE_VALUES.includes(data.key)) throw ApiError.conflict('This key is reserved for a built-in role', { code: 'DUPLICATE' });
  assertCanGrant(tenant, data.permissions);
  const count = await Role.countDocuments({ schoolId: tenant.schoolId });
  if (count >= MAX_CUSTOM_ROLES) throw ApiError.badRequest(`A school can have at most ${MAX_CUSTOM_ROLES} custom roles`);

  const role = await Role.create({ ...data, permissions: [...new Set(data.permissions)], schoolId: tenant.schoolId, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'role.created', entityType: 'Role', entityId: role._id, metadata: { key: role.key, permissions: role.permissions } });
  return role;
}

export async function updateRole(tenant, roleId, data, ctx) {
  const role = await getRole(tenant.schoolId, roleId);
  if (data.permissions) {
    // Only the permissions being added need to be held by the editor.
    const added = data.permissions.filter((p) => !role.permissions.includes(p));
    assertCanGrant(tenant, added);
    // Removing permissions the editor does not hold would also be a privilege change on others.
    const removed = role.permissions.filter((p) => !data.permissions.includes(p));
    assertCanGrant(tenant, removed);
    data.permissions = [...new Set(data.permissions)];
  }
  const before = role.permissions;
  role.set({ ...data, updatedBy: ctx.actorId });
  await role.save();
  await recordAudit({
    ...ctx,
    action: 'role.updated',
    entityType: 'Role',
    entityId: role._id,
    metadata: { changed: Object.keys(data), ...(data.permissions ? { before, after: role.permissions } : {}) },
  });
  return role;
}

export async function deleteRole(tenant, roleId, ctx) {
  const role = await getRole(tenant.schoolId, roleId);
  assertCanGrant(tenant, role.permissions);
  const inUse = await Membership.countDocuments({ schoolId: tenant.schoolId, customRoleIds: role._id });
  if (inUse) throw ApiError.conflict(`Role is assigned to ${inUse} member(s). Remove it from them first.`, { code: 'ROLE_IN_USE', details: { members: inUse } });
  await Role.deleteOne({ _id: role._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'role.deleted', entityType: 'Role', entityId: role._id, metadata: { key: role.key, permissions: role.permissions } });
}
