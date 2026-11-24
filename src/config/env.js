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
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
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
  smtpConfigured: Boolean(raw.SMTP_HOST),
  requireTransactions: raw.REQUIRE_TRANSACTIONS ?? false,
  jobsEnabled: raw.JOBS_ENABLED ?? raw.NODE_ENV !== 'test',
  twilioConfigured: Boolean(raw.TWILIO_ACCOUNT_SID && raw.TWILIO_AUTH_TOKEN),
  smsConfigured: Boolean(raw.TWILIO_ACCOUNT_SID && raw.TWILIO_AUTH_TOKEN && raw.TWILIO_SMS_FROM),
  whatsappConfigured: Boolean(raw.TWILIO_ACCOUNT_SID && raw.TWILIO_AUTH_TOKEN && raw.TWILIO_WHATSAPP_FROM),
  pushConfigured: Boolean(raw.FCM_SERVICE_ACCOUNT),
});
