import { LeaveRequest, AttendanceRecord } from './attendance.models.js';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { AcademicSession } from '../academics/academics.models.js';
import { User } from '../users/user.model.js';
import { studentAccess, studentFilter, getStudentDoc, hasStaffRole } from '../students/access.js';
import { currentPlacement } from '../parents/guardian.service.js';
import { recomputeSheetCounts, attendanceSettings } from './attendance.service.js';
import { cancelUnsent } from '../notifications/notification.service.js';
import { todayIn } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const canReview = (tenant) => tenant.permissions.has('attendance.mark') || tenant.permissions.has('attendance.update');

async function decorate(schoolId, rows) {
  const studentIds = rows.map((r) => r.studentId);
  const current = await AcademicSession.findOne({ schoolId, isCurrent: true }).select('_id').lean();
  const [students, placement, users] = await Promise.all([
    Student.find({ schoolId, _id: { $in: studentIds } }).select('admissionNo firstName lastName').lean(),
    currentPlacement(schoolId, current?._id, studentIds),
    User.find({ _id: { $in: [...rows.map((r) => r.requestedBy), ...rows.map((r) => r.reviewedBy)].filter(Boolean) } }).select('name').lean(),
  ]);
  const sBy = new Map(students.map((s) => [String(s._id), s]));
  const uBy = new Map(users.map((u) => [String(u._id), u.name]));
  return rows.map((r) => {
    const s = sBy.get(String(r.studentId));
    return {
      _id: r._id,
      studentId: r.studentId,
      student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo, classSection: placement.get(String(s._id))?.displayName ?? null } : null,
      fromDate: r.fromDate,
      toDate: r.toDate,
      reason: r.reason,
      status: r.status,
      requestedVia: r.requestedVia,
      requestedBy: uBy.get(String(r.requestedBy)) ?? null,
      reviewedBy: r.reviewedBy ? uBy.get(String(r.reviewedBy)) ?? null : null,
      reviewedAt: r.reviewedAt,
      reviewNote: r.reviewNote ?? null,
      createdAt: r.createdAt,
    };
  });
}

/** Converts absences already marked in the leave period to "leave" and cancels unsent absence alerts. */
async function applyApprovedLeave(schoolId, leave) {
  const range = { $gte: leave.fromDate, $lte: leave.toDate };
  const affected = await AttendanceRecord.find({ schoolId, studentId: leave.studentId, date: range, status: 'absent' }).select('sheetId').lean();
  if (affected.length) {
    await AttendanceRecord.updateMany({ schoolId, studentId: leave.studentId, date: range, status: 'absent' }, { status: 'leave', leaveRequestId: leave._id });
    await recomputeSheetCounts(schoolId, affected.map((a) => a.sheetId));
  }
  await cancelUnsent(schoolId, { type: 'attendance.absent', 'data.studentId': leave.studentId, 'data.date': range });
  return affected.length;
}

/**
 * Creates a leave request. From the parent/student portal it starts as pending; staff who
 * enter one on a family's behalf (via 'staff') create it approved.
 */
export async function createLeave(tenant, { studentId, fromDate, toDate, reason }, ctx, { via = 'portal' } = {}) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  if (student.status !== 'active') throw ApiError.badRequest('Leave can only be requested for active students', { code: 'STUDENT_INACTIVE' });
  // Requests through the portal always wait for review, even from a staff member who is also a parent.
  const byStaff = via === 'staff' && hasStaffRole(tenant) && canReview(tenant);
  if (!byStaff) {
    const today = todayIn((await attendanceSettings(schoolId)).timezone);
    if (toDate < today) throw ApiError.badRequest('Leave for past dates must be recorded by the school', { code: 'PAST_LEAVE' });
  }
  const overlap = await LeaveRequest.exists({ schoolId, studentId: student._id, status: { $in: ['pending', 'approved'] }, fromDate: { $lte: toDate }, toDate: { $gte: fromDate } });
  if (overlap) throw ApiError.conflict('There is already a leave request for these dates', { code: 'LEAVE_OVERLAP' });

  const leave = await LeaveRequest.create({
    schoolId,
    studentId: student._id,
    fromDate,
    toDate,
    reason,
    status: byStaff ? 'approved' : 'pending',
    requestedBy: ctx.actorId,
    requestedVia: byStaff ? 'staff' : 'portal',
    reviewedBy: byStaff ? ctx.actorId : null,
    reviewedAt: byStaff ? new Date() : null,
  });
  const converted = byStaff ? await applyApprovedLeave(schoolId, leave) : 0;
  await recordAudit({ ...ctx, action: 'leave.requested', entityType: 'LeaveRequest', entityId: leave._id, metadata: { studentId: student._id, status: leave.status, converted } });
  const [row] = await decorate(schoolId, [leave.toObject()]);
  return row;
}

