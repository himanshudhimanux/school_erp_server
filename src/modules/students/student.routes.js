import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { auditContext } from '../audit/audit.service.js';
import * as v from './student.validators.js';
import * as svc from './student.service.js';
import * as enroll from './enrollment.service.js';
import * as guardians from '../parents/guardian.service.js';
import './student.guards.js';

const router = Router();
const R = requirePermission('students.read');
const C = requirePermission('students.create');
const U = requirePermission('students.update');
const D = requirePermission('students.delete');
const byId = validate({ params: v.idParams });

router.get('/', R, validate({ query: v.listStudentsQuery }), async (req, res) => {
  const { items, meta } = await svc.listStudents(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.get('/summary', R, async (req, res) => ok(res, await svc.studentSummary(req.tenant)));
router.post('/', C, validate({ body: v.createStudentSchema }), async (req, res) => created(res, await svc.createStudent(req.tenant, req.body, auditContext(req)), 'Student created'));

/* ----------------------- section-level operations ----------------------- */
router.get('/sections/:sectionId/roster', R, validate({ params: v.sectionParams }), async (req, res) => ok(res, await enroll.sectionRoster(req.tenant, req.params.sectionId)));
router.post('/roll-numbers', U, validate({ body: v.rollNumbersSchema }), async (req, res) =>
  ok(res, await enroll.assignRollNumbers(req.tenant, req.body, auditContext(req)), { message: 'Roll numbers assigned' }),
);
router.post('/promote', U, validate({ body: v.promoteSchema }), async (req, res) => ok(res, await enroll.promoteStudents(req.tenant, req.body, auditContext(req)), { message: 'Promotion complete' }));
router.patch('/enrollments/:enrollmentId', U, validate({ params: v.enrollmentParams, body: v.updateEnrollmentSchema }), async (req, res) =>
  ok(res, await enroll.updateEnrollment(req.tenant, req.params.enrollmentId, req.body, auditContext(req)), { message: 'Enrollment updated' }),
);
router.delete('/enrollments/:enrollmentId', D, validate({ params: v.enrollmentParams }), async (req, res) => {
  await enroll.deleteEnrollment(req.tenant, req.params.enrollmentId, auditContext(req));
  return ok(res, null, { message: 'Enrollment deleted' });
});

/* ------------------------------ one student ------------------------------ */
router.get('/:id', R, byId, async (req, res) => ok(res, await svc.getStudent(req.tenant, req.params.id)));
router.patch('/:id', U, validate({ params: v.idParams, body: v.updateStudentSchema }), async (req, res) =>
  ok(res, await svc.updateStudent(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Student updated' }),
);
router.delete('/:id', D, byId, async (req, res) => {
  await svc.deleteStudent(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Student deleted' });
});

router.post('/:id/enrollments', U, validate({ params: v.idParams, body: v.enrollSchema }), async (req, res) =>
  created(res, await enroll.enrollStudent(req.tenant, req.params.id, req.body, auditContext(req)), 'Student enrolled'),
);

// Guardians of a student (editing links needs both student and parent rights).
router.get('/:id/guardians', R, byId, async (req, res) => {
  const student = await svc.getStudent(req.tenant, req.params.id);
  return ok(res, student.guardians);
});
const UG = requirePermission('students.update', 'parents.update');
router.post('/:id/guardians', UG, validate({ params: v.idParams, body: v.linkSchema }), async (req, res) =>
  created(res, await guardians.linkGuardian(req.tenant, req.params.id, req.body, auditContext(req)), 'Parent linked'),
);
router.patch('/:id/guardians/:guardianId', UG, validate({ params: v.linkParams, body: v.updateLinkSchema }), async (req, res) =>
  ok(res, await guardians.updateLink(req.tenant, req.params.id, req.params.guardianId, req.body, auditContext(req)), { message: 'Parent link updated' }),
);
router.delete('/:id/guardians/:guardianId', UG, validate({ params: v.linkParams }), async (req, res) =>
  ok(res, await guardians.unlinkGuardian(req.tenant, req.params.id, req.params.guardianId, auditContext(req)), { message: 'Parent unlinked' }),
);

// Student portal login (also needs users.create: it creates or links a user account).
router.post('/:id/portal-access', requirePermission('students.update', 'users.create'), validate({ params: v.idParams, body: v.portalSchema }), async (req, res) =>
  ok(res, await svc.grantStudentPortal(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Portal access granted' }),
);
router.delete('/:id/portal-access', requirePermission('students.update', 'users.update'), byId, async (req, res) =>
  ok(res, await svc.revokeStudentPortal(req.tenant, req.params.id, auditContext(req)), { message: 'Portal access revoked' }),
);

export default router;
