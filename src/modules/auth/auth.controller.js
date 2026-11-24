import { env } from '../../config/env.js';
import { ok } from '../../utils/response.js';
import * as authService from './auth.service.js';

export const REFRESH_COOKIE = 'erp_rt';
const COOKIE_PATH = '/api/v1/auth';

const reqMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) });

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
  });
}

const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: env.cookieSecure, sameSite: 'strict', path: COOKIE_PATH });

/**
 * Web: refresh token lives only in an httpOnly cookie (never readable by JS).
 * Mobile: refresh token is returned in the body for secure on-device storage.
 */
function sendAuthPayload(res, payload, client, message) {
  const { refreshToken, ...rest } = payload;
  if (client === 'mobile') return ok(res, { ...rest, refreshToken }, { message });
  setRefreshCookie(res, refreshToken);
  return ok(res, rest, { message });
}

export async function login(req, res) {
  const payload = await authService.login(req.body, reqMeta(req));
  return sendAuthPayload(res, payload, req.body.client, 'Logged in');
}

export async function refresh(req, res) {
  const token = req.body.refreshToken || req.cookies?.[REFRESH_COOKIE];
  try {
    const payload = await authService.refresh(token, reqMeta(req));
    return sendAuthPayload(res, payload, req.body.client, 'Token refreshed');
  } catch (err) {
    if (req.body.client !== 'mobile') clearRefreshCookie(res);
    throw err;
  }
}

export async function selectSchool(req, res) {
  const data = await authService.selectSchool(req.auth, req.body.schoolId, reqMeta(req));
  return ok(res, data, { message: 'School selected' });
}

export async function logout(req, res) {
  await authService.logout(req.auth, reqMeta(req));
  clearRefreshCookie(res);
  return ok(res, null, { message: 'Logged out' });
}

export async function logoutWithRefreshToken(req, res) {
  const token = req.body.refreshToken || req.cookies?.[REFRESH_COOKIE];
  if (token) await authService.logoutByRefreshToken(token, reqMeta(req));
  clearRefreshCookie(res);
  return ok(res, null, { message: 'Logged out' });
}

export async function logoutAll(req, res) {
  const count = await authService.logoutAll(req.auth, reqMeta(req));
  clearRefreshCookie(res);
  return ok(res, { sessionsRevoked: count }, { message: 'Logged out from all devices' });
}

export async function me(req, res) {
  return ok(res, await authService.me(req.auth));
}

export async function listSessions(req, res) {
  return ok(res, await authService.listSessions(req.auth));
}

export async function revokeSession(req, res) {
  await authService.revokeOwnSession(req.auth, req.params.sessionId, reqMeta(req));
  return ok(res, null, { message: 'Session revoked' });
}

export async function forgotPassword(req, res) {
  await authService.forgotPassword(req.body.email, reqMeta(req));
  return ok(res, null, { message: 'If an account exists for that email, a password reset link has been sent.' });
}

export async function resetPassword(req, res) {
  await authService.resetPassword(req.body, reqMeta(req));
  clearRefreshCookie(res);
  return ok(res, null, { message: 'Password has been reset. Please sign in with your new password.' });
}

export async function changePassword(req, res) {
  await authService.changePassword(req.auth, req.body, reqMeta(req));
  return ok(res, null, { message: 'Password changed. Other sessions have been signed out.' });
}

export async function resendVerification(req, res) {
  const { delivered } = await authService.sendVerification(req.auth.user);
  return ok(res, { delivered }, { message: delivered ? 'Verification email sent' : 'Verification email generated (email delivery is not configured on this server)' });
}

export async function verifyEmail(req, res) {
  await authService.verifyEmail(req.body.token, reqMeta(req));
  return ok(res, null, { message: 'Email verified' });
}
