import { z } from 'zod';

/**
 * Calendar dates (no time of day) are stored as UTC midnight and exchanged as 'YYYY-MM-DD'.
 * This avoids timezone drift: a holiday on 2026-08-15 is the same day for every viewer.
 */
export function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

export const formatDateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export const dateOnly = z
  .string()
  .trim()
  .refine((v) => parseDateOnly(v) !== null, 'Use a valid date in YYYY-MM-DD format')
  .transform((v) => parseDateOnly(v));

export const DAY_MS = 24 * 3600 * 1000;
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY_MS);
export const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;

/** Today's calendar date in a timezone, as UTC midnight (e.g. 2026-11-23T00:00:00Z). */
export function todayIn(timeZone = 'UTC', now = new Date()) {
  let ymd;
  try {
    ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    ymd = now.toISOString().slice(0, 10);
  }
  return parseDateOnly(ymd);
}

export const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY_MS);
/** 0 = Sunday … 6 = Saturday, for a date-only value. */
export const weekday = (d) => new Date(d).getUTCDay();
