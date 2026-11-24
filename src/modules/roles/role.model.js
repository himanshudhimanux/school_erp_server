import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { PERMISSIONS, isValidPermission } from '../../constants/permissions.js';

/** School-defined custom role. Built-in roles live in constants/roles.js and are not stored. */
const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 50, match: /^[a-z][a-z0-9_]*$/ },
    description: { type: String, trim: true, maxlength: 300 },
    permissions: {
      type: [String],
      validate: [
        { validator: (v) => v.every(isValidPermission), message: 'Unknown permission' },
        { validator: (v) => v.length <= PERMISSIONS.length, message: 'Too many permissions' },
      ],
      default: [],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

roleSchema.plugin(tenantPlugin);
roleSchema.index({ schoolId: 1, key: 1 }, { unique: true });

export const Role = mongoose.model('Role', roleSchema);
