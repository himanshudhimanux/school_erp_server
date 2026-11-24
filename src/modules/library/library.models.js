import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A title in the library with copy counts. `availableCopies` is changed only with atomic,
 * guarded $inc updates so two librarians can never lend the last copy twice.
 */
const bookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    author: { type: String, trim: true, maxlength: 150 },
    isbn: { type: String, trim: true, maxlength: 20 },
    publisher: { type: String, trim: true, maxlength: 120 },
    category: { type: String, trim: true, maxlength: 60 },
    edition: { type: String, trim: true, maxlength: 40 },
    shelf: { type: String, trim: true, maxlength: 40 },
    totalCopies: { type: Number, required: true, min: 0, max: 10000 },
    availableCopies: { type: Number, required: true, min: 0, max: 10000 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
bookSchema.plugin(tenantPlugin);
bookSchema.plugin(softDeletePlugin);
bookSchema.index({ schoolId: 1, title: 1 });
bookSchema.index({ schoolId: 1, isbn: 1 });
bookSchema.index({ schoolId: 1, category: 1 });
export const Book = mongoose.model('Book', bookSchema);

export const ISSUE_STATUSES = ['issued', 'returned', 'lost'];
export const FINE_STATUSES = ['none', 'pending', 'charged', 'waived'];

/** One loan of one copy to a student or a staff member. */
const issueSchema = new mongoose.Schema(
  {
    bookId: { type: ObjectId, ref: 'Book', required: true },
    borrowerType: { type: String, enum: ['student', 'staff'], required: true },
    studentId: { type: ObjectId, ref: 'Student', default: null },
    membershipId: { type: ObjectId, ref: 'Membership', default: null },
    issuedAt: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    returnedAt: { type: Date, default: null },
    status: { type: String, enum: ISSUE_STATUSES, default: 'issued' },
    // Fine in paise (late return or lost book). Charged fines become a fee invoice.
    fine: { type: Number, min: 0, default: 0 },
    fineStatus: { type: String, enum: FINE_STATUSES, default: 'none' },
    fineInvoiceId: { type: ObjectId, ref: 'FeeInvoice', default: null },
    note: { type: String, trim: true, maxlength: 300 },
    issuedBy: { type: ObjectId, ref: 'User' },
    closedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
issueSchema.plugin(tenantPlugin);
issueSchema.index({ schoolId: 1, status: 1, dueDate: 1 });
issueSchema.index({ schoolId: 1, studentId: 1, status: 1 });
issueSchema.index({ schoolId: 1, membershipId: 1, status: 1 });
issueSchema.index({ schoolId: 1, bookId: 1, status: 1 });
export const BookIssue = mongoose.model('BookIssue', issueSchema);
