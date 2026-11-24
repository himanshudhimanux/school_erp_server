import { ApiError } from '../utils/ApiError.js';
import { moduleOfPermission } from '../constants/modules.js';

/**
 * Explains a denial: the role does not grant the permission (PERMISSION_DENIED), or the role
 * grants it but the school's subscription does not include / no longer covers the module.
 */
function denial(tenant, missing) {
  const blockedByPlan = missing.filter((p) => tenant.rolePermissions?.has(p));
  if (blockedByPlan.length === missing.length) {
    const modules = [...new Set(blockedByPlan.map(moduleOfPermission))];
    if (!tenant.subscription?.usable) {
      return ApiError.forbidden('Your school subscription is not active. Renew it to use this feature.', {
        code: 'SUBSCRIPTION_INACTIVE',
        details: { modules, subscriptionStatus: tenant.subscription?.status },
      });
    }
    return ApiError.forbidden('This feature is not included in your school plan.', { code: 'MODULE_NOT_ENABLED', details: { modules } });
  }
  return ApiError.forbidden(undefined, { code: 'PERMISSION_DENIED', details: { missing } });
}

/** Requires ALL listed permissions in the current tenant context. Run after requireTenant. */
export const requirePermission =
  (...permissions) =>
  (req, _res, next) => {
    const tenant = req.tenant;
    if (!tenant?.permissions) throw ApiError.forbidden();
    const missing = permissions.filter((p) => !tenant.permissions.has(p));
    if (missing.length) throw denial(tenant, missing);
    next();
  };

/** Requires ANY one of the listed permissions. */
export const requireAnyPermission =
  (...permissions) =>
  (req, _res, next) => {
    const tenant = req.tenant;
    if (!tenant?.permissions) throw ApiError.forbidden();
    if (!permissions.some((p) => tenant.permissions.has(p))) throw denial(tenant, permissions);
    next();
  };

/** Platform (SaaS) super admin only. Explicit and separate from any school membership. */
export function requirePlatformAdmin(req, _res, next) {
  if (!req.auth?.isPlatformAdmin) throw ApiError.forbidden('Platform administrator access required', { code: 'PLATFORM_ADMIN_REQUIRED' });
  next();
}
