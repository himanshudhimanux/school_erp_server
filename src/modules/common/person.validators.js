import { z } from 'zod';
import { addressSchema } from '../campuses/campus.validators.js';
import { GENDERS, BLOOD_GROUPS } from './person.schema.js';

export { addressSchema };
export const optionalText = (max) => z.string().trim().max(max).optional();
export const personName = (min = 1) => z.string().trim().min(min).max(60);
/** Digits with optional leading +, spaces, dashes and brackets. */
export const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{5,18}[0-9]$/, 'Enter a valid phone number');
export const optionalEmail = z.string().trim().toLowerCase().max(254).email('Invalid email address').optional();
export const gender = z.enum(GENDERS);
export const bloodGroup = z.enum(BLOOD_GROUPS);
export const nonEmpty = (schema) => schema.refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');
export const search = z.string().trim().max(100).optional();

/** Normalises a phone number for matching ("+91 98765-43210" → "+919876543210"). */
export const normalizePhone = (v) => (v ? v.replace(/[\s()-]/g, '') : v);
