import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { addressSchema, GENDERS } from '../common/person.schema.js';

const { ObjectId } = mongoose.Schema.Types;

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'visiting'];
/** HR status, separate from login access (Membership.status). */
export const EMPLOYMENT_STATUSES = ['active', 'on_leave', 'exited'];

/**
 * Employee record for a staff member. Login, roles and campus access stay on the Membership;
 * this holds HR details (department, designation, joining date...). One profile per membership.
 */
const staffProfileSchema = new mongoose.Schema(
  {
    membershipId: { type: ObjectId, ref: 'Membership', required: true },
    employeeCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    department: { type: String, trim: true, maxlength: 80 },
    designation: { type: String, trim: true, maxlength: 80 },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'full_time' },
    employmentStatus: { type: String, enum: EMPLOYMENT_STATUSES, default: 'active' },
    joiningDate: { type: Date, default: null },
    exitDate: { type: Date, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: [...GENDERS, null], default: null },
    qualification: { type: String, trim: true, maxlength: 200 },
    experienceYears: { type: Number, min: 0, max: 60, default: null },
    address: { type: addressSchema, default: undefined },
    emergencyContact: {
      name: { type: String, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 20 },
      relation: { type: String, trim: true, maxlength: 40 },
    },
    notes: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: ObjectId, ref: 'User' },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
staffProfileSchema.plugin(tenantPlugin);
staffProfileSchema.index({ schoolId: 1, membershipId: 1 }, { unique: true });
staffProfileSchema.index({ schoolId: 1, employeeCode: 1 }, { unique: true });
staffProfileSchema.index({ schoolId: 1, department: 1 });
staffProfileSchema.index({ membershipId: 1 });
export const StaffProfile = mongoose.model('StaffProfile', staffProfileSchema);
