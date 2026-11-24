import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok } from '../../utils/response.js';
import { dateOnly, formatDateOnly } from '../../utils/dates.js';
import { objectId } from '../auth/auth.validators.js';
import { hasStaffRole } from '../students/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit, auditContext } from '../audit/audit.service.js';
import { STUDENT_STATUSES } from '../students/student.model.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { overview, exportCatalog, EXPORTS } from './report.service.js';

/**
 * Reports & analytics (reports.read, staff only). Each section of the overview and each export
 * also requires the permission of the area it reports on.
 */
const router = Router();
router.use((req, _res, next) => (hasStaffRole(req.tenant) ? next() : next(ApiError.forbidden('Staff only', { code: 'STAFF_ONLY' }))));
router.use(requirePermission('reports.read'));

router.get('/overview', async (req, res) => ok(res, await overview(req.tenant)));
router.get('/exports', async (req, res) => ok(res, exportCatalog(req.tenant)));

const range = { from: dateOnly, to: dateOnly };
const EXPORT_QUERIES = {
  students: z.object({ classId: objectId.optional(), sectionId: objectId.optional(), status: z.enum(STUDENT_STATUSES).optional(), campusId: objectId.optional() }).strict(),
  staff: z.object({ role: z.enum(STAFF_ROLE_VALUES).optional(), status: z.enum(['active', 'invited', 'suspended']).optional(), campusId: objectId.optional() }).strict(),
  attendance: z.object({ ...range, classId: objectId.optional(), sectionId: objectId.optional() }).strict(),
  'fee-payments': z.object({ ...range, method: z.string().trim().max(30).optional(), source: z.enum(['offline', 'online']).optional() }).strict(),
  'fee-defaulters': z.object({ sessionId: objectId.optional(), classId: objectId.optional(), sectionId: objectId.optional() }).strict(),
  'exam-results': z.object({ examId: objectId, sectionId: objectId }).strict(),
};

router.get('/exports/:key', validate({ params: z.object({ key: z.enum(Object.keys(EXPORTS)) }) }), (req, res, next) => requirePermission(EXPORTS[req.params.key].permission)(req, res, next), async (req, res) => {
  const parsed = EXPORT_QUERIES[req.params.key].safeParse(req.query);
  if (!parsed.success) throw ApiError.validation(parsed.error.issues.map((i) => ({ field: `query.${i.path.join('.')}`, message: i.message })));
  const csv = await EXPORTS[req.params.key].build(req.tenant, parsed.data);
  const filename = `${req.params.key}-${formatDateOnly(new Date())}.csv`;
  await recordAudit({ ...auditContext(req), action: 'report.exported', entityType: 'Report', metadata: { report: req.params.key, filters: req.query } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(csv);
});

export default router;
