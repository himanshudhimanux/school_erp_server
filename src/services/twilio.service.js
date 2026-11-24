import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * SMS and WhatsApp delivery through Twilio's Messages API.
 * Errors carry `code` and `permanent` (true = retrying will not help, e.g. an invalid number).
 */
export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', permanent = false } = {}) {
    super(message);
    this.code = code;
    this.permanent = permanent;
  }
}

/** Converts a stored phone number to E.164 (+919876543210). Returns null when it cannot be a valid number. */
export function toE164(phone, countryCode = env.SMS_DEFAULT_COUNTRY_CODE) {
  if (!phone) return null;
  const raw = String(phone).trim();
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = countryCode + digits.replace(/^0+/, '');
  else if (digits.length <= 10) digits = countryCode + digits;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export const statusCallbackUrl = () => (env.PUBLIC_API_URL ? `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/webhooks/twilio/status` : null);

/** Sends one message. `channel` is 'sms' or 'whatsapp'. Resolves to { providerMessageId }. */
export async function sendTwilioMessage({ channel, to, body }) {
  const from = channel === 'whatsapp' ? env.TWILIO_WHATSAPP_FROM : env.TWILIO_SMS_FROM;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !from) {
    throw new ProviderError(`${channel.toUpperCase()} is not configured`, { code: `${channel.toUpperCase()}_NOT_CONFIGURED`, permanent: true });
  }
  const number = toE164(to);
  if (!number) throw new ProviderError('Invalid phone number', { code: 'INVALID_PHONE', permanent: true });
  const prefix = channel === 'whatsapp' ? 'whatsapp:' : '';
  const params = new URLSearchParams({ To: `${prefix}${number}`, From: `${prefix}${from.replace(/^whatsapp:/, '')}`, Body: body.slice(0, 1600) });
  const callback = statusCallbackUrl();
  if (callback) params.set('StatusCallback', callback);

  let res;
  try {
    res = await fetch(`${env.TWILIO_API_URL}/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new ProviderError(`Twilio unreachable: ${err.message}`, { code: 'PROVIDER_UNREACHABLE' });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 4xx (other than rate limiting) means the request itself was rejected: do not retry.
    throw new ProviderError(json.message || `Twilio error ${res.status}`, { code: json.code ? `TWILIO_${json.code}` : `TWILIO_HTTP_${res.status}`, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 });
  }
  return { providerMessageId: json.sid };
}

/**
 * Verifies X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + each POST param name+value, sorted by name)).
 */
export function verifyTwilioSignature(url, params, signature) {
  if (!env.TWILIO_AUTH_TOKEN || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  const expected = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(data).digest();
  const given = Buffer.from(String(signature), 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
