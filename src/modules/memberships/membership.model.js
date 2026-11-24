import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { SCHOOL_ROLE_VALUES } from '../../constants/roles.js';

export const MEMBERSHIP_STATUSES = ['active', 'invited', 'suspended'];

/**
 * Links a User to a School with roles. A user may belong to many schools
 * (e.g. a parent with children in two institutions, or a teacher at two coaching centres).
 *
 * `campusIds` empty = access to all campuses of the school (campus model arrives in Phase 2).
 */
const membershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    roles: {
      type: [{ type: String, enum: SCHOOL_ROLE_VALUES }],
      default: [],
      validate: { validator: (v) => v.length <= 10, message: 'Too many roles' },
    },
    customRoleIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Role' }],
      default: [],
      validate: { validator: (v) => v.length <= 10, message: 'Too many custom roles' },
    },
    campusIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Campus' }],
      default: [],
      validate: { validator: (v) => v.length <= 50, message: 'Too many campuses' },
    },
    status: { type: String, enum: MEMBERSHIP_STATUSES, default: 'active' },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

membershipSchema.pre('validate', function requireSomeRole() {
  if (!this.roles?.length && !this.customRoleIds?.length) this.invalidate('roles', 'At least one role is required');
});

membershipSchema.plugin(tenantPlugin);
membershipSchema.index({ schoolId: 1, customRoleIds: 1 });
membershipSchema.index({ schoolId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });
membershipSchema.index({ schoolId: 1, roles: 1, status: 1 });

export const Membership = mongoose.model('Membership', membershipSchema);
