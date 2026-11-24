import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ProviderError } from './twilio.service.js';

/**
 * Push notifications through Firebase Cloud Messaging HTTP v1.
 * Authenticates with the project's service account (OAuth2 JWT bearer grant); the access token
 * is cached until shortly before it expires.
 */
let account;
let cachedToken = null;

function serviceAccount() {
  if (account !== undefined) return account;
  account = null;
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) return account;
  const text = raw.trim().startsWith('{') ? raw : fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text);
  if (!json.client_email || !json.private_key || !json.project_id) throw new Error('FCM_SERVICE_ACCOUNT is missing client_email, private_key or project_id');
  account = json;
  return account;
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const sa = serviceAccount();
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: now, exp: now + 3600 }, sa.private_key, { algorithm: 'RS256' });
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15000),
  }).catch((err) => {
    throw new ProviderError(`Google OAuth unreachable: ${err.message}`, { code: 'PROVIDER_UNREACHABLE' });
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new ProviderError(`FCM authentication failed: ${json.error_description || json.error || res.status}`, { code: 'PUSH_AUTH_FAILED' });
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/**
 * Sends to one device token. Resolves { providerMessageId }, or throws ProviderError.
 * `invalidToken: true` on the error means the token is dead and should be removed.
 */
export async function sendPush({ token, title, body, data = {} }) {
  if (!env.pushConfigured) throw new ProviderError('Push is not configured', { code: 'PUSH_NOT_CONFIGURED', permanent: true });
  const sa = serviceAccount();
  const bearer = await accessToken();
  const message = {
    token,
    notification: { title, body: body.slice(0, 1000) },
    data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])),
    android: { priority: 'high' },
  };
  let res;
  try {
    res = await fetch(`${env.FCM_API_URL}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new ProviderError(`FCM unreachable: ${err.message}`, { code: 'PROVIDER_UNREACHABLE' });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) cachedToken = null;
    const fcmCode = json.error?.details?.find?.((d) => d.errorCode)?.errorCode || json.error?.status;
    const err = new ProviderError(json.error?.message || `FCM error ${res.status}`, { code: `FCM_${fcmCode || res.status}`, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 401 });
    err.invalidToken = res.status === 404 || fcmCode === 'UNREGISTERED' || (fcmCode === 'INVALID_ARGUMENT' && /token/i.test(json.error?.message || ''));
    throw err;
  }
  return { providerMessageId: json.name };
}

/** Test hook: forget cached credentials. */
export function resetPushCache() {
  account = undefined;
  cachedToken = null;
}
