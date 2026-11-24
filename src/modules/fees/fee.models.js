import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { softDeletePlugin } from '../../plugins/softDelete.plugin.js';

/**
 * Fee and payment models. Every amount is an integer in the smallest currency unit (paise).
 * Invoices snapshot the student's class/section and the fee lines at generation time, so later
 * edits to structures never change issued invoices.
 */
const { ObjectId } = mongoose.Schema.Types;
const money = (extra = {}) => ({ type: Number, min: 0, validate: { validator: Number.isInteger, message: 'Amounts must be whole numbers (paise)' }, ...extra });
const actor = { createdBy: { type: ObjectId, ref: 'User' }, updatedBy: { type: ObjectId, ref: 'User' } };

/* ------------------------------ setup ------------------------------ */

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    description: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    ...actor,
  },
  { timestamps: true },
);
categorySchema.plugin(tenantPlugin);
categorySchema.plugin(softDeletePlugin);
categorySchema.index({ schoolId: 1, code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
export const FeeCategory = mongoose.model('FeeCategory', categorySchema);

export const LATE_FEE_TYPES = ['none', 'fixed', 'per_day'];

const structureSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    classIds: { type: [{ type: ObjectId, ref: 'SchoolClass' }], validate: { validator: (v) => v.length >= 1 && v.length <= 50, message: 'Choose 1–50 classes' } },
    // null = all campuses
    campusId: { type: ObjectId, ref: 'Campus', default: null },
    installments: {
      type: [
        {
          name: { type: String, required: true, trim: true, maxlength: 60 },
          dueDate: { type: Date, required: true },
          items: {
            type: [{ _id: false, categoryId: { type: ObjectId, ref: 'FeeCategory', required: true }, amount: money({ required: true }) }],
            validate: { validator: (v) => v.length >= 1 && v.length <= 20, message: 'Each installment needs 1–20 items' },
          },
        },
      ],
      validate: { validator: (v) => v.length >= 1 && v.length <= 24, message: 'A structure needs 1–24 installments' },
    },
    lateFee: {
      type: { type: String, enum: LATE_FEE_TYPES, default: 'none' },
      amount: money({ default: 0 }),
      graceDays: { type: Number, min: 0, max: 90, default: 0 },
      // Cap for per-day fines (0 = no cap).
      maxAmount: money({ default: 0 }),
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    ...actor,
  },
  { timestamps: true },
);
structureSchema.plugin(tenantPlugin);
structureSchema.index({ schoolId: 1, sessionId: 1, name: 1 }, { unique: true });
structureSchema.index({ schoolId: 1, classIds: 1 });
export const FeeStructure = mongoose.model('FeeStructure', structureSchema);

/**
 * Discount / scholarship template. `percent` takes value% off each matching line; `fixed` takes
 * `value` paise off each matching line of every installment (never below zero).
 * Empty categoryIds = applies to every category.
 */
const discountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: ['percent', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    categoryIds: { type: [{ type: ObjectId, ref: 'FeeCategory' }], default: [] },
    description: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    ...actor,
  },
  { timestamps: true },
);
discountSchema.plugin(tenantPlugin);
discountSchema.index({ schoolId: 1, name: 1 }, { unique: true });
export const FeeDiscount = mongoose.model('FeeDiscount', discountSchema);

