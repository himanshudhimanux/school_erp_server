import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';

const { ObjectId } = mongoose.Schema.Types;
const actor = { createdBy: { type: ObjectId, ref: 'User' }, updatedBy: { type: ObjectId, ref: 'User' } };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Grading scale: percentage bands → grade. Bands are kept sorted by minPercent (highest first)
 * and must start at 0, so every percentage maps to exactly one grade.
 */
const gradingScaleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    bands: {
      type: [
        {
          _id: false,
          grade: { type: String, required: true, trim: true, maxlength: 10 },
          minPercent: { type: Number, required: true, min: 0, max: 100 },
          gradePoint: { type: Number, min: 0, max: 10, default: null },
          remark: { type: String, trim: true, maxlength: 60 },
        },
      ],
      validate: { validator: (v) => v.length >= 1 && v.length <= 20, message: 'A scale needs 1–20 bands' },
    },
    isDefault: { type: Boolean, default: false },
    ...actor,
  },
  { timestamps: true },
);
gradingScaleSchema.plugin(tenantPlugin);
gradingScaleSchema.index({ schoolId: 1, name: 1 }, { unique: true });
gradingScaleSchema.index({ schoolId: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });
export const GradingScale = mongoose.model('GradingScale', gradingScaleSchema);

export const EXAM_TYPES = ['unit_test', 'term', 'final', 'other'];

/**
 * An examination for some classes of a session (e.g. "Half Yearly").
 *  draft      being scheduled / marks being entered
 *  published  results frozen in ExamResult and visible to families
 * `marksLocked` stops marks entry (teachers) while results are reviewed.
 * `weightage` is used when combining a session's exams into one report card.
 */
const examSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    type: { type: String, enum: EXAM_TYPES, default: 'term' },
    classIds: { type: [{ type: ObjectId, ref: 'SchoolClass' }], validate: { validator: (v) => v.length >= 1 && v.length <= 50, message: 'Choose 1–50 classes' } },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    gradingScaleId: { type: ObjectId, ref: 'GradingScale', default: null },
    weightage: { type: Number, min: 0, max: 100, default: 100 },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    marksLocked: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: ObjectId, ref: 'User', default: null },
    description: { type: String, trim: true, maxlength: 500 },
    ...actor,
  },
  { timestamps: true },
);
examSchema.plugin(tenantPlugin);
examSchema.index({ schoolId: 1, sessionId: 1, name: 1 }, { unique: true });
examSchema.index({ schoolId: 1, classIds: 1, startDate: 1 });
export const Exam = mongoose.model('Exam', examSchema);

/** One paper: a subject of a class in an exam, with its date and marks. */
const paperSchema = new mongoose.Schema(
  {
    examId: { type: ObjectId, ref: 'Exam', required: true },
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    subjectId: { type: ObjectId, ref: 'Subject', required: true },
    date: { type: Date, required: true },
    startTime: { type: String, match: TIME, default: null },
    endTime: { type: String, match: TIME, default: null },
    maxMarks: { type: Number, required: true, min: 1, max: 1000 },
    passMarks: { type: Number, required: true, min: 0, max: 1000 },
    room: { type: String, trim: true, maxlength: 50 },
    ...actor,
  },
  { timestamps: true },
);
paperSchema.plugin(tenantPlugin);
paperSchema.index({ schoolId: 1, examId: 1, classId: 1, subjectId: 1 }, { unique: true });
paperSchema.index({ schoolId: 1, sessionId: 1, classId: 1, subjectId: 1 });
paperSchema.index({ schoolId: 1, classId: 1, date: 1 });
export const ExamPaper = mongoose.model('ExamPaper', paperSchema);

export const MARK_STATUSES = ['present', 'absent', 'exempt'];

/** A student's marks in one paper. `absent` counts as zero; `exempt` is left out of totals. */
const markSchema = new mongoose.Schema(
  {
    examId: { type: ObjectId, ref: 'Exam', required: true },
    paperId: { type: ObjectId, ref: 'ExamPaper', required: true },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    sectionId: { type: ObjectId, ref: 'Section', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    marks: { type: Number, min: 0, max: 1000, default: null },
    status: { type: String, enum: MARK_STATUSES, default: 'present' },
    remarks: { type: String, trim: true, maxlength: 200 },
    enteredBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
markSchema.plugin(tenantPlugin);
markSchema.index({ schoolId: 1, paperId: 1, studentId: 1 }, { unique: true });
markSchema.index({ schoolId: 1, examId: 1, sectionId: 1 });
markSchema.index({ schoolId: 1, studentId: 1, examId: 1 });
export const MarkEntry = mongoose.model('MarkEntry', markSchema);

/** Class teacher's remark for a student on an exam's report card. */
const remarkSchema = new mongoose.Schema(
  {
    examId: { type: ObjectId, ref: 'Exam', required: true },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    remark: { type: String, required: true, trim: true, maxlength: 500 },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
remarkSchema.plugin(tenantPlugin);
remarkSchema.index({ schoolId: 1, examId: 1, studentId: 1 }, { unique: true });
export const ExamRemark = mongoose.model('ExamRemark', remarkSchema);

/**
 * Published result of a student in an exam: a frozen snapshot taken at publication, so what
 * families see never changes silently. Unpublishing removes the snapshot.
 */
const resultSchema = new mongoose.Schema(
  {
    examId: { type: ObjectId, ref: 'Exam', required: true },
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    sectionId: { type: ObjectId, ref: 'Section', required: true },
    subjects: {
      type: [
        {
          _id: false,
          subjectId: { type: ObjectId, ref: 'Subject' },
          name: String,
          code: String,
          maxMarks: Number,
          passMarks: Number,
          marks: { type: Number, default: null },
          status: { type: String, enum: [...MARK_STATUSES, 'missing'] },
          percentage: { type: Number, default: null },
          grade: { type: String, default: null },
          passed: { type: Boolean, default: null },
        },
      ],
      validate: { validator: (v) => v.length <= 40, message: 'Too many subjects' },
    },
    total: { type: Number, required: true },
    maxTotal: { type: Number, required: true },
    percentage: { type: Number, default: null },
    grade: { type: String, default: null },
    gradePoint: { type: Number, default: null },
    result: { type: String, enum: ['pass', 'fail', 'incomplete'], required: true },
    rankInSection: { type: Number, default: null },
    rankInClass: { type: Number, default: null },
    remark: { type: String, default: null },
    publishedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
resultSchema.plugin(tenantPlugin);
resultSchema.index({ schoolId: 1, examId: 1, studentId: 1 }, { unique: true });
resultSchema.index({ schoolId: 1, studentId: 1, sessionId: 1 });
resultSchema.index({ schoolId: 1, examId: 1, sectionId: 1 });
export const ExamResult = mongoose.model('ExamResult', resultSchema);
