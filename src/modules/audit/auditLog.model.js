import mongoose from 'mongoose';

/**
 * Append-only audit trail. `schoolId` is null for platform-level actions.
 * Not using tenantPlugin because platform events have no school; every tenant-facing
 * read in audit.service.js filters by the caller's schoolId explicitly.
 */
const auditLogSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, maxlength: 100 },
    entityType: { type: String, maxlength: 60 },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 500 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

auditLogSchema.index({ schoolId: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

// Append-only: block updates and deletes through the model.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditLogSchema.pre(op, function blockMutation() {
    throw new Error('Audit logs are append-only');
  });
}

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
