import { z } from 'zod';
import { objectId } from '../auth/auth.validators.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly } from '../../utils/dates.js';
import { SESSION_STATUSES, SUBJECT_TYPES } from './academics.models.js';

const nonEmpty = (schema) => schema.refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Code may contain letters, digits and hyphens (max 20)');
const activeStatus = z.enum(['active', 'inactive']);
const search = z.string().trim().max(100).optional();

/* sessions */
export const createSessionSchema = z
  .object({
    name: z.string().trim().min(2).max(50),
    startDate: dateOnly,
    endDate: dateOnly,
    status: z.enum(['planned', 'active']).default('planned'),
    isCurrent: z.boolean().default(false),
  })
  .strict();

export const updateSessionSchema = nonEmpty(
  z.object({ name: z.string().trim().min(2).max(50), startDate: dateOnly, endDate: dateOnly, status: z.enum(SESSION_STATUSES) }).partial().strict(),
);

export const listSessionsQuery = paginationQuery.extend({ status: z.enum(SESSION_STATUSES).optional() });

export const copyStructureSchema = z
  .object({
    fromSessionId: objectId,
    sections: z.boolean().default(true),
    classSubjects: z.boolean().default(true),
    teachers: z.boolean().default(false),
  })
  .strict();

/* classes */
const classFields = { name: z.string().trim().min(1).max(60), code, order: z.number().int().min(0).max(1000), status: activeStatus, description: z.string().trim().max(300) };
export const createClassSchema = z.object(classFields).partial({ status: true, description: true }).strict();
export const updateClassSchema = nonEmpty(z.object(classFields).partial().strict());
export const listClassesQuery = paginationQuery.extend({ status: activeStatus.optional(), search, limit: z.coerce.number().int().min(1).max(100).default(100) });

/* subjects */
const subjectFields = { name: z.string().trim().min(2).max(100), code, type: z.enum(SUBJECT_TYPES), status: activeStatus, description: z.string().trim().max(300) };
export const createSubjectSchema = z.object(subjectFields).partial({ type: true, status: true, description: true }).strict();
export const updateSubjectSchema = nonEmpty(z.object(subjectFields).partial().strict());
export const listSubjectsQuery = paginationQuery.extend({ status: activeStatus.optional(), type: z.enum(SUBJECT_TYPES).optional(), search, limit: z.coerce.number().int().min(1).max(100).default(100) });

/* sections */
const sectionName = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9 -]{0,19}$/, 'Section name may contain letters, digits, spaces and hyphens (max 20)');
export const createSectionSchema = z
  .object({
    sessionId: objectId,
    classId: objectId,
    campusId: objectId,
    name: sectionName,
    capacity: z.number().int().min(1).max(500).nullable().optional(),
    room: z.string().trim().max(50).optional(),
    classTeacherId: objectId.nullable().optional(),
    status: activeStatus.optional(),
  })
  .strict();
// Session, class and campus are fixed once created (students and records hang off them).
export const updateSectionSchema = nonEmpty(
  z
    .object({
      name: sectionName,
      capacity: z.number().int().min(1).max(500).nullable(),
      room: z.string().trim().max(50),
      classTeacherId: objectId.nullable(),
      status: activeStatus,
    })
    .partial()
    .strict(),
);
export const listSectionsQuery = paginationQuery.extend({
  sessionId: objectId.optional(),
  classId: objectId.optional(),
  campusId: objectId.optional(),
  status: activeStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

/* class subjects */
export const classSubjectsQuery = z.object({ sessionId: objectId.optional(), classId: objectId });
export const setClassSubjectsSchema = z
  .object({
    sessionId: objectId,
    classId: objectId,
    subjects: z
      .array(
        z
          .object({
            subjectId: objectId,
            isOptional: z.boolean().optional(),
            periodsPerWeek: z.number().int().min(0).max(60).nullable().optional(),
            order: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

/* teaching assignments */
export const createAssignmentSchema = z.object({ sectionId: objectId, subjectId: objectId, teacherId: objectId }).strict();
export const listAssignmentsQuery = paginationQuery.extend({
  sessionId: objectId.optional(),
  sectionId: objectId.optional(),
  subjectId: objectId.optional(),
  teacherId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const sessionQuery = z.object({ sessionId: objectId.optional(), campusId: objectId.optional() });
export const idParams = z.object({ id: objectId });
