import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { ok } from '../../utils/response.js';
import { MODULE_LABELS, PLAN_MODULES } from '../../constants/modules.js';
import { getUsage } from './subscription.service.js';
import { Plan } from './plan.model.js';

/** Tenant view of the school's own subscription. Changes are made by the platform (and, later, self-service billing). */
const router = Router();

router.get('/', requirePermission('subscription.read'), async (req, res) => {
  const usage = await getUsage(req.tenant.schoolId);
  const sub = req.tenant.subscription;
  return ok(res, {
    ...sub,
    usage,
    modules: PLAN_MODULES.map((m) => ({ key: m, label: MODULE_LABELS[m], included: sub.modules.includes(m), enabled: req.tenant.enabledModules.has(m) })),
  });
});

/** Active plans, so the school can compare upgrade options. */
router.get('/plans', requirePermission('subscription.read'), async (_req, res) => {
  const plans = await Plan.find({ isActive: true }).sort('sortOrder priceMonthly').select('name code description currency priceMonthly priceYearly trialDays modules limits').lean();
  return ok(res, plans);
});

export default router;
