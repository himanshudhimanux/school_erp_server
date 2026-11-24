import { SELECTABLE_CHANNELS } from '../notifications/notification.model.js';
import { z } from 'zod';
import { addressSchema } from '../campuses/campus.validators.js';
import { DATE_FORMATS, INSTITUTION_TYPES } from './school.model.js';

// Constructing a formatter accepts canonical names and aliases (Asia/Kolkata and Asia/Calcutta).
const isValidTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
};

const uniqueDays = (max) => z.array(z.number().int().min(1).max(max)).max(6).refine((a) => new Set(a).size === a.length, 'Days must be unique');

export const timezone = z.string().max(64).refine(isValidTimezone, 'Unknown timezone');
export const schoolCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Code may contain lowercase letters, digits and hyphens (2–40 chars)');

/** Fields a school may edit about itself. Code and status are platform-controlled. */
export const schoolProfileFields = {
  name: z.string().trim().min(2).max(200),
  type: z.enum(INSTITUTION_TYPES),
  email: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional(),
  address: addressSchema,
  timezone,
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code'),
};

export const updateSchoolProfileSchema = z
  .object(schoolProfileFields)
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');

/** Delivery channels; SMS, WhatsApp and push must also be configured on the server (checked in the route). */
export const channelList = z.array(z.enum(SELECTABLE_CHANNELS)).min(1).max(5).refine((a) => new Set(a).size === a.length, 'Channels must be unique');

export const updateSettingsSchema = z
  .object({
    dateFormat: z.enum(DATE_FORMATS),
    weekStartsOn: z.number().int().min(0).max(6),
    academicYearStartMonth: z.number().int().min(1).max(12),
    attendance: z
      .object({
        weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(6).refine((a) => new Set(a).size === a.length, 'Days must be unique'),
        teacherEditDays: z.number().int().min(0).max(30),
        absentAlerts: z.boolean(),
        alertOnLate: z.boolean(),
        lowAttendanceThreshold: z.number().int().min(1).max(100),
      })
      .partial()
      .strict(),
    fees: z
      .object({
        reminders: z
          .object({
            enabled: z.boolean(),
            beforeDays: uniqueDays(60),
            onDueDate: z.boolean(),
            afterDays: uniqueDays(120),
            channels: channelList,
            sendHour: z.number().int().min(0).max(23),
          })
          .partial()
          .strict(),
      })
      .partial()
      .strict(),
    notifications: z.object({ alertChannels: channelList }).partial().strict(),
    branding: z
      .object({
        primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2563EB'),
        logoUrl: z.string().url().max(500).nullable(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one setting to update');
