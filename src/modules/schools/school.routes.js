import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { School } from './school.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { toDotPaths } from '../../utils/flatten.js';
import { auditContext, recordAudit } from '../audit/audit.service.js';
import { updateSchoolProfileSchema, updateSettingsSchema } from './school.validators.js';
import { assertChannelsAvailable } from '../notifications/notification.service.js';

/** Mounted under the tenant router: req.tenant is already verified. */
const router = Router();

const PUBLIC_FIELDS = '-isDeleted -deletedAt -deletedBy -__v';

async function loadSchool(schoolId) {
  const school = await School.findById(schoolId).select(PUBLIC_FIELDS).lean();
  if (!school) throw ApiError.notFound('School not found');
  return school;
}

router.get('/', requirePermission('school.read'), async (req, res) => ok(res, await loadSchool(req.tenant.schoolId)));

router.patch('/', requirePermission('school.update'), validate({ body: updateSchoolProfileSchema }), async (req, res) => {
  await School.updateOne({ _id: req.tenant.schoolId }, { $set: toDotPaths(req.body) }, { runValidators: true });
  await recordAudit({ ...auditContext(req), action: 'school.profile_updated', entityType: 'School', entityId: req.tenant.schoolId, metadata: { changed: Object.keys(toDotPaths(req.body)) } });
  return ok(res, await loadSchool(req.tenant.schoolId), { message: 'School profile updated' });
});

router.get('/settings', requirePermission('settings.read'), async (req, res) => {
  const school = await loadSchool(req.tenant.schoolId);
  return ok(res, school.settings || {});
});

router.patch('/settings', requirePermission('settings.update'), validate({ body: updateSettingsSchema }), async (req, res) => {
  if (req.body.notifications?.alertChannels) assertChannelsAvailable(req.body.notifications.alertChannels);
  if (req.body.fees?.reminders?.channels) assertChannelsAvailable(req.body.fees.reminders.channels);
  const set = toDotPaths({ settings: req.body });
  await School.updateOne({ _id: req.tenant.schoolId }, { $set: set }, { runValidators: true });
  await recordAudit({ ...auditContext(req), action: 'school.settings_updated', entityType: 'School', entityId: req.tenant.schoolId, metadata: { changed: Object.keys(set) } });
  const school = await loadSchool(req.tenant.schoolId);
  return ok(res, school.settings, { message: 'Settings updated' });
});

export default router;
