import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';
import { addressSchema, GENDERS, BLOOD_GROUPS } from '../common/person.schema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * Student status:
 *  active      currently studying (counts toward the plan's maxStudents)
 *  inactive    temporarily not attending (long leave etc.)
 *  alumni      completed school
 *  transferred left for another school (TC issued)
 *  withdrawn   left without completing
 */
export const STUDENT_STATUSES = ['active', 'inactive', 'alumni', 'transferred', 'withdrawn'];
export const LEFT_STATUSES = ['alumni', 'transferred', 'withdrawn'];

const studentSchema = new mongoose.Schema(
  {
    admissionNo: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, trim: true, maxlength: 60, default: '' },
    gender: { type: String, enum: GENDERS, required: true },
    dateOfBirth: { type: Date, default: null },
    bloodGroup: { type: String, enum: [...BLOOD_GROUPS, null], default: null },
    // Home campus. Follows the current-session enrollment (see enrollment.service).
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    admissionDate: { type: Date, required: true },
    status: { type: String, enum: STUDENT_STATUSES, default: 'active' },
    leftOn: { type: Date, default: null },
    leavingReason: { type: String, trim: true, maxlength: 300 },
    phone: { type: String, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    address: { type: addressSchema, default: undefined },
    nationality: { type: String, trim: true, maxlength: 60 },
    religion: { type: String, trim: true, maxlength: 60 },
    category: { type: String, trim: true, maxlength: 60 },
    previousSchool: { type: String, trim: true, maxlength: 200 },
    medicalNotes: { type: String, trim: true, maxlength: 1000 },
    notes: { type: String, trim: true, maxlength: 1000 },
    photoUrl: { type: String, trim: true, maxlength: 500 },
    // Student portal login (Membership with role 'student').
    membershipId: { type: ObjectId, ref: 'Membership', default: null },
    admissionId: { type: ObjectId, ref: 'Admission', default: null },
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
studentSchema.plugin(tenantPlugin);
studentSchema.plugin(softDeletePlugin);
studentSchema.index({ schoolId: 1, admissionNo: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
studentSchema.index({ schoolId: 1, status: 1, firstName: 1, lastName: 1 });
// Default student list: every non-deleted student sorted by name (count and page both use it).
studentSchema.index({ schoolId: 1, isDeleted: 1, firstName: 1, lastName: 1, _id: 1 });
studentSchema.index({ schoolId: 1, campusId: 1, status: 1 });
studentSchema.index({ schoolId: 1, membershipId: 1 }, { unique: true, partialFilterExpression: { membershipId: { $type: 'objectId' } } });
export const Student = mongoose.model('Student', studentSchema);

export const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(' ');

/**
 * A student's placement for one academic session (one per student per session).
 *  active    studying in this section
 *  promoted  moved on to the next session (kept for history)
 *  completed finished the session without promotion (final year, detained)
 *  left      left during the session
 */
export const ENROLLMENT_STATUSES = ['active', 'promoted', 'completed', 'left'];

const enrollmentSchema = new mongoose.Schema(
  {
    studentId: { type: ObjectId, ref: 'Student', required: true },
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    sectionId: { type: ObjectId, ref: 'Section', required: true },
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    rollNo: { type: Number, min: 1, max: 9999, default: null },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: 'active' },
    enrolledOn: { type: Date, default: () => new Date() },
    endedOn: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
enrollmentSchema.plugin(tenantPlugin);
enrollmentSchema.index({ schoolId: 1, studentId: 1, sessionId: 1 }, { unique: true });
enrollmentSchema.index({ schoolId: 1, sectionId: 1, status: 1, rollNo: 1 });
// Roll numbers are unique among the active students of a section.
enrollmentSchema.index(
  { schoolId: 1, sectionId: 1, rollNo: 1 },
  { unique: true, name: 'uniq_active_rollno', partialFilterExpression: { rollNo: { $type: 'number' }, status: 'active' } },
);
enrollmentSchema.index({ schoolId: 1, sessionId: 1, classId: 1, status: 1 });
enrollmentSchema.index({ schoolId: 1, campusId: 1 });
export const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
