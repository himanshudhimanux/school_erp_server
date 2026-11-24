import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { Session } from '../modules/auth/session.model.js';
import { User } from '../modules/users/user.model.js';
import { PLATFORM_ROLES } from '../constants/roles.js';

/**
 * Verifies the Bearer access token, then confirms against the database that the session is
 * still active and the user is still enabled. Sets:
 *   req.auth = { userId, sessionId, tokenSchoolId, user, isPlatformAdmin }
 */
export async function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized();

  const payload = verifyAccessToken(token);
  if (!mongoose.isValidObjectId(payload.sub) || !mongoose.isValidObjectId(payload.sid)) {
    throw ApiError.unauthorized('Invalid access token', { code: 'INVALID_TOKEN' });
  }

  const [session, user] = await Promise.all([Session.findById(payload.sid).lean(), User.findById(payload.sub)]);

  if (!session || session.revokedAt || session.expiresAt <= new Date() || String(session.userId) !== payload.sub) {
    throw ApiError.unauthorized('Session is no longer valid', { code: 'SESSION_REVOKED' });
  }
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Account is disabled', { code: 'ACCOUNT_DISABLED' });
  }

  req.auth = {
    userId: user._id,
    sessionId: session._id,
    tokenSchoolId: payload.sch || null,
    user,
    isPlatformAdmin: user.platformRole === PLATFORM_ROLES.SUPER_ADMIN,
  };
  next();
}
