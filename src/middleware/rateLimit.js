import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

const handler = (_req, res) =>
  res.status(429).json({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later.' } });

const make = (windowMs, limit) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, handler, skip: () => env.isTest });

export const apiLimiter = make(60 * 1000, env.RATE_LIMIT_PER_MINUTE);
/** Login, password reset, verification: brute-force protection per IP. */
export const authLimiter = make(15 * 60 * 1000, env.AUTH_RATE_LIMIT_PER_15_MIN);
export const refreshLimiter = make(60 * 1000, 30);
