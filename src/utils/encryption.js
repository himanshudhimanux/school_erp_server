import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

/**
 * AES-256-GCM encryption for secrets stored in the database (e.g. a school's payment gateway
 * key secret). Format: v1:<iv>:<tag>:<ciphertext>, base64url parts.
 *
 * DATA_ENCRYPTION_KEY (32 bytes, base64) is required in production. In development and tests a
 * key is derived from JWT_ACCESS_SECRET so the feature works without extra setup.
 */
function key() {
  if (env.DATA_ENCRYPTION_KEY) {
    const k = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
    if (k.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64)');
    return k;
  }
  if (env.isProd) throw new ApiError(503, 'Secret storage is not configured on the server', { code: 'ENCRYPTION_NOT_CONFIGURED' });
  return crypto.createHash('sha256').update(`dev-encryption:${env.JWT_ACCESS_SECRET}`).digest();
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

export function decrypt(payload) {
  const [v, iv, tag, data] = String(payload).split(':');
  if (v !== 'v1') throw new Error('Unknown encryption format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** Constant-time comparison of two hex/base64 strings. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
