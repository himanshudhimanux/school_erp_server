import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { ApiError } from '../../utils/ApiError.js';
import { RefreshToken } from './refreshToken.model.js';
import { AuthToken } from './authToken.model.js';

const JWT_OPTS = { algorithm: 'HS256', issuer: 'school-erp', audience: 'school-erp-api' };

/**
 * Access token claims:
 *   sub = userId, sid = sessionId, sch = active schoolId (or null)
 * The school claim is only a pointer: membership is re-verified from the DB on every request.
 */
export function signAccessToken({ userId, sessionId, schoolId }) {
  return jwt.sign({ sid: String(sessionId), sch: schoolId ? String(schoolId) : null, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    ...JWT_OPTS,
    subject: String(userId),
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { ...JWT_OPTS, algorithms: ['HS256'] });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    return payload;
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    throw ApiError.unauthorized(expired ? 'Access token expired' : 'Invalid access token', { code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN' });
  }
}

export const refreshTtlMs = () => env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000;

export async function issueRefreshToken({ sessionId, userId, expiresAt }, { session } = {}) {
  const token = randomToken(48);
  await RefreshToken.create([{ sessionId, userId, tokenHash: sha256(token), expiresAt }], { session });
  return token;
}

/**
 * Atomically marks a refresh token used. Returns { record, reused }.
 * Exactly one concurrent caller can consume a given token.
 */
export async function consumeRefreshToken(token) {
  const tokenHash = sha256(token);
  const record = await RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (record) return { record, reused: false };
  const existing = await RefreshToken.findOne({ tokenHash });
  return { record: existing, reused: Boolean(existing?.usedAt) };
}

const AUTH_TOKEN_TTL = { email_verification: 24 * 3600 * 1000, password_reset: 3600 * 1000, account_setup: 72 * 3600 * 1000 };

export async function createAuthToken(userId, type) {
  // Invalidate older outstanding tokens of the same type.
  await AuthToken.deleteMany({ userId, type, usedAt: null });
  const token = randomToken(32);
  await AuthToken.create({ userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + AUTH_TOKEN_TTL[type]) });
  return token;
}

/** Atomically consumes a single-use auth token; returns the record or null. */
export function consumeAuthToken(token, type) {
  return AuthToken.findOneAndUpdate(
    { tokenHash: sha256(token), type: Array.isArray(type) ? { $in: type } : type, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { returnDocument: 'after' },
  );
}
