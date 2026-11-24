import { Campus } from './campus.model.js';
import { Membership } from '../memberships/membership.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { assertCampusAccess, isCampusRestricted } from '../../utils/campusScope.js';
import { assertWithinLimit } from '../subscriptions/subscription.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { assertDeletable } from '../../utils/dependencyGuards.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listCampuses(tenant, { page, limit, status, search, sort }) {
  const filter = { schoolId: tenant.schoolId };
  if (isCampusRestricted(tenant)) filter._id = { $in: tenant.campusIds };
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { 'address.city': rx }];
  }
  return paginate(Campus, filter, { page, limit, sort: sort || '-isMain name' });
}

export async function getCampus(tenant, campusId) {
  assertCampusAccess(tenant, campusId);
  const campus = await Campus.findOne({ _id: campusId, schoolId: tenant.schoolId });
  if (!campus) throw ApiError.notFound('Campus not found');
  return campus;
}

/** Ensures every id belongs to a live campus of this school. Used when assigning campuses. */
export async function assertCampusesBelongToSchool(schoolId, campusIds = []) {
  if (!campusIds.length) return;
  const unique = [...new Set(campusIds.map(String))];
  const count = await Campus.countDocuments({ schoolId, _id: { $in: unique } });
  if (count !== unique.length) throw ApiError.badRequest('One or more campuses do not belong to this school', { code: 'INVALID_CAMPUS' });
}

async function unsetOtherMain(schoolId, exceptId) {
  await Campus.updateMany({ schoolId, isMain: true, _id: { $ne: exceptId } }, { $set: { isMain: false } });
}

export async function createCampus(tenant, data, ctx) {
  if (isCampusRestricted(tenant)) throw ApiError.forbidden('Campus-restricted users cannot create campuses', { code: 'CAMPUS_ACCESS_DENIED' });
  await assertWithinLimit(tenant.schoolId, 'maxCampuses');

  const hasAny = await Campus.exists({ schoolId: tenant.schoolId });
  const makeMain = !hasAny || data.isMain === true;
  if (makeMain && hasAny) await unsetOtherMain(tenant.schoolId, null);

  const campus = await Campus.create({ ...data, isMain: makeMain, schoolId: tenant.schoolId, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'campus.created', entityType: 'Campus', entityId: campus._id, metadata: { code: campus.code, name: campus.name } });
  return campus;
}

export async function updateCampus(tenant, campusId, data, ctx) {
  const campus = await getCampus(tenant, campusId);

  if (data.isMain === false && campus.isMain) {
    throw ApiError.badRequest('Set another campus as main instead of unsetting the main campus', { code: 'MAIN_CAMPUS_REQUIRED' });
  }
  if (data.status === 'inactive' && (campus.isMain || data.isMain)) {
    throw ApiError.badRequest('The main campus cannot be deactivated', { code: 'MAIN_CAMPUS_REQUIRED' });
  }
  if (data.isMain === true && !campus.isMain) {
    if (campus.status === 'inactive' && data.status !== 'active') throw ApiError.badRequest('An inactive campus cannot be the main campus');
    await unsetOtherMain(tenant.schoolId, campus._id);
  }

  const before = campus.toObject();
  const { address, ...rest } = data;
  campus.set(rest);
  if (address) campus.set('address', { ...(before.address || {}), ...address });
  campus.updatedBy = ctx.actorId;
  await campus.save();

  const changed = Object.keys(data);
  await recordAudit({ ...ctx, action: 'campus.updated', entityType: 'Campus', entityId: campus._id, metadata: { changed } });
  return campus;
}

export async function deleteCampus(tenant, campusId, ctx) {
  const campus = await getCampus(tenant, campusId);
  if (campus.isMain) throw ApiError.badRequest('The main campus cannot be deleted', { code: 'MAIN_CAMPUS_REQUIRED' });

  // Other modules (sections, students, ...) register guards for 'campus'.
  await assertDeletable('campus', tenant.schoolId, campus._id);

  // An empty campusIds list means "all campuses", so removing a member's ONLY campus would
  // silently widen their access. Require those members to be reassigned first.
  const soleCampusMembers = await Membership.countDocuments({
    schoolId: tenant.schoolId,
    $and: [{ campusIds: campus._id }, { campusIds: { $size: 1 } }],
  });
  if (soleCampusMembers) {
    throw ApiError.conflict(`${soleCampusMembers} member(s) are restricted to this campus only. Reassign them before deleting it.`, {
      code: 'CAMPUS_IN_USE',
      details: { soleCampusMembers },
    });
  }

  await campus.softDelete(ctx.actorId);
  const affected = await Membership.updateMany({ schoolId: tenant.schoolId, campusIds: campus._id }, { $pull: { campusIds: campus._id } });
  await recordAudit({ ...ctx, action: 'campus.deleted', entityType: 'Campus', entityId: campus._id, metadata: { code: campus.code, membersUpdated: affected.modifiedCount } });
  return { membersUpdated: affected.modifiedCount };
}
