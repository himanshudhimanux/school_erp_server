import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';

const { ObjectId } = mongoose.Schema.Types;
const audit = { createdBy: { type: ObjectId, ref: 'User' }, updatedBy: { type: ObjectId, ref: 'User' } };

/* ------------------------------------------------------------------ */
/* Academic session (e.g. "2026-27")                                   */
/* ------------------------------------------------------------------ */
export const SESSION_STATUSES = ['planned', 'active', 'closed'];

const sessionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 50 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: SESSION_STATUSES, default: 'planned' },
    // Exactly one current session per school (the default for lists, attendance, fees).
    isCurrent: { type: Boolean, default: false },
    ...audit,
  },
  { timestamps: true },
);
sessionSchema.plugin(tenantPlugin);
sessionSchema.index({ schoolId: 1, name: 1 }, { unique: true });
sessionSchema.index({ schoolId: 1, isCurrent: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });
sessionSchema.index({ schoolId: 1, startDate: -1 });
export const AcademicSession = mongoose.model('AcademicSession', sessionSchema);

/* ------------------------------------------------------------------ */
/* Class / grade (school-wide, reused every session)                   */
/* ------------------------------------------------------------------ */
const classSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20, match: /^[A-Z0-9][A-Z0-9-]*$/ },
    // Display / promotion order: Nursery=0, LKG=1, ..., Grade 12=14.
    order: { type: Number, required: true, min: 0, max: 1000 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    description: { type: String, trim: true, maxlength: 300 },
    ...audit,
  },
  { timestamps: true },
);
classSchema.plugin(tenantPlugin);
classSchema.plugin(softDeletePlugin);
classSchema.index({ schoolId: 1, code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
classSchema.index({ schoolId: 1, order: 1 });
export const SchoolClass = mongoose.model('SchoolClass', classSchema);

/* ------------------------------------------------------------------ */
/* Subject (school-wide)                                               */
/* ------------------------------------------------------------------ */
export const SUBJECT_TYPES = ['theory', 'practical', 'theory_practical', 'activity'];

const subjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20, match: /^[A-Z0-9][A-Z0-9-]*$/ },
    type: { type: String, enum: SUBJECT_TYPES, default: 'theory' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    description: { type: String, trim: true, maxlength: 300 },
    ...audit,
  },
  { timestamps: true },
);
subjectSchema.plugin(tenantPlugin);
subjectSchema.plugin(softDeletePlugin);
subjectSchema.index({ schoolId: 1, code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
subjectSchema.index({ schoolId: 1, name: 1 });
export const Subject = mongoose.model('Subject', subjectSchema);

/* ------------------------------------------------------------------ */
/* Section: a class in a session at a campus (e.g. Grade 5-A, 2026-27) */
/* ------------------------------------------------------------------ */
const sectionSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    name: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    capacity: { type: Number, min: 1, max: 500, default: null },
    room: { type: String, trim: true, maxlength: 50 },
    // Membership id of the class teacher (homeroom).
    classTeacherId: { type: ObjectId, ref: 'Membership', default: null },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    ...audit,
  },
  { timestamps: true },
);
sectionSchema.plugin(tenantPlugin);
sectionSchema.index({ schoolId: 1, sessionId: 1, classId: 1, campusId: 1, name: 1 }, { unique: true });
sectionSchema.index({ schoolId: 1, sessionId: 1, campusId: 1 });
sectionSchema.index({ schoolId: 1, classTeacherId: 1 });
export const Section = mongoose.model('Section', sectionSchema);

/* ------------------------------------------------------------------ */
/* Class ↔ subject mapping for a session (curriculum)                  */
/* ------------------------------------------------------------------ */
const classSubjectSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    subjectId: { type: ObjectId, ref: 'Subject', required: true },
    isOptional: { type: Boolean, default: false },
    periodsPerWeek: { type: Number, min: 0, max: 60, default: null },
    order: { type: Number, min: 0, default: 0 },
    ...audit,
  },
  { timestamps: true },
);
classSubjectSchema.plugin(tenantPlugin);
classSubjectSchema.index({ schoolId: 1, sessionId: 1, classId: 1, subjectId: 1 }, { unique: true });
classSubjectSchema.index({ schoolId: 1, subjectId: 1 });
export const ClassSubject = mongoose.model('ClassSubject', classSubjectSchema);

/* ------------------------------------------------------------------ */
/* Teaching assignment: teacher teaches a subject to a section         */
/* ------------------------------------------------------------------ */
const teachingAssignmentSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    sectionId: { type: ObjectId, ref: 'Section', required: true },
    subjectId: { type: ObjectId, ref: 'Subject', required: true },
    teacherId: { type: ObjectId, ref: 'Membership', required: true },
    ...audit,
  },
  { timestamps: true },
);
teachingAssignmentSchema.plugin(tenantPlugin);
// Co-teaching is allowed (several teachers per section-subject), but not duplicates.
teachingAssignmentSchema.index({ schoolId: 1, sectionId: 1, subjectId: 1, teacherId: 1 }, { unique: true });
teachingAssignmentSchema.index({ schoolId: 1, sessionId: 1, teacherId: 1 });
export const TeachingAssignment = mongoose.model('TeachingAssignment', teachingAssignmentSchema);
