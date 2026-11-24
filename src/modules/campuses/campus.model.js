import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';

const campusSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
      match: [/^[A-Z0-9][A-Z0-9-]*$/, 'Code may contain letters, digits and hyphens'],
    },
    isMain: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20 },
    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      line2: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      postalCode: { type: String, trim: true, maxlength: 20 },
      country: { type: String, trim: true, maxlength: 100 },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

campusSchema.plugin(tenantPlugin);
campusSchema.plugin(softDeletePlugin);
// Codes are unique among live campuses of a school; a deleted campus frees its code.
campusSchema.index({ schoolId: 1, code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
// At most one main campus per school.
campusSchema.index({ schoolId: 1, isMain: 1 }, { unique: true, partialFilterExpression: { isMain: true, isDeleted: false } });
campusSchema.index({ schoolId: 1, status: 1, name: 1 });

export const Campus = mongoose.model('Campus', campusSchema);
