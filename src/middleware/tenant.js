import { ApiError } from '../utils/ApiError.js';
import { resolveMembership } from '../modules/memberships/membership.service.js';

/**
 * Establishes the tenant context for school-scoped routes. Must run after `authenticate`.
 *
 * The school comes ONLY from the signed access token (chosen via /auth/select-school, which
 * verified membership). It is re-verified here on every request against Membership and School
 * status, so suspending a member or a school takes effect immediately.
 * Client-supplied school IDs in headers, query or body are never used.
 *
 * Sets req.tenant = { schoolId, school, membershipId, roles, campusIds, permissions:Set }
 */
export async function requireTenant(req, _res, next) {
  const schoolId = req.auth?.tokenSchoolId;
  if (!schoolId) {
    throw ApiError.forbidden('No school selected for this session. Call POST /api/v1/auth/select-school first.', {
      code: 'NO_SCHOOL_SELECTED',
    });
  }

  const ctx = await resolveMembership(req.auth.userId, schoolId);
  if (!ctx) throw ApiError.forbidden('You do not have access to this school', { code: 'TENANT_ACCESS_DENIED' });

  req.tenant = ctx;
  next();
}
