import { Router } from 'express';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { Guardian, StudentGuardian } from '../parents/guardian.model.js';
import { AcademicSession, Section } from '../academics/academics.models.js';
import { decorateEnrollments } from '../students/enrollment.service.js';
import { teacherMap } from '../academics/academics.common.js';
import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { ok, created } from '../../utils/response.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { paginationQuery } from '../../utils/pagination.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { FAMILY_ROLE_VALUES } from '../../constants/roles.js';
import { familyStudentIds } from '../students/access.js';
import { studentAttendance } from '../attendance/attendance.service.js';
import * as leaves from '../attendance/leave.service.js';
import { leaveSchema, rangeQuery } from '../attendance/attendance.routes.js';
import { LEAVE_STATUSES } from '../attendance/attendance.models.js';
import { sectionTimetable } from '../timetable/timetable.service.js';
import { listInbox, markRead, markAllRead } from '../notifications/notification.service.js';
import { Payment } from '../fees/fee.models.js';
import { familyLoans } from '../library/library.service.js';
import { familyHostel } from '../hostel/hostel.service.js';
import { studentExamSchedule, studentResults, examReportCard, sessionReportCard } from '../exams/marks.service.js';
import { studentFeeAccount, receiptFor } from '../fees/payment.service.js';
import { getGatewaySettings, createOrder, verifyCheckout } from '../fees/gateway.service.js';

/**
 * The caller acting only as a family member: staff roles and permissions are dropped, so a
 * teacher who is also a parent sees exactly what any parent sees through the portal.
 */
const familyTenant = (t) => ({ ...t, roles: t.roles.filter((r) => FAMILY_ROLE_VALUES.includes(r)), customRoles: [], permissions: new Set(), campusIds: [] });

/**
 * Family portal: what a signed-in parent or student may see about themselves.
 * Access is decided by the record linked to the caller's own membership, never by ids sent
 * from the client.
 */
const router = Router();

async function childCard(schoolId, student, session, link) {
  const enrollment = session ? await Enrollment.findOne({ schoolId, studentId: student._id, sessionId: session._id, status: 'active' }).lean() : null;
  let current = null;
  if (enrollment) {
    const [row] = await decorateEnrollments(schoolId, [enrollment]);
    const section = await Section.findOne({ _id: enrollment.sectionId, schoolId }).select('classTeacherId').lean();
    const teachers = await teacherMap(schoolId, [section?.classTeacherId]);
    const ct = section?.classTeacherId ? teachers.get(String(section.classTeacherId)) : null;
    current = { ...row, classTeacher: ct ? { name: ct.name } : null };
  }
  return {
    studentId: student._id,
    admissionNo: student.admissionNo,
    name: fullName(student),
    firstName: student.firstName,
    lastName: student.lastName,
    gender: student.gender,
    dateOfBirth: student.dateOfBirth,
    status: student.status,
    photoUrl: student.photoUrl ?? null,
    relation: link?.relation,
    currentEnrollment: current,
  };
}

router.get('/children', async (req, res) => {
  const { schoolId, membershipId, roles } = req.tenant;
  if (!roles.includes('parent')) throw ApiError.forbidden('Only parents can view linked children', { code: 'NOT_A_PARENT' });
  const guardian = await Guardian.findOne({ schoolId, membershipId }).lean();
  if (!guardian) return ok(res, { parent: null, children: [] });
  const links = await StudentGuardian.find({ schoolId, guardianId: guardian._id }).lean();
  const students = await Student.find({ schoolId, _id: { $in: links.map((l) => l.studentId) } }).sort({ firstName: 1 }).lean();
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  const linkBy = new Map(links.map((l) => [String(l.studentId), l]));
  const children = await Promise.all(students.map((s) => childCard(schoolId, s, session, linkBy.get(String(s._id)))));
  return ok(res, {
    parent: { id: guardian._id, name: guardian.name, phone: guardian.phone, email: guardian.email ?? null },
    session: session ? { id: session._id, name: session.name } : null,
    children,
  });
});

router.get('/student', async (req, res) => {
  const { schoolId, membershipId, roles } = req.tenant;
  if (!roles.includes('student')) throw ApiError.forbidden('Only students can view this profile', { code: 'NOT_A_STUDENT' });
  const student = await Student.findOne({ schoolId, membershipId }).lean();
  if (!student) throw ApiError.notFound('No student record is linked to this account');
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  return ok(res, { session: session ? { id: session._id, name: session.name } : null, student: await childCard(schoolId, student, session) });
});

/* ------------------------------ family data ------------------------------ */

/**
 * Resolves which child a request is about: the given studentId if it belongs to the caller's
 * family, or the only child when there is exactly one.
 */
async function familyStudent(tenant, studentId) {
  const ids = await familyStudentIds(tenant);
  if (studentId) {
    if (!ids.includes(String(studentId))) throw ApiError.notFound('Student not found');
    return studentId;
  }
  if (ids.length === 1) return ids[0];
  if (!ids.length) throw ApiError.notFound('No student is linked to this account');
  throw ApiError.badRequest('Choose a child (studentId)', { code: 'STUDENT_REQUIRED' });
}

const studentQuery = z.object({ studentId: objectId.optional() });

router.get('/attendance', requirePermission('attendance.read'), validate({ query: rangeQuery.extend({ studentId: objectId.optional() }) }), async (req, res) => {
  const { studentId, ...range } = req.validatedQuery;
  return ok(res, await studentAttendance(familyTenant(req.tenant), await familyStudent(req.tenant, studentId), range));
});

