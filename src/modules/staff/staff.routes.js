import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { paginationQuery } from '../../utils/pagination.js';
import { dateOnly } from '../../utils/dates.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { objectId, email } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { MEMBERSHIP_STATUSES } from '../memberships/membership.model.js';
import { addressSchema, optionalText, phone, gender, nonEmpty, search } from '../common/person.validators.js';
import { EMPLOYMENT_TYPES, EMPLOYMENT_STATUSES } from './staffProfile.model.js';
import * as svc from './staff.service.js';

const router = Router();

const profileSchema = z
  .object({
    employeeCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9/-]{0,29}$/, 'Employee code may contain letters, digits, "/" and "-" (max 30)'),
    department: optionalText(80),
    designation: optionalText(80),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    employmentStatus: z.enum(EMPLOYMENT_STATUSES),
    joiningDate: dateOnly.nullable(),
    exitDate: dateOnly.nullable(),
    dateOfBirth: dateOnly.nullable(),
    gender: gender.nullable(),
    qualification: optionalText(200),
    experienceYears: z.number().min(0).max(60).nullable(),
    address: addressSchema,
    emergencyContact: z.object({ name: optionalText(120), phone: phone.optional(), relation: optionalText(40) }).strict(),
    notes: optionalText(1000),
  })
  .partial()
  .strict();

const createSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email,
    phone: phone.optional(),
    roles: z.array(z.enum(STAFF_ROLE_VALUES)).max(6).default([]),
    customRoleIds: z.array(objectId).max(10).default([]),
    campusIds: z.array(objectId).max(50).default([]),
    profile: profileSchema.default({}),
  })
  .strict()
  .refine((d) => d.roles.length + d.customRoleIds.length > 0, { message: 'Assign at least one role', path: ['roles'] });

const listQuery = paginationQuery.extend({
  search,
  role: z.enum(STAFF_ROLE_VALUES).optional(),
  department: z.string().trim().max(80).optional(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  campusId: objectId.optional(),
});
const params = z.object({ memberId: objectId });

router.get('/', requirePermission('staff.read'), validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await svc.listStaff(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.get('/options', requirePermission('staff.read'), async (req, res) => ok(res, await svc.staffDirectoryOptions(req.tenant)));
// Creating staff also creates a login and assigns roles, so it needs users.create as well.
router.post('/', requirePermission('staff.create', 'users.create'), validate({ body: createSchema }), async (req, res) => {
  const result = await svc.createStaff(req.tenant, req.body, auditContext(req));
  return created(res, result, result.isNewUser ? 'Staff member added and invited by email' : 'Staff member added');
});
router.get('/:memberId', requirePermission('staff.read'), validate({ params }), async (req, res) => ok(res, await svc.getStaff(req.tenant, req.params.memberId)));
router.put('/:memberId/profile', requirePermission('staff.update'), validate({ params, body: nonEmpty(profileSchema) }), async (req, res) =>
  ok(res, await svc.upsertProfile(req.tenant, req.params.memberId, req.body, auditContext(req)), { message: 'Employee details saved' }),
);

export default router;
