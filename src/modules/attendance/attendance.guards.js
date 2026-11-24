import { AttendanceRecord, AttendanceSheet, LeaveRequest } from './attendance.models.js';
import { Enrollment } from '../students/student.model.js';
import { registerDeleteGuard, registerDeleteHook, countGuard } from '../../utils/dependencyGuards.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

registerDeleteGuard('section', countGuard((schoolId, id) => AttendanceSheet.countDocuments({ schoolId, sectionId: id }), (n) => `it has attendance for ${plural(n, 'day')}`));
registerDeleteGuard('session', countGuard((schoolId, id) => AttendanceSheet.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'attendance register')}`));
registerDeleteGuard('student', countGuard((schoolId, id) => AttendanceRecord.countDocuments({ schoolId, studentId: id }), (n) => `they have ${plural(n, 'attendance record')}. Mark the student withdrawn instead`));
registerDeleteGuard('enrollment', async (schoolId, enrollmentId) => {
  const e = await Enrollment.findOne({ _id: enrollmentId, schoolId }).lean();
  if (!e) return null;
  const n = await AttendanceRecord.countDocuments({ schoolId, studentId: e.studentId, sectionId: e.sectionId });
  return n ? `it has ${plural(n, 'attendance record')}` : null;
});

// Leave requests belong to the student record.
registerDeleteHook('student', (schoolId, studentId) => LeaveRequest.deleteMany({ schoolId, studentId }));
