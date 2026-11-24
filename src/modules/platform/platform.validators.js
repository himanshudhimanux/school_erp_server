import { z } from 'zod';
import { objectId, email } from '../auth/auth.validators.js';
import { paginationQuery } from '../../utils/pagination.js';
import { PLAN_MODULES } from '../../constants/modules.js';
import { SCHOOL_STATUSES } from '../schools/school.model.js';
import { SUBSCRIPTION_STATUSES, BILLING_CYCLES } from '../subscriptions/subscription.model.js';
import { schoolProfileFields, schoolCode } from '../schools/school.validators.js';

const nullableLimit = (min) => z.number().int().min(min).nullable();

export const limitsSchema = z
  .object({ maxStudents: nullableLimit(0), maxCampuses: nullableLimit(1), maxUsers: nullableLimit(1) })
  .partial()
  .strict();

const modules = z
  .array(z.enum(PLAN_MODULES))
  .max(PLAN_MODULES.length)
  .refine((v) => new Set(v).size === v.length, 'Duplicate modules');

const money = z.number().int('Use the smallest currency unit (e.g. paise)').min(0);

const planFields = {
  name: z.string().trim().min(2).max(100),
  code: schoolCode,
  description: z.string().trim().max(500).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('INR'),
  priceMonthly: money.default(0),
  priceYearly: money.default(0),
  trialDays: z.number().int().min(0).max(365).default(14),
  modules: modules.default([]),
  limits: limitsSchema.default({}),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
};

export const createPlanSchema = z.object(planFields).strict();

const { code: _omitCode, ...updatablePlanFields } = planFields;
export const updatePlanSchema = z
  .object(Object.fromEntries(Object.entries(updatablePlanFields).map(([k, s]) => [k, s.removeDefault?.() ?? s])))
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

export const planIdParams = z.object({ planId: objectId });
export const schoolIdParams = z.object({ schoolId: objectId });

const personSchema = z.object({ name: z.string().trim().min(2).max(120), email, phone: z.string().trim().max(20).optional() }).strict();

export const onboardSchoolSchema = z
  .object({
    school: z
      .object({ ...schoolProfileFields, code: schoolCode })
      .partial({ type: true, email: true, phone: true, address: true, timezone: true, currency: true })
      .strict(),
    owner: personSchema,
    campus: z
      .object({
        name: z.string().trim().min(2).max(150).default('Main Campus'),
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/)
          .default('MAIN'),
      })
      .strict()
      .default({ name: 'Main Campus', code: 'MAIN' }),
    planId: objectId,
    trial: z.boolean().default(true),
    billingCycle: z.enum(BILLING_CYCLES).default('monthly'),
  })
  .strict();

export const updateSchoolSchema = z
  .object({ ...schoolProfileFields, code: schoolCode })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

export const schoolStatusSchema = z
  .object({ status: z.enum(SCHOOL_STATUSES), reason: z.string().trim().max(500).optional() })
  .strict();

export const assignPlanSchema = z
  .object({
    planId: objectId,
    trial: z.boolean().default(false),
    billingCycle: z.enum(BILLING_CYCLES).default('monthly'),
    currentPeriodEnd: z.coerce.date().optional(),
    graceDays: z.number().int().min(0).max(60).optional(),
    modules: modules.optional(),
    limits: limitsSchema.optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((d) => d.billingCycle !== 'custom' || d.currentPeriodEnd, { message: 'currentPeriodEnd is required for a custom billing cycle', path: ['currentPeriodEnd'] });

export const updateSubscriptionSchema = z
  .object({
    status: z.enum(SUBSCRIPTION_STATUSES),
    currentPeriodEnd: z.coerce.date(),
    graceDays: z.number().int().min(0).max(60),
    modules,
    limits: limitsSchema,
    notes: z.string().trim().max(1000),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

export const addOwnerSchema = personSchema;

export const listSchoolsQuery = paginationQuery.extend({
  status: z.enum(SCHOOL_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
});

export const listPlansQuery = z.object({ includeInactive: z.enum(['true', 'false']).default('true') });

export const platformAuditQuery = paginationQuery.extend({
  schoolId: objectId.optional(),
  action: z.string().trim().max(100).optional(),
  actorId: objectId.optional(),
  platformOnly: z.enum(['true', 'false']).optional(),
});
