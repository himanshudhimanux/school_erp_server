import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly } from '../../utils/dates.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { optionalText, personName, phone, gender, nonEmpty, search } from '../common/person.validators.js';
import { RELATIONS } from '../parents/guardian.model.js';
import { ADMISSION_STATUSES, ADMISSION_SOURCES } from './admission.model.js';
import { Admission } from './admission.model.js';
import { registerDeleteGuard, countGuard } from '../../utils/dependencyGuards.js';
import * as svc from './admission.service.js';

registerDeleteGuard('campus', countGuard((schoolId, id) => Admission.countDocuments({ schoolId, campusId: id }), (n) => `it has ${n} admission application${n === 1 ? '' : 's'}`));
registerDeleteGuard('session', countGuard((schoolId, id) => Admission.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${n} admission application${n === 1 ? '' : 's'}`));
registerDeleteGuard('class', countGuard((schoolId, id) => Admission.countDocuments({ schoolId, classId: id }), (n) => `it has ${n} admission application${n === 1 ? '' : 's'}`));

const router = Router();

const clearableEmail = z.string().trim().toLowerCase().max(254).email('Invalid email address').or(z.literal(''));
const applicant = z
  .object({ firstName: personName(), lastName: z.string().trim().max(60), gender, dateOfBirth: dateOnly.nullable(), previousSchool: optionalText(200) })
  .strict();
const guardian = z
  .object({ name: z.string().trim().min(2).max(120), phone, email: clearableEmail, relation: z.enum(RELATIONS), occupation: optionalText(100) })
  .strict();

const createSchema = z
  .object({
    sessionId: objectId,
    classId: objectId,
    campusId: objectId,
    applicant: applicant.partial({ lastName: true, dateOfBirth: true, previousSchool: true }),
    guardian: guardian.partial({ email: true, relation: true, occupation: true }),
    source: z.enum(ADMISSION_SOURCES).optional(),
    status: z.enum(['enquiry', 'applied']).optional(),
    followUpDate: dateOnly.optional(),
    notes: optionalText(2000),
  })
  .strict();

const updateSchema = nonEmpty(
  z
    .object({
      sessionId: objectId,
      classId: objectId,
      campusId: objectId,
      applicant: nonEmpty(applicant.partial()),
      guardian: nonEmpty(guardian.partial()),
      source: z.enum(ADMISSION_SOURCES),
      followUpDate: dateOnly.nullable(),
      notes: optionalText(2000),
    })
    .partial()
    .strict(),
);

const statusSchema = z
  .object({ status: z.enum(ADMISSION_STATUSES.filter((s) => s !== 'enrolled')), note: optionalText(500) })
  .strict();

const enrollSchema = z
  .object({
    sectionId: objectId.optional(),
    rollNo: z.number().int().min(1).max(9999).optional(),
    admissionNo: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9/-]{0,29}$/)
      .optional(),
    admissionDate: dateOnly.optional(),
    guardianId: objectId.optional(),
    allowDuplicateGuardian: z.boolean().optional(),
  })
  .strict();

const listQuery = paginationQuery.extend({
  sessionId: objectId.optional(),
  status: z.enum(ADMISSION_STATUSES).optional(),
  classId: objectId.optional(),
  campusId: objectId.optional(),
  source: z.enum(ADMISSION_SOURCES).optional(),
  followUpDue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  search,
});
const params = z.object({ id: objectId });

router.get('/', requirePermission('admissions.read'), validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await svc.listAdmissions(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.get('/summary', requirePermission('admissions.read'), validate({ query: z.object({ sessionId: objectId.optional() }) }), async (req, res) =>
  ok(res, await svc.admissionSummary(req.tenant, req.validatedQuery)),
);
router.post('/', requirePermission('admissions.create'), validate({ body: createSchema }), async (req, res) =>
  created(res, await svc.createAdmission(req.tenant, req.body, auditContext(req)), 'Application created'),
);
router.get('/:id', requirePermission('admissions.read'), validate({ params }), async (req, res) => ok(res, await svc.getAdmission(req.tenant, req.params.id)));
router.patch('/:id', requirePermission('admissions.update'), validate({ params, body: updateSchema }), async (req, res) =>
  ok(res, await svc.updateAdmission(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Application updated' }),
);
router.post('/:id/status', requirePermission('admissions.update'), validate({ params, body: statusSchema }), async (req, res) =>
  ok(res, await svc.changeStatus(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Status updated' }),
);
// Enrolling creates a student, so it also needs students.create.
router.post('/:id/enroll', requirePermission('admissions.update', 'students.create'), validate({ params, body: enrollSchema }), async (req, res) =>
  created(res, await svc.enrollApplicant(req.tenant, req.params.id, req.body, auditContext(req)), 'Applicant enrolled'),
);
router.delete('/:id', requirePermission('admissions.delete'), validate({ params }), async (req, res) => {
  await svc.deleteAdmission(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Application deleted' });
});

export default router;
