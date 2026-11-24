import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';
import { GENDERS } from '../common/person.schema.js';
import { RELATIONS } from '../parents/guardian.model.js';

const { ObjectId } = mongoose.Schema.Types;

export const ADMISSION_STATUSES = ['enquiry', 'applied', 'under_review', 'approved', 'rejected', 'withdrawn', 'enrolled'];
export const ADMISSION_SOURCES = ['walk_in', 'phone', 'website', 'referral', 'advertisement', 'other'];

/** Allowed manual status changes. `enrolled` is reached only through the enroll action. */
export const STATUS_TRANSITIONS = {
  enquiry: ['applied', 'rejected', 'withdrawn'],
  applied: ['under_review', 'approved', 'rejected', 'withdrawn'],
  under_review: ['approved', 'rejected', 'withdrawn'],
  approved: ['under_review', 'rejected', 'withdrawn'],
  rejected: ['applied'],
  withdrawn: ['applied'],
  enrolled: [],
};
export const MAX_HISTORY = 50;

const admissionSchema = new mongoose.Schema(
  {
    applicationNo: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', required: true },
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    applicant: {
      firstName: { type: String, required: true, trim: true, maxlength: 60 },
      lastName: { type: String, trim: true, maxlength: 60, default: '' },
      gender: { type: String, enum: GENDERS, required: true },
      dateOfBirth: { type: Date, default: null },
      previousSchool: { type: String, trim: true, maxlength: 200 },
    },
    guardian: {
      name: { type: String, required: true, trim: true, maxlength: 120 },
      phone: { type: String, required: true, trim: true, maxlength: 20 },
      phoneNormalized: { type: String, required: true, maxlength: 20 },
      email: { type: String, trim: true, lowercase: true, maxlength: 254 },
      relation: { type: String, enum: RELATIONS, default: 'guardian' },
      occupation: { type: String, trim: true, maxlength: 100 },
    },
    source: { type: String, enum: ADMISSION_SOURCES, default: 'walk_in' },
    status: { type: String, enum: ADMISSION_STATUSES, default: 'enquiry' },
    followUpDate: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 2000 },
    // Bounded status trail (MAX_HISTORY entries); the audit log has the full history.
    history: {
      type: [
        {
          _id: false,
          status: { type: String, enum: ADMISSION_STATUSES },
          note: { type: String, trim: true, maxlength: 500 },
          at: { type: Date, default: () => new Date() },
          by: { type: ObjectId, ref: 'User' },
        },
      ],
      default: [],
    },
    studentId: { type: ObjectId, ref: 'Student', default: null },
    enrolledAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
admissionSchema.plugin(tenantPlugin);
admissionSchema.plugin(softDeletePlugin);
admissionSchema.index({ schoolId: 1, applicationNo: 1 }, { unique: true });
admissionSchema.index({ schoolId: 1, sessionId: 1, status: 1, createdAt: -1 });
admissionSchema.index({ schoolId: 1, 'guardian.phoneNormalized': 1 });
admissionSchema.index({ schoolId: 1, campusId: 1 });
admissionSchema.index({ schoolId: 1, classId: 1 });
admissionSchema.index({ schoolId: 1, followUpDate: 1 });
export const Admission = mongoose.model('Admission', admissionSchema);
