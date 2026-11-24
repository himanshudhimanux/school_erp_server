import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ProviderError } from './twilio.service.js';

/**
 * Email delivery through Resend (https://resend.com) when RESEND_API_KEY is set.
 * Without it (local development / tests) messages are NOT sent: they are logged and kept in
 * `devOutbox` so links can be used locally.
 * Errors are ProviderErrors with `code` and `permanent` (true = retrying will not help).
 */
export const devOutbox = [];

/**
 * Sends one email. `idempotencyKey` (optional) makes Resend drop a repeat of the same message,
 * e.g. when a queued notification is retried after a timeout that did in fact send it.
 * Resolves to { delivered, messageId }.
 */
export async function sendMail({ to, subject, text, html, idempotencyKey }) {
  if (!env.emailConfigured) {
    devOutbox.push({ to, subject, text, at: new Date() });
    if (devOutbox.length > 50) devOutbox.shift();
    if (!env.isTest) logger.info({ to, subject, text }, 'Email provider not configured: email not delivered (dev outbox)');
    return { delivered: false, messageId: null };
  }

  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
  let res;
  try {
    res = await fetch(`${env.RESEND_API_URL.replace(/\/$/, '')}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new ProviderError(`Resend unreachable: ${err.message}`, { code: 'PROVIDER_UNREACHABLE' });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 4xx (other than rate limiting) means the request itself was rejected: do not retry.
    const code = json.name ? `RESEND_${String(json.name).toUpperCase()}` : `RESEND_HTTP_${res.status}`;
    throw new ProviderError(json.message || `Resend error ${res.status}`, { code, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 });
  }
  return { delivered: true, messageId: json.id };
}

export function sendVerificationEmail(user, token) {
  const link = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  return sendMail({
    to: user.email,
    subject: 'Verify your email address',
    text: `Hello ${user.name},\n\nPlease verify your email address by opening this link:\n${link}\n\nThis link expires in 24 hours.`,
  });
}

export function sendAccountSetupEmail(user, schoolName, token) {
  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}&setup=1`;
  return sendMail({
    to: user.email,
    subject: `You have been added to ${schoolName}`,
    text: `Hello ${user.name},\n\nAn account has been created for you at ${schoolName}. Open this link to set your password and sign in:\n${link}\n\nThis link expires in 72 hours. If it expires, use "Forgot password" on the sign-in page.`,
  });
}

/** For people who already have an account: they sign in with their existing password. */
export function sendAddedToSchoolEmail(user, schoolName, roleLabel) {
  return sendMail({
    to: user.email,
    subject: `You now have access to ${schoolName}`,
    text: `Hello ${user.name},\n\nYou have been added to ${schoolName} as ${roleLabel}. Sign in with your existing account:\n${env.APP_URL}/login\n\nIf you belong to more than one school, choose ${schoolName} after signing in. Forgot your password? Use "Forgot password" on the sign-in page.`,
  });
}

/**
 * Runs an email send without letting a delivery failure undo or fail the action that caused it
 * (the school, member or login was already saved). Resolves to { delivered, error }.
 */
export async function sendSafely(send) {
  try {
    const { delivered } = await send();
    return { delivered, error: delivered ? null : 'EMAIL_NOT_CONFIGURED' };
  } catch (err) {
    logger.warn({ err: { code: err.code, message: err.message } }, 'Email could not be sent');
    return { delivered: false, error: err.code === 'PROVIDER_UNREACHABLE' ? err.code : `${err.code || 'EMAIL_FAILED'}: ${err.message}`.slice(0, 300) };
  }
}

export function sendPasswordResetEmail(user, token) {
  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return sendMail({
    to: user.email,
    subject: 'Reset your password',
    text: `Hello ${user.name},\n\nA password reset was requested for your account. Open this link to choose a new password:\n${link}\n\nThis link expires in 1 hour. If you did not request this, you can ignore this email.`,
  });
}
