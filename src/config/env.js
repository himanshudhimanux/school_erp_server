import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v === 'true'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: bool,
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Email through Resend. MAIL_FROM must use a domain verified in your Resend account.
  RESEND_API_KEY: z.string().optional(),
  RESEND_API_URL: z.string().url().default('https://api.resend.com'),
  MAIL_FROM: z.string().default('School ERP <no-reply@localhost>'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  REQUIRE_TRANSACTIONS: bool,
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  // 32-byte key (base64) for encrypting stored secrets such as each school's payment gateway keys.
  DATA_ENCRYPTION_KEY: z.string().optional(),
  RAZORPAY_API_URL: z.string().url().default('https://api.razorpay.com/v1'),
  // Background jobs (fee reminders, late fees). Disabled automatically in tests.
  JOBS_ENABLED: bool,
  // General API rate limit per client IP per minute (sign-in endpoints have their own stricter limit).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  // Sign-in, password reset and verification attempts per client IP per 15 minutes.
  AUTH_RATE_LIMIT_PER_15_MIN: z.coerce.number().int().positive().default(30),
  // Public base URL of this API (e.g. https://api.example.com), used for provider delivery callbacks.
  PUBLIC_API_URL: z.string().url().optional(),
  // SMS and WhatsApp through Twilio. A channel is available only when its sender is set.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TWILIO_API_URL: z.string().url().default('https://api.twilio.com'),
  // Country calling code added to local numbers without one (91 = India).
  SMS_DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,4}$/).default('91'),
  // Push through Firebase Cloud Messaging (HTTP v1): path to the service-account JSON, or the JSON itself base64-encoded.
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  FCM_API_URL: z.string().url().default('https://fcm.googleapis.com'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const raw = parsed.data;

export const env = Object.freeze({
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: raw.COOKIE_SECURE ?? raw.NODE_ENV === 'production',
  emailConfigured: Boolean(raw.RESEND_API_KEY),
  requireTransactions: raw.REQUIRE_TRANSACTIONS ?? false,
  jobsEnabled: raw.JOBS_ENABLED ?? raw.NODE_ENV !== 'test',
  twilioConfigured: Boolean(raw.TWILIO_ACCOUNT_SID && raw.TWILIO_AUTH_TOKEN),
  smsConfigured: Boolean(raw.TWILIO_ACCOUNT_SID && raw.TWILIO_AUTH_TOKEN && raw.TWILIO_SMS_FROM),
  whatsappConfigured: Boolean(raw.TWILIO_ACCOUNT_SID && raw.TWILIO_AUTH_TOKEN && raw.TWILIO_WHATSAPP_FROM),
  pushConfigured: Boolean(raw.FCM_SERVICE_ACCOUNT),
});

/**
 * Production safety checks. Errors stop the server (an insecure or half-working setup is worse
 * than none); warnings are printed at start-up. Pure function so it can be tested.
 */
export function productionIssues(e) {
  const errors = [];
  const warnings = [];
  if (!e.isProd) return { errors, warnings };
  const keyBytes = e.DATA_ENCRYPTION_KEY ? Buffer.from(e.DATA_ENCRYPTION_KEY, 'base64').length : 0;
  if (keyBytes !== 32) errors.push('DATA_ENCRYPTION_KEY must be set to 32 random bytes (base64) — it encrypts stored payment gateway secrets');
  if (/change[-_ ]?me|secret|password|example/i.test(e.JWT_ACCESS_SECRET) || new Set(e.JWT_ACCESS_SECRET).size < 12) errors.push('JWT_ACCESS_SECRET looks like a placeholder; use a long random value');
  if (!e.cookieSecure) errors.push('COOKIE_SECURE must not be false in production (the refresh-token cookie would be sent over plain HTTP)');
  if (e.corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) warnings.push('CORS_ORIGINS includes a localhost address');
  if (!e.APP_URL.startsWith('https://')) warnings.push('APP_URL is not https: links in emails will be insecure');
  if (!e.TRUST_PROXY) warnings.push('TRUST_PROXY is 0: behind Nginx every visitor shares one IP, so rate limits apply to everyone together. Set TRUST_PROXY=1');
  if (!e.requireTransactions) warnings.push('REQUIRE_TRANSACTIONS is not true: the server will start on a standalone MongoDB where fee payments are refused');
  if (!e.emailConfigured) warnings.push('RESEND_API_KEY is not set: account set-up, password reset and email notifications will not be delivered');
  if (e.emailConfigured && /localhost|example\.com/i.test(e.MAIL_FROM)) warnings.push('MAIL_FROM still uses a placeholder address; Resend only sends from a verified domain');
  if (e.PUBLIC_API_URL && !e.PUBLIC_API_URL.startsWith('https://')) warnings.push('PUBLIC_API_URL is not https');
  return { errors, warnings };
}

{
  const { errors, warnings } = productionIssues(env);
  for (const w of warnings) console.warn(`[config warning] ${w}`);
  if (errors.length) {
    console.error('Unsafe production configuration:');
    for (const m of errors) console.error(`  - ${m}`);
    process.exit(1);
  }
}
