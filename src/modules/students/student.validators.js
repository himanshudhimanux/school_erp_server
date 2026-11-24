import { z } from 'zod';
import { objectId, email } from '../auth/auth.validators.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly } from '../../utils/dates.js';
import { addressSchema, optionalText, personName, phone, optionalEmail, gender, bloodGroup, nonEmpty, search } from '../common/person.validators.js';
import { STUDENT_STATUSES, ENROLLMENT_STATUSES } from './student.model.js';
import { RELATIONS } from '../parents/guardian.model.js';

const admissionNo = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9/-]{0,29}$/, 'Admission number may contain letters, digits, "/" and "-" (max 30)');
const rollNo = z.number().int().min(1).max(9999);
const clearable = (schema) => schema.or(z.literal(''));

export const guardianFields = {
  name: z.string().trim().min(2).max(120),
  phone,
  alternatePhone: clearable(phone).optional(),
  email: clearable(z.string().trim().toLowerCase().max(254).email('Invalid email address')).optional(),
  occupation: optionalText(100),
  address: addressSchema.optional(),
  notes: optionalText(1000),
};
export const newGuardianSchema = z.object({ ...guardianFields, allowDuplicate: z.boolean().optional() }).strict();

const linkFlags = { relation: z.enum(RELATIONS), isPrimary: z.boolean().optional(), receivesAlerts: z.boolean().optional(), canPickup: z.boolean().optional() };

/** Link an existing guardian (guardianId) or create one (guardian). */
export const linkSchema = z
  .object({ guardianId: objectId.optional(), guardian: newGuardianSchema.optional(), ...linkFlags })
  .strict()
  .refine((d) => Boolean(d.guardianId) !== Boolean(d.guardian), { message: 'Provide either guardianId or guardian', path: ['guardianId'] });

export const updateLinkSchema = nonEmpty(
  z.object({ relation: z.enum(RELATIONS), isPrimary: z.boolean(), receivesAlerts: z.boolean(), canPickup: z.boolean() }).partial().strict(),
);

const profileFields = {
  admissionNo,
  firstName: personName(),
  lastName: z.string().trim().max(60),
  gender,
  dateOfBirth: dateOnly,
  bloodGroup,
  campusId: objectId,
  admissionDate: dateOnly,
  phone: clearable(phone),
  email: clearable(z.string().trim().toLowerCase().max(254).email('Invalid email address')),
  address: addressSchema,
  nationality: optionalText(60),
  religion: optionalText(60),
  category: optionalText(60),
  previousSchool: optionalText(200),
  medicalNotes: optionalText(1000),
  notes: optionalText(1000),
  photoUrl: clearable(z.string().trim().url().max(500)),
};

export const enrollSchema = z.object({ sectionId: objectId, rollNo: rollNo.optional() }).strict();

export const createStudentSchema = z
  .object({
    ...profileFields,
    status: z.enum(['active', 'inactive']).optional(),
    enrollment: enrollSchema.optional(),
    guardians: z.array(linkSchema).max(6).optional(),
  })
  .partial({
    admissionNo: true,
    lastName: true,
    dateOfBirth: true,
    bloodGroup: true,
    campusId: true,
    admissionDate: true,
    phone: true,
    email: true,
    address: true,
    photoUrl: true,
  })
  .strict();

export const updateStudentSchema = nonEmpty(
  z
    .object({
      ...profileFields,
      dateOfBirth: dateOnly.nullable(),
      bloodGroup: bloodGroup.nullable(),
      status: z.enum(STUDENT_STATUSES),
      leftOn: dateOnly,
      leavingReason: clearable(z.string().trim().max(300)),
    })
    .partial()
    .strict(),
);

export const listStudentsQuery = paginationQuery.extend({
  search,
  sessionId: objectId.optional(),
  classId: objectId.optional(),
  sectionId: objectId.optional(),
  campusId: objectId.optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  gender: gender.optional(),
  enrolled: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['name', '-name', 'admissionNo', '-admissionNo', 'createdAt', '-createdAt']).optional(),
});

export const updateEnrollmentSchema = nonEmpty(
  z.object({ sectionId: objectId, rollNo: rollNo.nullable(), status: z.enum(ENROLLMENT_STATUSES) }).partial().strict(),
);

export const rollNumbersSchema = z.object({ sectionId: objectId, orderBy: z.enum(['name', 'admissionNo']).default('name') }).strict();

export const promoteSchema = z
  .object({ fromSectionId: objectId, toSectionId: objectId, studentIds: z.array(objectId).min(1).max(500) })
  .strict()
  .refine((d) => d.fromSectionId !== d.toSectionId, { message: 'Choose a different target section', path: ['toSectionId'] });

export const portalSchema = z.object({ email: email.optional() }).strict();

export const idParams = z.object({ id: objectId });
export const linkParams = z.object({ id: objectId, guardianId: objectId });
export const enrollmentParams = z.object({ enrollmentId: objectId });
export const sectionParams = z.object({ sectionId: objectId });
export { optionalEmail };
