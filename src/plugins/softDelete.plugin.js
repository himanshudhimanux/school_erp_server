import mongoose from 'mongoose';

const READ_OPS = ['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany'];

/**
 * Soft deletion: documents get `isDeleted/deletedAt/deletedBy` and are hidden from reads
 * unless the query opts in with `.setOptions({ withDeleted: true })`.
 */
export function softDeletePlugin(schema) {
  schema.add({
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  });

  schema.pre(READ_OPS, function excludeDeleted() {
    if (this.getOptions().withDeleted) return;
    const filter = this.getFilter();
    if (filter.isDeleted === undefined) this.where({ isDeleted: false });
  });

  schema.methods.softDelete = function softDelete(userId, session) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = userId || null;
    return this.save({ session });
  };
}
