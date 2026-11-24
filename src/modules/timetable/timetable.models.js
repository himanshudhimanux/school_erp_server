import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';

const { ObjectId } = mongoose.Schema.Types;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Bell schedule: the periods of a school day and the days classes run, per session.
 * `campusId: null` is the school default; a campus-specific schedule overrides it.
 * Days use 0 = Sunday … 6 = Saturday, like the attendance settings.
 */
const periodSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, min: 1, max: 20 },
    label: { type: String, trim: true, maxlength: 40 },
    startTime: { type: String, required: true, match: TIME },
    endTime: { type: String, required: true, match: TIME },
    isBreak: { type: Boolean, default: false },
  },
  { _id: false },
);

const bellScheduleSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    campusId: { type: ObjectId, ref: 'Campus', default: null },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    workingDays: { type: [{ type: Number, min: 0, max: 6 }], default: [1, 2, 3, 4, 5, 6] },
    periods: { type: [periodSchema], validate: { validator: (v) => v.length >= 1 && v.length <= 20, message: 'A schedule needs 1–20 periods' } },
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
bellScheduleSchema.plugin(tenantPlugin);
bellScheduleSchema.index({ schoolId: 1, sessionId: 1, campusId: 1 }, { unique: true });
export const BellSchedule = mongoose.model('BellSchedule', bellScheduleSchema);

/** One timetable cell: a section's subject (and teacher) in a period on a weekday. */
const entrySchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    sectionId: { type: ObjectId, ref: 'Section', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    day: { type: Number, required: true, min: 0, max: 6 },
    periodNumber: { type: Number, required: true, min: 1, max: 20 },
    subjectId: { type: ObjectId, ref: 'Subject', required: true },
    teacherId: { type: ObjectId, ref: 'Membership', default: null },
    room: { type: String, trim: true, maxlength: 50 },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
entrySchema.plugin(tenantPlugin);
entrySchema.index({ schoolId: 1, sectionId: 1, day: 1, periodNumber: 1 }, { unique: true });
// A teacher can be in only one class per period.
entrySchema.index(
  { schoolId: 1, sessionId: 1, teacherId: 1, day: 1, periodNumber: 1 },
  { unique: true, name: 'uniq_teacher_slot', partialFilterExpression: { teacherId: { $type: 'objectId' } } },
);
entrySchema.index({ schoolId: 1, sessionId: 1, campusId: 1 });
entrySchema.index({ schoolId: 1, subjectId: 1 });
export const TimetableEntry = mongoose.model('TimetableEntry', entrySchema);