router.get('/leave-requests', requirePermission('attendance.read'), validate({ query: paginationQuery.extend({ studentId: objectId.optional(), status: z.enum(LEAVE_STATUSES).optional() }) }), async (req, res) => {
  const q = req.validatedQuery;
  if (q.studentId) await familyStudent(req.tenant, q.studentId);
  const ids = await familyStudentIds(req.tenant);
  if (!ids.length) return ok(res, [], { meta: { page: q.page, limit: q.limit, total: 0, totalPages: 0 } });
  const { items, meta } = await leaves.listLeaves(familyTenant(req.tenant), q);
  return ok(res, items, { meta });
});
router.post('/leave-requests', requirePermission('attendance.read'), validate({ body: leaveSchema }), async (req, res) => {
  await familyStudent(req.tenant, req.body.studentId);
  return created(res, await leaves.createLeave(familyTenant(req.tenant), req.body, auditContext(req), { via: 'portal' }), 'Leave request sent');
});
router.post('/leave-requests/:id/cancel', requirePermission('attendance.read'), validate({ params: z.object({ id: objectId }) }), async (req, res) =>
  ok(res, await leaves.cancelLeave(familyTenant(req.tenant), req.params.id, auditContext(req)), { message: 'Leave request cancelled' }),
);

router.get('/timetable', requirePermission('timetable.read'), validate({ query: studentQuery }), async (req, res) => {
  const { schoolId } = req.tenant;
  const studentId = await familyStudent(req.tenant, req.validatedQuery.studentId);
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  const enrollment = session && (await Enrollment.findOne({ schoolId, studentId, sessionId: session._id, status: 'active' }).lean());
  if (!enrollment) return ok(res, { section: null, schedule: null, entries: [] });
  const section = await Section.findOne({ _id: enrollment.sectionId, schoolId }).lean();
  return ok(res, await sectionTimetable(schoolId, section));
});

/* ------------------------------ fees ------------------------------ */
router.get('/fees', requirePermission('fees.read'), validate({ query: studentQuery }), async (req, res) => {
  const studentId = await familyStudent(req.tenant, req.validatedQuery.studentId);
  const [account, gw] = await Promise.all([studentFeeAccount(familyTenant(req.tenant), studentId), getGatewaySettings(req.tenant.schoolId)]);
  return ok(res, { ...account, onlinePayment: { available: gw.configured && gw.enabled } });
});
router.get('/fees/payments/:id/receipt', requirePermission('fees.read'), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, schoolId: req.tenant.schoolId }).lean();
  const family = await familyStudentIds(req.tenant);
  if (!payment || !family.includes(String(payment.studentId))) throw ApiError.notFound('Receipt not found');
  return ok(res, await receiptFor(req.tenant.schoolId, payment));
});
router.post('/fees/orders', requirePermission('fees.read'), validate({ body: z.object({ studentId: objectId.optional(), invoiceIds: z.array(objectId).min(1).max(20) }).strict() }), async (req, res) => {
  const studentId = await familyStudent(req.tenant, req.body.studentId);
  return created(res, await createOrder(req.tenant, studentId, req.body.invoiceIds, auditContext(req)), 'Payment order created');
});
router.post(
  '/fees/orders/verify',
  requirePermission('fees.read'),
  validate({ body: z.object({ orderId: z.string().trim().min(5).max(60), paymentId: z.string().trim().min(5).max(60), signature: z.string().trim().length(64) }).strict() }),
  async (req, res) => ok(res, await verifyCheckout(req.tenant, req.body, auditContext(req), await familyStudentIds(req.tenant)), { message: 'Payment successful' }),
);

/* ------------------------------ exams ------------------------------ */
// Families see published results only (exam drafts and live previews are staff-only).
router.get('/exams', requirePermission('exams.read'), validate({ query: studentQuery }), async (req, res) =>
  ok(res, await studentExamSchedule(familyTenant(req.tenant), await familyStudent(req.tenant, req.validatedQuery.studentId))),
);
router.get('/results', requirePermission('exams.read'), validate({ query: studentQuery.extend({ sessionId: objectId.optional() }) }), async (req, res) => {
  const { studentId, ...q } = req.validatedQuery;
  return ok(res, await studentResults(familyTenant(req.tenant), await familyStudent(req.tenant, studentId), q));
});
router.get('/results/:examId', requirePermission('exams.read'), validate({ params: z.object({ examId: objectId }), query: studentQuery }), async (req, res) =>
  ok(res, await examReportCard(familyTenant(req.tenant), req.params.examId, await familyStudent(req.tenant, req.validatedQuery.studentId), { family: true })),
);
router.get('/report-card', requirePermission('exams.read'), validate({ query: studentQuery.extend({ sessionId: objectId.optional() }) }), async (req, res) => {
  const { studentId, ...q } = req.validatedQuery;
  return ok(res, await sessionReportCard(familyTenant(req.tenant), await familyStudent(req.tenant, studentId), q));
});

/* ------------------------------ library & hostel ------------------------------ */
router.get('/library', requirePermission('library.read'), validate({ query: studentQuery }), async (req, res) => ok(res, await familyLoans(req.tenant, req.validatedQuery.studentId)));
router.get('/hostel', requirePermission('hostel.read'), validate({ query: studentQuery }), async (req, res) => ok(res, await familyHostel(req.tenant, req.validatedQuery.studentId)));

/* ------------------------------ inbox ------------------------------ */
router.get('/notifications', validate({ query: paginationQuery.extend({ unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }), async (req, res) => {
  const { items, meta } = await listInbox(req.tenant, req.validatedQuery);
  return ok(res, items, { meta });
});
router.post('/notifications/read-all', async (req, res) => ok(res, await markAllRead(req.tenant), { message: 'All notifications marked as read' }));
router.post('/notifications/:id/read', validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  await markRead(req.tenant, req.params.id);
  return ok(res, null, { message: 'Marked as read' });
});

export default router;
