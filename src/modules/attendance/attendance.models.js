import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';

const { ObjectId } = mongoose.Schema.Types;

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave'];

/** One submitted register: a section on a date (daily attendance). */
const sheetSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    sectionId: { type: ObjectId, ref: 'Section', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    date: { type: Date, required: true },
    counts: {
      total: { type: Number, default: 0 },
      present: { type: Number, default: 0 },
      absent: { type: Number, default: 0 },
      late: { type: Number, default: 0 },
      leave: { type: Number, default: 0 },
    },
    markedBy: { type: ObjectId, ref: 'User' },
    markedAt: { type: Date },
    updatedBy: { type: ObjectId, ref: 'User' },
    submissions: { type: Number, default: 1 },
  },
  { timestamps: true },
);
sheetSchema.plugin(tenantPlugin);
sheetSchema.index({ schoolId: 1, sectionId: 1, date: 1 }, { unique: true });
sheetSchema.index({ schoolId: 1, date: 1, campusId: 1 });
sheetSchema.index({ schoolId: 1, sessionId: 1 });
export const AttendanceSheet = mongoose.model('AttendanceSheet', sheetSchema);

/** A student's status on a date. One per student per day. */
const recordSchema = new mongoose.Schema(
  {
    sheetId: { type: ObjectId, ref: 'AttendanceSheet', required: true },
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    sectionId: { type: ObjectId, ref: 'Section', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    date: { type: Date, required: true },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    remark: { type: String, trim: true, maxlength: 200 },
    leaveRequestId: { type: ObjectId, ref: 'LeaveRequest', default: null },
    markedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
recordSchema.plugin(tenantPlugin);
recordSchema.index({ schoolId: 1, studentId: 1, date: 1 }, { unique: true });
recordSchema.index({ schoolId: 1, sectionId: 1, date: 1 });
recordSchema.index({ schoolId: 1, sessionId: 1, studentId: 1, status: 1 });
recordSchema.index({ schoolId: 1, sheetId: 1 });
export const AttendanceRecord = mongoose.model('AttendanceRecord', recordSchema);

/**
 * Leave application for a student (from a parent through the portal, or entered by staff).
 * Approved leave pre-fills "leave" when attendance is taken and converts absences already marked.
 */
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

const leaveSchema = new mongoose.Schema(
  {
    studentId: { type: ObjectId, ref: 'Student', required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: LEAVE_STATUSES, default: 'pending' },
    requestedBy: { type: ObjectId, ref: 'User', required: true },
    requestedVia: { type: String, enum: ['portal', 'staff'], required: true },
    reviewedBy: { type: ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);
leaveSchema.plugin(tenantPlugin);
leaveSchema.index({ schoolId: 1, studentId: 1, fromDate: 1 });
leaveSchema.index({ schoolId: 1, status: 1, fromDate: 1 });
export const LeaveRequest = mongoose.model('LeaveRequest', leaveSchema);
