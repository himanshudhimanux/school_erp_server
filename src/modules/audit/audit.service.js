import { AuditLog } from './auditLog.model.js';
import { logger } from '../../utils/logger.js';
import { paginate } from '../../utils/pagination.js';

/** Extracts actor/request context for audit entries from an Express request. */
export function auditContext(req) {
  return {
    actorId: req.auth?.userId ?? null,
    schoolId: req.tenant?.schoolId ?? null,
    ip: req.ip,
    userAgent: req.get?.('user-agent')?.slice(0, 500),
  };
}

/**
 * Records an audit event. Pass `session` to make it part of a transaction (financial ops).
 * Outside a transaction, a failed audit write is logged but does not fail the request.
 */
export async function recordAudit({ action, entityType, entityId, metadata, ...ctx }, { session } = {}) {
  const doc = { action, entityType, entityId, metadata, ...ctx };
  if (session) {
    await AuditLog.create([doc], { session });
    return;
  }
  try {
    await AuditLog.create(doc);
  } catch (err) {
    logger.error({ err, action }, 'Failed to write audit log');
  }
}

/** Tenant-scoped audit listing. `schoolId` always comes from the verified tenant context. */
export function listSchoolAudit(schoolId, { page, limit, action, entityType, entityId }) {
  const filter = { schoolId };
  if (action) filter.action = action;
  if (entityType) filter.entityType = entityType;
  if (entityId) filter.entityId = entityId;
  return paginate(AuditLog, filter, { page, limit, sort: '-createdAt', populate: { path: 'actorId', select: 'name email' } });
}
