import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../middleware/authenticate.js';
import { requireTenant } from '../middleware/tenant.js';
import { ok } from '../utils/response.js';
import authRoutes from '../modules/auth/auth.routes.js';
import platformRoutes from '../modules/platform/platform.routes.js';
import schoolRoutes from '../modules/schools/school.routes.js';
import campusRoutes from '../modules/campuses/campus.routes.js';
import roleRoutes from '../modules/roles/role.routes.js';
import membershipRoutes from '../modules/memberships/membership.routes.js';
import subscriptionRoutes from '../modules/subscriptions/subscription.routes.js';
import auditRoutes from '../modules/audit/audit.routes.js';
import academicsRoutes from '../modules/academics/academics.routes.js';
import calendarRoutes from '../modules/calendar/calendar.routes.js';
import studentRoutes from '../modules/students/student.routes.js';
import guardianRoutes from '../modules/parents/guardian.routes.js';
import admissionRoutes from '../modules/admissions/admission.routes.js';
import staffRoutes from '../modules/staff/staff.routes.js';
import portalRoutes from '../modules/portal/portal.routes.js';
import attendanceRoutes from '../modules/attendance/attendance.routes.js';
import timetableRoutes from '../modules/timetable/timetable.routes.js';
import feeRoutes from '../modules/fees/fee.routes.js';
import webhookRoutes from '../modules/fees/webhook.routes.js';
import examRoutes from '../modules/exams/exam.routes.js';
import libraryRoutes from '../modules/library/library.routes.js';
import inventoryRoutes from '../modules/inventory/inventory.routes.js';
import hostelRoutes from '../modules/hostel/hostel.routes.js';
import hrRoutes from '../modules/hr/hr.routes.js';
import communicationRoutes from '../modules/communication/communication.routes.js';
import reportRoutes from '../modules/reports/report.routes.js';
import { deviceRoutes, twilioWebhookRoutes } from '../modules/notifications/notification.routes.js';
import { tenantSummary } from '../modules/memberships/membership.service.js';

const router = Router();

router.get('/health', (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ success: dbUp, message: dbUp ? 'OK' : 'Database unavailable', data: { uptime: Math.round(process.uptime()), db: dbUp ? 'up' : 'down' } });
});

router.use('/auth', authRoutes);
router.use('/platform', platformRoutes);
// Public, signature-authenticated callbacks from payment providers.
router.use('/webhooks', webhookRoutes);
router.use('/webhooks/twilio', twilioWebhookRoutes);
// Push devices belong to the signed-in user, not to a school.
router.use('/devices', deviceRoutes);

/**
 * School-scoped API. Every route below runs with a verified tenant context (req.tenant).
 * Future module routers (academics, students, fees, ...) are mounted here.
 */
const tenant = Router();
tenant.use(authenticate, requireTenant);
tenant.get('/context', (req, res) => ok(res, tenantSummary(req.tenant)));
tenant.use('/school', schoolRoutes);
tenant.use('/campuses', campusRoutes);
tenant.use('/roles', roleRoutes);
tenant.use('/members', membershipRoutes);
tenant.use('/subscription', subscriptionRoutes);
tenant.use('/audit-logs', auditRoutes);
tenant.use('/academics', academicsRoutes);
tenant.use('/calendar', calendarRoutes);
tenant.use('/students', studentRoutes);
tenant.use('/parents', guardianRoutes);
tenant.use('/admissions', admissionRoutes);
tenant.use('/staff', staffRoutes);
tenant.use('/portal', portalRoutes);
tenant.use('/attendance', attendanceRoutes);
tenant.use('/timetable', timetableRoutes);
tenant.use('/fees', feeRoutes);
tenant.use('/exams', examRoutes);
tenant.use('/library', libraryRoutes);
tenant.use('/inventory', inventoryRoutes);
tenant.use('/hostels', hostelRoutes);
tenant.use('/hr', hrRoutes);
tenant.use('/communication', communicationRoutes);
tenant.use('/reports', reportRoutes);

router.use('/', tenant);

export default router;
