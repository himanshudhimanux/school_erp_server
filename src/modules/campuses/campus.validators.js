import { z } from 'zod';
import { objectId } from '../auth/auth.validators.js';
import { paginationQuery } from '../../utils/pagination.js';

const optionalText = (max) => z.string().trim().max(max).optional();

export const addressSchema = z
  .object({
    line1: optionalText(200),
    line2: optionalText(200),
    city: optionalText(100),
    state: optionalText(100),
    postalCode: optionalText(20),
    country: optionalText(100),
  })
  .strict();

const campusFields = {
  name: z.string().trim().min(2).max(150),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Code may contain letters, digits and hyphens (max 20)'),
  isMain: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal('')),
  phone: optionalText(20),
  address: addressSchema.optional(),
};

export const createCampusSchema = z.object(campusFields).strict();

export const updateCampusSchema = z
  .object(campusFields)
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

export const campusIdParams = z.object({ campusId: objectId });

export const listCampusQuery = paginationQuery.extend({
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().trim().max(100).optional(),
});
