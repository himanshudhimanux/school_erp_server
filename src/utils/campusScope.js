import { ApiError } from './ApiError.js';

/**
 * Campus-level restriction helpers. A membership with an empty `campusIds` list has access to
 * every campus; otherwise only to the listed campuses.
 */
export const isCampusRestricted = (tenant) => Array.isArray(tenant?.campusIds) && tenant.campusIds.length > 0;

/** Filter fragment restricting a query on `field` to the caller's campuses (or {} if unrestricted). */
export function campusFilter(tenant, field = 'campusId') {
  return isCampusRestricted(tenant) ? { [field]: { $in: tenant.campusIds } } : {};
}

export function canAccessCampus(tenant, campusId) {
  if (!isCampusRestricted(tenant)) return true;
  return tenant.campusIds.some((id) => String(id) === String(campusId));
}

export function assertCampusAccess(tenant, campusId) {
  if (!canAccessCampus(tenant, campusId)) throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
}
