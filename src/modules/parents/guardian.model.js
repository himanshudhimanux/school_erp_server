import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';
import { addressSchema } from '../common/person.schema.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A parent or guardian. One guardian can be linked to several students (siblings) through
 * StudentGuardian, so the relationship is never an unbounded array on either side.
 */
const guardianSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    // Phone without spaces/dashes, for duplicate detection and search.
    phoneNormalized: { type: String, required: true, maxlength: 20 },
    alternatePhone: { type: String, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    occupation: { type: String, trim: true, maxlength: 100 },
    address: { type: addressSchema, default: undefined },
    notes: { type: String, trim: true, maxlength: 1000 },
    // Parent portal login (Membership with role 'parent').
    membershipId: { type: ObjectId, ref: 'Membership', default: null },
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
guardianSchema.plugin(tenantPlugin);
guardianSchema.plugin(softDeletePlugin);
guardianSchema.index({ schoolId: 1, phoneNormalized: 1 });
guardianSchema.index({ schoolId: 1, name: 1 });
guardianSchema.index({ schoolId: 1, email: 1 });
guardianSchema.index({ schoolId: 1, membershipId: 1 }, { unique: true, partialFilterExpression: { membershipId: { $type: 'objectId' } } });
export const Guardian = mongoose.model('Guardian', guardianSchema);

export const RELATIONS = ['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other'];
export const MAX_GUARDIANS_PER_STUDENT = 6;

const studentGuardianSchema = new mongoose.Schema(
  {
    studentId: { type: ObjectId, ref: 'Student', required: true },
    guardianId: { type: ObjectId, ref: 'Guardian', required: true },
    relation: { type: String, enum: RELATIONS, required: true },
    // Primary contact: shown in lists, first recipient of alerts and fee reminders.
    isPrimary: { type: Boolean, default: false },
    receivesAlerts: { type: Boolean, default: true },
    canPickup: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
studentGuardianSchema.plugin(tenantPlugin);
studentGuardianSchema.index({ schoolId: 1, studentId: 1, guardianId: 1 }, { unique: true });
studentGuardianSchema.index({ schoolId: 1, guardianId: 1 });
studentGuardianSchema.index({ schoolId: 1, studentId: 1, isPrimary: 1 }, { unique: true, name: 'uniq_primary_guardian', partialFilterExpression: { isPrimary: true } });
export const StudentGuardian = mongoose.model('StudentGuardian', studentGuardianSchema);
