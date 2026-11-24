import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { auditContext } from '../audit/audit.service.js';
import * as v from './academics.validators.js';
import * as sessions from './session.service.js';
import { classes, subjects } from './catalog.service.js';
import * as sections from './section.service.js';
import * as curriculum from './curriculum.service.js';
import './academics.guards.js';

const router = Router();
const R = requirePermission('academics.read');
const C = requirePermission('academics.create');
const U = requirePermission('academics.update');
const D = requirePermission('academics.delete');
const byId = validate({ params: v.idParams });
const list = (res, { items, meta }) => ok(res, items, { meta });

/* ------------------------------ sessions ------------------------------ */
router.get('/sessions', R, validate({ query: v.listSessionsQuery }), async (req, res) => list(res, await sessions.listSessions(req.tenant.schoolId, req.validatedQuery)));
router.get('/sessions/current', R, async (req, res) => ok(res, await sessions.getCurrentSession(req.tenant.schoolId)));
router.post('/sessions', C, validate({ body: v.createSessionSchema }), async (req, res) => created(res, await sessions.createSession(req.tenant, req.body, auditContext(req)), 'Academic session created'));
router.get('/sessions/:id', R, byId, async (req, res) => ok(res, await sessions.getSession(req.tenant.schoolId, req.params.id)));
router.patch('/sessions/:id', U, validate({ params: v.idParams, body: v.updateSessionSchema }), async (req, res) =>
  ok(res, await sessions.updateSession(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Academic session updated' }),
);
router.post('/sessions/:id/set-current', U, byId, async (req, res) => ok(res, await sessions.setCurrentSession(req.tenant, req.params.id, auditContext(req)), { message: 'Current session updated' }));
router.post('/sessions/:id/copy-structure', C, validate({ params: v.idParams, body: v.copyStructureSchema }), async (req, res) =>
  ok(res, await sessions.copyStructure(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Structure copied' }),
);
router.delete('/sessions/:id', D, byId, async (req, res) => {
  await sessions.deleteSession(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Academic session deleted' });
});

/* ------------------------ classes and subjects ------------------------ */
for (const [path, svc, schemas, label] of [
  ['classes', classes, { list: v.listClassesQuery, create: v.createClassSchema, update: v.updateClassSchema }, 'Class'],
  ['subjects', subjects, { list: v.listSubjectsQuery, create: v.createSubjectSchema, update: v.updateSubjectSchema }, 'Subject'],
]) {
  router.get(`/${path}`, R, validate({ query: schemas.list }), async (req, res) => list(res, await svc.list(req.tenant.schoolId, req.validatedQuery)));
  router.post(`/${path}`, C, validate({ body: schemas.create }), async (req, res) => created(res, await svc.create(req.tenant, req.body, auditContext(req)), `${label} created`));
  router.get(`/${path}/:id`, R, byId, async (req, res) => ok(res, await svc.get(req.tenant.schoolId, req.params.id)));
  router.patch(`/${path}/:id`, U, validate({ params: v.idParams, body: schemas.update }), async (req, res) =>
    ok(res, await svc.update(req.tenant, req.params.id, req.body, auditContext(req)), { message: `${label} updated` }),
  );
  router.delete(`/${path}/:id`, D, byId, async (req, res) => {
    await svc.remove(req.tenant, req.params.id, auditContext(req));
    return ok(res, null, { message: `${label} deleted` });
  });
}

/* ------------------------------ sections ------------------------------ */
router.get('/sections', R, validate({ query: v.listSectionsQuery }), async (req, res) => list(res, await sections.listSections(req.tenant, req.validatedQuery)));
router.post('/sections', C, validate({ body: v.createSectionSchema }), async (req, res) => created(res, await sections.createSection(req.tenant, req.body, auditContext(req)), 'Section created'));
router.get('/sections/:id', R, byId, async (req, res) => ok(res, await sections.getSection(req.tenant, req.params.id)));
router.patch('/sections/:id', U, validate({ params: v.idParams, body: v.updateSectionSchema }), async (req, res) =>
  ok(res, await sections.updateSection(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Section updated' }),
);
router.delete('/sections/:id', D, byId, async (req, res) => {
  await sections.deleteSection(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Section deleted' });
});

/* ---------------------------- curriculum ---------------------------- */
router.get('/class-subjects', R, validate({ query: v.classSubjectsQuery }), async (req, res) => ok(res, await curriculum.listClassSubjects(req.tenant, req.validatedQuery)));
router.put('/class-subjects', U, validate({ body: v.setClassSubjectsSchema }), async (req, res) =>
  ok(res, await curriculum.setClassSubjects(req.tenant, req.body, auditContext(req)), { message: 'Class subjects saved' }),
);

router.get('/teaching-assignments', R, validate({ query: v.listAssignmentsQuery }), async (req, res) => list(res, await curriculum.listAssignments(req.tenant, req.validatedQuery)));
router.post('/teaching-assignments', U, validate({ body: v.createAssignmentSchema }), async (req, res) =>
  created(res, await curriculum.createAssignment(req.tenant, req.body, auditContext(req)), 'Teacher assigned'),
);
router.delete('/teaching-assignments/:id', U, byId, async (req, res) => {
  await curriculum.deleteAssignment(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Assignment removed' });
});

/** The signed-in staff member's own classes and subjects. */
router.get('/my-assignments', R, validate({ query: v.sessionQuery }), async (req, res) => ok(res, await curriculum.myAssignments(req.tenant, req.validatedQuery)));

/** Classes → sections tree for a session (selectors, setup overview). */
router.get('/structure', R, validate({ query: v.sessionQuery }), async (req, res) => ok(res, await curriculum.academicStructure(req.tenant, req.validatedQuery)));

export default router;
