import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { User } from '../users/user.model.js';
import { Session } from './session.model.js';
import { RefreshToken } from './refreshToken.model.js';
import {
  signAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  refreshTtlMs,
  createAuthToken,
  consumeAuthToken,
} from './token.service.js';
import { listUserSchools, resolveMembership, tenantSummary } from '../memberships/membership.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../services/mail.service.js';
import { logger } from '../../utils/logger.js';

let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ??= bcrypt.hash('timing-equalizer-password', env.BCRYPT_ROUNDS));

const INVALID_CREDENTIALS = () => ApiError.unauthorized('Invalid email or password', { code: 'INVALID_CREDENTIALS' });

async function buildAuthPayload({ user, session, refreshToken, tenantCtx, schools }) {
  return {
    accessToken: signAccessToken({ userId: user._id, sessionId: session._id, schoolId: tenantCtx?.schoolId }),
    refreshToken,
    accessTokenExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    user: user.toPublic(),
    schools: schools ?? (await listUserSchools(user._id)),
    tenant: tenantSummary(tenantCtx),
  };
}

export async function login({ email, password, schoolId, client }, meta) {
  const user = await User.findOne({ email }).select('+passwordHash +failedLoginAttempts +lockUntil');

  if (!user) {
    // Equalize timing with the bcrypt path to avoid revealing which emails exist.
    await bcrypt.compare(password, await dummyHash());
    throw INVALID_CREDENTIALS();
  }
  if (user.isLocked()) {
    throw new ApiError(423, 'Account temporarily locked due to repeated failed logins. Try again later.', { code: 'ACCOUNT_LOCKED' });
  }

  const valid = await user.comparePassword(password);
  if (!valid) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { failedLoginAttempts: attempts };
    if (attempts >= env.LOGIN_MAX_ATTEMPTS) {
      update.lockUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60 * 1000);
      update.failedLoginAttempts = 0;
    }
    await User.updateOne({ _id: user._id }, { $set: update });
    await recordAudit({ action: 'auth.login_failed', entityType: 'User', entityId: user._id, actorId: user._id, ...meta, metadata: { locked: Boolean(update.lockUntil) } });
    throw INVALID_CREDENTIALS();
  }
  if (user.status !== 'active') throw ApiError.forbidden('Account is disabled', { code: 'ACCOUNT_DISABLED' });

  const schools = await listUserSchools(user._id);

  // Pick the active school: explicitly requested (must be a membership), or the only one.
  let tenantCtx = null;
  if (schoolId) {
    tenantCtx = await resolveMembership(user._id, schoolId);
    if (!tenantCtx) throw ApiError.forbidden('You do not have access to this school', { code: 'TENANT_ACCESS_DENIED' });
  } else if (schools.length === 1) {
    tenantCtx = await resolveMembership(user._id, schools[0].schoolId);
  }

  const expiresAt = new Date(Date.now() + refreshTtlMs());
  const session = await Session.create({
    userId: user._id,
    schoolId: tenantCtx?.schoolId ?? null,
    client,
    userAgent: meta.userAgent,
    ip: meta.ip,
    expiresAt,
  });
  const refreshToken = await issueRefreshToken({ sessionId: session._id, userId: user._id, expiresAt });

  await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() } });
  await recordAudit({ action: 'auth.login', entityType: 'Session', entityId: session._id, actorId: user._id, schoolId: tenantCtx?.schoolId ?? null, ...meta });

  return buildAuthPayload({ user, session, refreshToken, tenantCtx, schools });
}

export async function selectSchool(auth, schoolId, meta) {
  const tenantCtx = await resolveMembership(auth.userId, schoolId);
  if (!tenantCtx) throw ApiError.forbidden('You do not have access to this school', { code: 'TENANT_ACCESS_DENIED' });

  await Session.updateOne({ _id: auth.sessionId }, { $set: { schoolId: tenantCtx.schoolId, lastUsedAt: new Date() } });
  await recordAudit({ action: 'auth.select_school', entityType: 'School', entityId: tenantCtx.schoolId, actorId: auth.userId, schoolId: tenantCtx.schoolId, ...meta });

  return {
    accessToken: signAccessToken({ userId: auth.userId, sessionId: auth.sessionId, schoolId: tenantCtx.schoolId }),
    accessTokenExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    tenant: tenantSummary(tenantCtx),
  };
}

async function revokeSession(sessionId, reason) {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
  await RefreshToken.deleteMany({ sessionId, usedAt: null });
}

