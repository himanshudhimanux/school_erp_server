import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePlatformAdmin } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { CORE_MODULES, PLAN_MODULES, MODULE_LABELS } from '../../constants/modules.js';
import { auditContext } from '../audit/audit.service.js';
import * as v from './platform.validators.js';
import * as svc from './platform.service.js';
import { platformAnalytics } from './analytics.service.js';
import { welcomeMessage } from '../memberships/welcome.service.js';

/**
 * SaaS platform administration. Requires User.platformRole = super_admin.
 * These routes never use or create a tenant context: school IDs here are explicit
 * administrative targets, authorized by the platform role.
 */
const router = Router();
router.use(authenticate, requirePlatformAdmin);

const ctx = (req) => ({ ...auditContext(req), schoolId: null });

router.get('/modules', (_req, res) =>
  ok(res, {
    core: CORE_MODULES,
    plan: PLAN_MODULES.map((key) => ({ key, label: MODULE_LABELS[key] })),
  }),
);

router.get('/analytics', async (_req, res) => ok(res, await platformAnalytics()));

// Plans
router.get('/plans', validate({ query: v.listPlansQuery }), async (req, res) => ok(res, await svc.listPlans(req.validatedQuery)));
router.post('/plans', validate({ body: v.createPlanSchema }), async (req, res) => created(res, await svc.createPlan(req.body, ctx(req)), 'Plan created'));
router.get('/plans/:planId', validate({ params: v.planIdParams }), async (req, res) => ok(res, await svc.getPlan(req.params.planId)));
router.patch('/plans/:planId', validate({ params: v.planIdParams, body: v.updatePlanSchema }), async (req, res) =>
  ok(res, await svc.updatePlan(req.params.planId, req.body, ctx(req)), { message: 'Plan updated' }),
);
router.delete('/plans/:planId', validate({ params: v.planIdParams }), async (req, res) => {
  await svc.deletePlan(req.params.planId, ctx(req));
  return ok(res, null, { message: 'Plan deleted' });
});

// Schools
router.get('/schools', validate({ query: v.listSchoolsQuery }), async (req, res) => {
  const { items, meta } = await svc.listSchools(req.validatedQuery);
  return ok(res, items, { meta });
});
router.post('/schools', validate({ body: v.onboardSchoolSchema }), async (req, res) => {
  const result = await svc.onboardSchool(req.body, ctx(req));
  return created(res, result, `School onboarded. ${welcomeMessage({ isNew: result.ownerIsNew, ...result })}`);
});
router.get('/schools/:schoolId', validate({ params: v.schoolIdParams }), async (req, res) => ok(res, await svc.getSchoolDetail(req.params.schoolId)));
router.patch('/schools/:schoolId', validate({ params: v.schoolIdParams, body: v.updateSchoolSchema }), async (req, res) =>
  ok(res, await svc.updateSchool(req.params.schoolId, req.body, ctx(req)), { message: 'School updated' }),
);
router.patch('/schools/:schoolId/status', validate({ params: v.schoolIdParams, body: v.schoolStatusSchema }), async (req, res) =>
  ok(res, await svc.setSchoolStatus(req.params.schoolId, req.body, ctx(req)), { message: 'School status updated' }),
);
router.put('/schools/:schoolId/subscription', validate({ params: v.schoolIdParams, body: v.assignPlanSchema }), async (req, res) =>
  ok(res, await svc.changeSubscriptionPlan(req.params.schoolId, req.body, ctx(req)), { message: 'Plan assigned' }),
);
router.patch('/schools/:schoolId/subscription', validate({ params: v.schoolIdParams, body: v.updateSubscriptionSchema }), async (req, res) =>
  ok(res, await svc.updateSubscription(req.params.schoolId, req.body, ctx(req)), { message: 'Subscription updated' }),
);
router.post('/schools/:schoolId/owners', validate({ params: v.schoolIdParams, body: v.addOwnerSchema }), async (req, res) =>
  created(res, await svc.addSchoolOwner(req.params.schoolId, req.body, ctx(req)), 'Owner added'),
);

// Audit
router.get('/audit-logs', validate({ query: v.platformAuditQuery }), async (req, res) => {
  const { items, meta } = await svc.listPlatformAudit(req.validatedQuery);
  return ok(res, items, { meta });
});

export default router;