/** A structure applied to a student; it generated one invoice per installment. */
const assignmentSchema = new mongoose.Schema(
  {
    studentId: { type: ObjectId, ref: 'Student', required: true },
    structureId: { type: ObjectId, ref: 'FeeStructure', required: true },
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    discountIds: { type: [{ type: ObjectId, ref: 'FeeDiscount' }], default: [] },
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    cancelledAt: { type: Date, default: null },
    ...actor,
  },
  { timestamps: true },
);
assignmentSchema.plugin(tenantPlugin);
assignmentSchema.index({ schoolId: 1, studentId: 1, structureId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
assignmentSchema.index({ schoolId: 1, structureId: 1, status: 1 });
export const FeeAssignment = mongoose.model('FeeAssignment', assignmentSchema);

/* ------------------------------ invoices ------------------------------ */

export const INVOICE_STATUSES = ['unpaid', 'partially_paid', 'paid', 'cancelled'];

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNo: { type: String, required: true, maxlength: 30 },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
    classId: { type: ObjectId, ref: 'SchoolClass', default: null },
    sectionId: { type: ObjectId, ref: 'Section', default: null },
    campusId: { type: ObjectId, ref: 'Campus', required: true },
    assignmentId: { type: ObjectId, ref: 'FeeAssignment', default: null },
    structureId: { type: ObjectId, ref: 'FeeStructure', default: null },
    installmentId: { type: ObjectId, default: null },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    dueDate: { type: Date, required: true },
    lines: {
      type: [
        {
          _id: false,
          categoryId: { type: ObjectId, ref: 'FeeCategory', required: true },
          name: { type: String, required: true, maxlength: 120 },
          amount: money({ required: true }),
          discount: money({ default: 0 }),
        },
      ],
      validate: { validator: (v) => v.length >= 1 && v.length <= 30, message: 'An invoice needs 1–30 lines' },
    },
    subtotal: money({ required: true }),
    discountTotal: money({ default: 0 }),
    // Later waivers granted on this invoice (scholarship top-ups, hardship waivers).
    concession: money({ default: 0 }),
    lateFee: money({ default: 0 }),
    lateFeeWaived: { type: Boolean, default: false },
    // Late-fee rule snapshot from the structure (ad-hoc invoices have none).
    lateFeeRule: {
      type: { type: String, enum: ['none', 'fixed', 'per_day'], default: 'none' },
      amount: money({ default: 0 }),
      graceDays: { type: Number, default: 0 },
      maxAmount: money({ default: 0 }),
    },
    total: money({ required: true }),
    paidAmount: money({ default: 0 }),
    status: { type: String, enum: INVOICE_STATUSES, default: 'unpaid' },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, maxlength: 300 },
    ...actor,
  },
  { timestamps: true },
);
invoiceSchema.plugin(tenantPlugin);
invoiceSchema.index({ schoolId: 1, invoiceNo: 1 }, { unique: true });
invoiceSchema.index({ schoolId: 1, studentId: 1, dueDate: 1 });
invoiceSchema.index({ schoolId: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ schoolId: 1, sessionId: 1, classId: 1, sectionId: 1 });
invoiceSchema.index({ schoolId: 1, assignmentId: 1 });
export const FeeInvoice = mongoose.model('FeeInvoice', invoiceSchema);

/* ------------------------------ money movement ------------------------------ */

export const PAYMENT_METHODS = ['cash', 'cheque', 'bank_transfer', 'upi', 'card', 'online', 'other'];
export const OFFLINE_METHODS = PAYMENT_METHODS.filter((m) => m !== 'online');

const allocation = { _id: false, invoiceId: { type: ObjectId, ref: 'FeeInvoice', required: true }, invoiceNo: String, amount: money({ required: true }) };

const paymentSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, maxlength: 30 },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    amount: money({ required: true }),
    allocations: { type: [allocation], validate: { validator: (v) => v.length <= 50, message: 'At most 50 invoices per payment' } },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    reference: { type: String, trim: true, maxlength: 100 },
    notes: { type: String, trim: true, maxlength: 500 },
    paidAt: { type: Date, required: true },
    source: { type: String, enum: ['offline', 'online'], required: true },
    collectedBy: { type: ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['completed', 'partially_refunded', 'refunded'], default: 'completed' },
    refundedAmount: money({ default: 0 }),
    // Part of `amount` not applied to any invoice (held as ADVANCE).
    unallocatedAmount: money({ default: 0 }),
    gateway: {
      provider: { type: String },
      orderId: { type: String },
      paymentId: { type: String },
    },
    // Client-supplied key that makes "collect payment" safe to retry (double clicks, timeouts).
    idempotencyKey: { type: String, maxlength: 100 },
  },
  { timestamps: true },
);
paymentSchema.plugin(tenantPlugin);
paymentSchema.index({ schoolId: 1, receiptNo: 1 }, { unique: true });
// Matches the list/dashboard sort (newest first, _id as tie-breaker) so "latest N" reads only N entries.
paymentSchema.index({ schoolId: 1, paidAt: -1, _id: -1 });
paymentSchema.index({ schoolId: 1, studentId: 1, paidAt: -1 });
paymentSchema.index({ schoolId: 1, 'allocations.invoiceId': 1 });
paymentSchema.index({ schoolId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
paymentSchema.index({ schoolId: 1, 'gateway.paymentId': 1 }, { unique: true, partialFilterExpression: { 'gateway.paymentId': { $type: 'string' } } });
export const Payment = mongoose.model('Payment', paymentSchema);

const refundSchema = new mongoose.Schema(
  {
    refundNo: { type: String, required: true, maxlength: 30 },
    paymentId: { type: ObjectId, ref: 'Payment', required: true },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    amount: money({ required: true }),
    allocations: { type: [allocation], default: [] },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    reference: { type: String, trim: true, maxlength: 100 },
    gatewayRefundId: { type: String, default: null },
    refundedBy: { type: ObjectId, ref: 'User', required: true },
    refundedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
refundSchema.plugin(tenantPlugin);
refundSchema.index({ schoolId: 1, refundNo: 1 }, { unique: true });
refundSchema.index({ schoolId: 1, paymentId: 1 });
refundSchema.index({ schoolId: 1, refundedAt: -1 });
export const Refund = mongoose.model('Refund', refundSchema);

/**
 * Accounting foundation: an append-only double-entry journal. Every payment and refund posts
 * balanced entries (total debit = total credit per voucher) in the same database transaction.
 *  CASH / BANK / GATEWAY  where the money is
 *  FEE_INCOME             fee revenue, split by fee category (categoryId null = late fee)
 *  ADVANCE                money received but not owed on any invoice (e.g. an online payment
 *                         completing after the invoice was paid at the counter); refundable
 *  SALARY_EXPENSE         staff salaries paid through payroll (Phase 10)
 */
export const ACCOUNTS = ['CASH', 'BANK', 'GATEWAY', 'FEE_INCOME', 'ADVANCE', 'SALARY_EXPENSE'];

const ledgerSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    voucherType: { type: String, enum: ['payment', 'refund', 'payroll'], required: true },
    voucherId: { type: ObjectId, required: true },
    voucherNo: { type: String, required: true },
    account: { type: String, enum: ACCOUNTS, required: true },
    categoryId: { type: ObjectId, ref: 'FeeCategory', default: null },
    debit: money({ default: 0 }),
    credit: money({ default: 0 }),
    studentId: { type: ObjectId, ref: 'Student' },
    narration: { type: String, maxlength: 300 },
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ledgerSchema.plugin(tenantPlugin);
ledgerSchema.index({ schoolId: 1, date: 1, _id: 1 });
ledgerSchema.index({ schoolId: 1, voucherId: 1 });
ledgerSchema.index({ schoolId: 1, account: 1, date: 1 });
ledgerSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany'], function appendOnly() {
  throw new Error('Ledger entries are append-only');
});
export const LedgerEntry = mongoose.model('LedgerEntry', ledgerSchema);

/* ------------------------------ online payments ------------------------------ */

/** A school's own Razorpay account. Secrets are stored encrypted and never returned. */
const gatewaySchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['razorpay'], default: 'razorpay' },
    keyId: { type: String, required: true, maxlength: 100 },
    keySecretEnc: { type: String, required: true },
    webhookSecretEnc: { type: String, default: null },
    enabled: { type: Boolean, default: true },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
gatewaySchema.plugin(tenantPlugin, { index: false });
gatewaySchema.index({ schoolId: 1 }, { unique: true });
export const PaymentGateway = mongoose.model('PaymentGateway', gatewaySchema);

const orderSchema = new mongoose.Schema(
  {
    provider: { type: String, default: 'razorpay' },
    orderId: { type: String, required: true },
    studentId: { type: ObjectId, ref: 'Student', required: true },
    allocations: { type: [allocation], default: [] },
    amount: money({ required: true }),
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' },
    paymentId: { type: ObjectId, ref: 'Payment', default: null },
    gatewayPaymentId: { type: String, default: null },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
orderSchema.plugin(tenantPlugin);
orderSchema.index({ schoolId: 1, orderId: 1 }, { unique: true });
orderSchema.index({ schoolId: 1, studentId: 1, createdAt: -1 });
export const PaymentOrder = mongoose.model('PaymentOrder', orderSchema);