async function revokeAllSessions(userId, reason, { exceptSessionId } = {}) {
  const filter = { userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const sessions = await Session.find(filter).select('_id').lean();
  const ids = sessions.map((s) => s._id);
  if (!ids.length) return 0;
  await Session.updateMany({ _id: { $in: ids } }, { $set: { revokedAt: new Date(), revokeReason: reason } });
  await RefreshToken.deleteMany({ sessionId: { $in: ids }, usedAt: null });
  return ids.length;
}

export async function refresh(token, meta) {
  if (!token) throw ApiError.unauthorized('Refresh token missing', { code: 'REFRESH_TOKEN_MISSING' });

  const { record, reused } = await consumeRefreshToken(token);
  if (reused) {
    // A rotated token was presented again: assume theft and kill the session.
    await revokeSession(record.sessionId, 'token_reuse');
    await recordAudit({ action: 'auth.refresh_token_reuse', entityType: 'Session', entityId: record.sessionId, actorId: record.userId, ...meta });
    logger.warn({ sessionId: String(record.sessionId) }, 'Refresh token reuse detected; session revoked');
    throw ApiError.unauthorized('Refresh token reuse detected. Please sign in again.', { code: 'REFRESH_TOKEN_REUSED' });
  }
  if (!record) throw ApiError.unauthorized('Invalid or expired refresh token', { code: 'INVALID_REFRESH_TOKEN' });

  const session = await Session.findById(record.sessionId);
  if (!session || !session.isActive()) throw ApiError.unauthorized('Session is no longer valid', { code: 'SESSION_REVOKED' });

  const user = await User.findById(session.userId);
  if (!user || user.status !== 'active') {
    await revokeSession(session._id, 'revoked');
    throw ApiError.unauthorized('Account is disabled', { code: 'ACCOUNT_DISABLED' });
  }

  // Re-validate the session's school; drop it if membership or school is no longer active.
  let tenantCtx = null;
  if (session.schoolId) {
    tenantCtx = await resolveMembership(user._id, session.schoolId);
    if (!tenantCtx) session.schoolId = null;
  }

  session.lastUsedAt = new Date();
  session.ip = meta.ip;
  await session.save();

  const refreshToken = await issueRefreshToken({ sessionId: session._id, userId: user._id, expiresAt: session.expiresAt });
  return buildAuthPayload({ user, session, refreshToken, tenantCtx });
}

export async function logout(auth, meta) {
  await revokeSession(auth.sessionId, 'logout');
  await recordAudit({ action: 'auth.logout', entityType: 'Session', entityId: auth.sessionId, actorId: auth.userId, ...meta });
}

/** Logout via refresh token only (e.g. the access token already expired). */
export async function logoutByRefreshToken(token, meta) {
  const { record } = await consumeRefreshToken(token);
  if (!record) return;
  await revokeSession(record.sessionId, 'logout');
  await recordAudit({ action: 'auth.logout', entityType: 'Session', entityId: record.sessionId, actorId: record.userId, ...meta });
}

export async function logoutAll(auth, meta) {
  const count = await revokeAllSessions(auth.userId, 'logout_all');
  await recordAudit({ action: 'auth.logout_all', entityType: 'User', entityId: auth.userId, actorId: auth.userId, ...meta, metadata: { sessions: count } });
  return count;
}

export async function me(auth) {
  const schools = await listUserSchools(auth.userId);
  const tenantCtx = auth.tokenSchoolId ? await resolveMembership(auth.userId, auth.tokenSchoolId) : null;
  return { user: auth.user.toPublic(), schools, tenant: tenantSummary(tenantCtx), sessionId: auth.sessionId };
}

export async function listSessions(auth) {
  const sessions = await Session.find({ userId: auth.userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort('-lastUsedAt')
    .limit(50)
    .lean();
  return sessions.map((s) => ({
    id: s._id,
    client: s.client,
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt,
    current: String(s._id) === String(auth.sessionId),
  }));
}

export async function revokeOwnSession(auth, sessionId, meta) {
  const session = await Session.findOne({ _id: sessionId, userId: auth.userId, revokedAt: null });
  if (!session) throw ApiError.notFound('Session not found');
  await revokeSession(session._id, 'revoked');
  await recordAudit({ action: 'auth.session_revoked', entityType: 'Session', entityId: session._id, actorId: auth.userId, ...meta });
}

export async function forgotPassword(email, meta) {
  const user = await User.findOne({ email, status: 'active' });
  // Always respond identically to avoid account enumeration.
  if (!user) return;
  const token = await createAuthToken(user._id, 'password_reset');
  await sendPasswordResetEmail(user, token);
  await recordAudit({ action: 'auth.password_reset_requested', entityType: 'User', entityId: user._id, actorId: user._id, ...meta });
}

export async function resetPassword({ token, password }, meta) {
  const record = await consumeAuthToken(token, ['password_reset', 'account_setup']);
  if (!record) throw ApiError.badRequest('Reset link is invalid or has expired', { code: 'INVALID_TOKEN' });
  const user = await User.findById(record.userId);
  if (!user || user.status !== 'active') throw ApiError.badRequest('Reset link is invalid or has expired', { code: 'INVALID_TOKEN' });

  await user.setPassword(password);
  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  // Receiving the reset link proves control of the mailbox.
  if (!user.emailVerifiedAt) user.emailVerifiedAt = new Date();
  await user.save();
  await revokeAllSessions(user._id, 'password_reset');
  await recordAudit({ action: 'auth.password_reset', entityType: 'User', entityId: user._id, actorId: user._id, ...meta });
}

export async function changePassword(auth, { currentPassword, newPassword }, meta) {
  const user = await User.findById(auth.userId).select('+passwordHash');
  if (!(await user.comparePassword(currentPassword))) {
    throw ApiError.badRequest('Current password is incorrect', { code: 'INVALID_CURRENT_PASSWORD' });
  }
  await user.setPassword(newPassword);
  await user.save();
  const revoked = await revokeAllSessions(user._id, 'password_change', { exceptSessionId: auth.sessionId });
  await recordAudit({ action: 'auth.password_changed', entityType: 'User', entityId: user._id, actorId: user._id, ...meta, metadata: { otherSessionsRevoked: revoked } });
}

export async function sendVerification(user) {
  if (user.emailVerifiedAt) throw ApiError.badRequest('Email is already verified', { code: 'ALREADY_VERIFIED' });
  const token = await createAuthToken(user._id, 'email_verification');
  const result = await sendVerificationEmail(user, token);
  return { delivered: result.delivered };
}

export async function verifyEmail(token, meta) {
  const record = await consumeAuthToken(token, 'email_verification');
  if (!record) throw ApiError.badRequest('Verification link is invalid or has expired', { code: 'INVALID_TOKEN' });
  await User.updateOne({ _id: record.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } });
  await recordAudit({ action: 'auth.email_verified', entityType: 'User', entityId: record.userId, actorId: record.userId, ...meta });
}