/** Staff: leave requests of students they can see. Family: their own children's requests. */
export async function listLeaves(tenant, { status, studentId, sectionId, page, limit }) {
  const schoolId = tenant.schoolId;
  const filter = { schoolId };
  if (status) filter.status = status;
  const access = await studentAccess(tenant);
  let allowed = null;
  if (access.restricted) allowed = (await Student.distinct('_id', { schoolId, ...studentFilter(access) })).map(String);
  if (sectionId) {
    const inSection = (await Enrollment.distinct('studentId', { schoolId, sectionId, status: 'active' })).map(String);
    allowed = allowed ? inSection.filter((id) => allowed.includes(id)) : inSection;
  }
  if (studentId) {
    if (allowed && !allowed.includes(String(studentId))) throw ApiError.notFound('Student not found');
    filter.studentId = studentId;
  } else if (allowed) filter.studentId = { $in: allowed };

  const [rows, total] = await Promise.all([
    LeaveRequest.find(filter).sort({ status: 1, fromDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    LeaveRequest.countDocuments(filter),
  ]);
  return { items: await decorate(schoolId, rows), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function getLeaveDoc(tenant, id) {
  const leave = await LeaveRequest.findOne({ _id: id, schoolId: tenant.schoolId });
  if (!leave) throw ApiError.notFound('Leave request not found');
  await getStudentDoc(tenant, leave.studentId); // access check (404 outside scope)
  return leave;
}

export async function reviewLeave(tenant, id, { status, note }, ctx) {
  const leave = await getLeaveDoc(tenant, id);
  if (leave.status !== 'pending') throw ApiError.badRequest(`This request is already ${leave.status}`, { code: 'LEAVE_NOT_PENDING' });
  leave.set({ status, reviewNote: note, reviewedBy: ctx.actorId, reviewedAt: new Date() });
  await leave.save();
  const converted = status === 'approved' ? await applyApprovedLeave(tenant.schoolId, leave) : 0;
  await recordAudit({ ...ctx, action: `leave.${status}`, entityType: 'LeaveRequest', entityId: leave._id, metadata: { studentId: leave.studentId, converted } });
  const [row] = await decorate(tenant.schoolId, [leave.toObject()]);
  return { ...row, recordsConverted: converted };
}

/** The requester (or staff) withdraws a request. Approved leave can be cancelled until it starts. */
export async function cancelLeave(tenant, id, ctx) {
  const leave = await getLeaveDoc(tenant, id);
  const isStaff = hasStaffRole(tenant) && canReview(tenant);
  if (!isStaff && String(leave.requestedBy) !== String(ctx.actorId)) throw ApiError.forbidden('You can only cancel your own requests', { code: 'NOT_REQUESTER' });
  if (!['pending', 'approved'].includes(leave.status)) throw ApiError.badRequest(`This request is already ${leave.status}`, { code: 'LEAVE_NOT_CANCELLABLE' });
  if (leave.status === 'approved') {
    const today = todayIn((await attendanceSettings(tenant.schoolId)).timezone);
    if (leave.fromDate <= today) throw ApiError.badRequest('Leave that has already started cannot be cancelled', { code: 'LEAVE_STARTED' });
  }
  leave.status = 'cancelled';
  await leave.save();
  await recordAudit({ ...ctx, action: 'leave.cancelled', entityType: 'LeaveRequest', entityId: leave._id, metadata: { studentId: leave.studentId } });
  const [row] = await decorate(tenant.schoolId, [leave.toObject()]);
  return row;
}
