import mongoose from 'mongoose';
import { FeeInvoice, Payment, Refund, LedgerEntry, PaymentOrder } from './fee.models.js';
import { tx, nextNumber, decorateInvoices, schoolToday } from './invoice.service.js';
import { splitProportional, amountInWords } from './money.js';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { School } from '../schools/school.model.js';
import { User } from '../users/user.model.js';
import { Section, SchoolClass } from '../academics/academics.models.js';
import { studentAccess, studentFilter, getStudentDoc } from '../students/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';
import { logger } from '../../utils/logger.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const OPEN = ['unpaid', 'partially_paid'];
const METHOD_ACCOUNT = { cash: 'CASH', online: 'GATEWAY' };
export const accountFor = (method) => METHOD_ACCOUNT[method] || 'BANK';
const REFERENCE_REQUIRED = ['cheque', 'bank_transfer', 'upi', 'card'];

/* ------------------------------ ledger ------------------------------ */

/**
 * Splits money applied to an invoice into fee-income parts by category, in proportion to what
 * each line contributes (net of discount), with the late fee as its own part (categoryId null).
 */
function incomeParts(inv, amount) {
  const weights = inv.lines.map((l) => Math.max(0, l.amount - (l.discount || 0)));
  const late = inv.lateFeeWaived ? 0 : inv.lateFee || 0;
  const keys = inv.lines.map((l) => String(l.categoryId));
  if (late) {
    weights.push(late);
    keys.push(null);
  }
  const parts = splitProportional(amount, weights);
  const out = new Map();
  parts.forEach((p, i) => p && out.set(keys[i], (out.get(keys[i]) || 0) + p));
  return out;
}

/** Posts balanced journal entries for a payment (money in) or refund (money out). */
async function postLedger({ schoolId, session, type, voucher, method, invoicesById, allocations, unallocated = 0, studentId, actorId, date }) {
  const income = new Map();
  for (const a of allocations) {
    for (const [cat, amt] of incomeParts(invoicesById.get(String(a.invoiceId)), a.amount)) income.set(cat, (income.get(cat) || 0) + amt);
  }
  const total = allocations.reduce((t, a) => t + a.amount, 0) + unallocated;
  const isIn = type === 'payment';
  const base = { schoolId, date, voucherType: type, voucherId: voucher._id, voucherNo: voucher.receiptNo || voucher.refundNo, studentId, createdBy: actorId };
  const entries = [{ ...base, account: accountFor(method), debit: isIn ? total : 0, credit: isIn ? 0 : total, narration: isIn ? `Fee received (${method})` : `Fee refunded (${method})` }];
  for (const [cat, amt] of income) entries.push({ ...base, account: 'FEE_INCOME', categoryId: cat ? oid(cat) : null, debit: isIn ? 0 : amt, credit: isIn ? amt : 0, narration: cat ? 'Fee income' : 'Late fee income' });
  if (unallocated) entries.push({ ...base, account: 'ADVANCE', debit: isIn ? 0 : unallocated, credit: isIn ? unallocated : 0, narration: 'Received in advance' });
  const dr = entries.reduce((t, e) => t + e.debit, 0);
  const cr = entries.reduce((t, e) => t + e.credit, 0);
  if (dr !== cr) throw new Error(`Unbalanced ledger voucher ${base.voucherNo}: ${dr} != ${cr}`);
  await LedgerEntry.insertMany(entries, { session });
}

/* ------------------------------ applying money ------------------------------ */

/** Adds `amount` to an invoice's paid amount only if the balance still allows it (concurrency-safe). */
async function applyToInvoice(schoolId, invoiceId, amount, session) {
  const res = await FeeInvoice.updateOne(
    { _id: invoiceId, schoolId, status: { $in: OPEN }, $expr: { $gte: [{ $subtract: ['$total', '$paidAmount'] }, amount] } },
    [
      { $set: { paidAmount: { $add: ['$paidAmount', amount] } } },
      { $set: { status: { $cond: [{ $gte: ['$paidAmount', '$total'] }, 'paid', 'partially_paid'] } } },
    ],
    { session, updatePipeline: true },
  );
  if (!res.modifiedCount) throw ApiError.conflict('The invoice balance changed. Reload and try again.', { code: 'BALANCE_CHANGED' });
}

async function removeFromInvoice(schoolId, invoiceId, amount, session) {
  const res = await FeeInvoice.updateOne(
    { _id: invoiceId, schoolId, paidAmount: { $gte: amount } },
    [
      { $set: { paidAmount: { $subtract: ['$paidAmount', amount] } } },
      { $set: { status: { $cond: [{ $eq: ['$status', 'cancelled'] }, 'cancelled', { $cond: [{ $gte: ['$paidAmount', '$total'] }, 'paid', { $cond: [{ $gt: ['$paidAmount', 0] }, 'partially_paid', 'unpaid'] }] }] } } },
    ],
    { session, updatePipeline: true },
  );
  if (!res.modifiedCount) throw new Error(`Refund could not be applied to invoice ${invoiceId}`);
}

/**
 * Works out how a payment is spread over a student's open invoices: explicit allocations are
 * checked against each balance; a plain amount pays the oldest due invoices first.
 */
function planAllocations(openInvoices, { allocations, amount }) {
  const byId = new Map(openInvoices.map((i) => [String(i._id), i]));
  if (allocations?.length) {
    const seen = new Set();
    return allocations.map((a) => {
      const inv = byId.get(String(a.invoiceId));
      if (!inv) throw ApiError.badRequest('An invoice is not an open invoice of this student', { code: 'INVALID_INVOICE', details: { invoiceId: a.invoiceId } });
      if (seen.has(String(a.invoiceId))) throw ApiError.validation([{ field: 'body.allocations', message: 'Each invoice may appear only once' }]);
      seen.add(String(a.invoiceId));
      const balance = inv.total - inv.paidAmount;
      if (a.amount > balance) throw ApiError.badRequest(`Amount for ${inv.invoiceNo} exceeds its balance (${balance})`, { code: 'AMOUNT_EXCEEDS_BALANCE', details: { invoiceNo: inv.invoiceNo, balance } });
      return { invoiceId: inv._id, invoiceNo: inv.invoiceNo, amount: a.amount };
    });
  }
  const outstanding = openInvoices.reduce((t, i) => t + (i.total - i.paidAmount), 0);
  if (amount > outstanding) throw ApiError.badRequest(`Amount exceeds the total outstanding (${outstanding})`, { code: 'AMOUNT_EXCEEDS_BALANCE', details: { outstanding } });
  let left = amount;
  const out = [];
  for (const inv of [...openInvoices].sort((a, b) => a.dueDate - b.dueDate || a.invoiceNo.localeCompare(b.invoiceNo))) {
    if (!left) break;
    const take = Math.min(left, inv.total - inv.paidAmount);
    if (take > 0) out.push({ invoiceId: inv._id, invoiceNo: inv.invoiceNo, amount: take });
    left -= take;
  }
  return out;
}

/**
 * Core of every payment (counter or online). Runs inside the caller's transaction:
 * applies allocations, creates the receipt, posts the ledger and the audit entry.
 */
async function postPayment(s, { schoolId, studentId, allocations, unallocated = 0, method, source, reference, notes, paidAt, actorId, gateway, idempotencyKey, ctx }) {
  const invoices = await FeeInvoice.find({ schoolId, _id: { $in: allocations.map((a) => a.invoiceId) } }).session(s).lean();
  const invoicesById = new Map(invoices.map((i) => [String(i._id), i]));
  for (const a of allocations) await applyToInvoice(schoolId, a.invoiceId, a.amount, s);
  const amount = allocations.reduce((t, a) => t + a.amount, 0) + unallocated;
  const [payment] = await Payment.create(
    [{ schoolId, receiptNo: await nextNumber(schoolId, 'receipt_no', 'RCT', s), studentId, amount, allocations, unallocatedAmount: unallocated, method, source, reference, notes, paidAt, collectedBy: actorId, gateway, idempotencyKey }],
    { session: s },
  );
  await postLedger({ schoolId, session: s, type: 'payment', voucher: payment, method, invoicesById, allocations, unallocated, studentId, actorId, date: paidAt });
  await recordAudit({ ...ctx, action: 'payment.received', entityType: 'Payment', entityId: payment._id, metadata: { receiptNo: payment.receiptNo, amount, method, source, invoices: allocations.map((a) => a.invoiceNo) } }, { session: s });
  return payment;
}

/** Records a payment taken at the school (cash, cheque, transfer, UPI, card). */
export async function collectPayment(tenant, data, ctx) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, data.studentId);
  if (REFERENCE_REQUIRED.includes(data.method) && !data.reference) {
    throw ApiError.validation([{ field: 'body.reference', message: 'Enter the transaction or cheque reference for this payment method' }]);
  }
  if (data.paidAt && data.paidAt > new Date()) throw ApiError.validation([{ field: 'body.paidAt', message: 'Payment date cannot be in the future' }]);

  if (data.idempotencyKey) {
    const existing = await Payment.findOne({ schoolId, idempotencyKey: data.idempotencyKey }).lean();
    if (existing) {
      if (String(existing.studentId) !== String(student._id)) throw ApiError.conflict('This idempotency key was used for a different payment', { code: 'IDEMPOTENCY_CONFLICT' });
      return { ...(await getReceipt(tenant, existing._id)), replayed: true };
    }
  }

  let payment;
  try {
    payment = await tx(async (s) => {
      const open = await FeeInvoice.find({ schoolId, studentId: student._id, status: { $in: OPEN } }).session(s).lean();
      const allocations = planAllocations(open, data);
      return postPayment(s, {
        schoolId,
        studentId: student._id,
        allocations,
        method: data.method,
        source: 'offline',
        reference: data.reference,
        notes: data.notes,
        paidAt: data.paidAt || new Date(),
        actorId: ctx.actorId,
        idempotencyKey: data.idempotencyKey,
        ctx,
      });
    });
  } catch (err) {
    // A concurrent retry with the same key won the race: return its receipt.
    if (err?.code === 11000 && data.idempotencyKey && /idempotencyKey/.test(err.message)) {
      const existing = await Payment.findOne({ schoolId, idempotencyKey: data.idempotencyKey }).lean();
      return { ...(await getReceipt(tenant, existing._id)), replayed: true };
    }
    throw err;
  }
  return { ...(await getReceipt(tenant, payment._id)), replayed: false };
}

/**
 * Records a captured online payment against an order (idempotent on the gateway payment id).
 * If an invoice was meanwhile paid at the counter, the excess is kept as ADVANCE.
 */
export async function recordOnlinePayment(schoolId, order, gatewayPaymentId, ctx) {
  const existing = await Payment.findOne({ schoolId, 'gateway.paymentId': gatewayPaymentId }).lean();
  if (existing) return { payment: existing, created: false };
  try {
    const payment = await tx(async (s) => {
      const invoices = await FeeInvoice.find({ schoolId, _id: { $in: order.allocations.map((a) => a.invoiceId) } }).session(s).lean();
      const byId = new Map(invoices.map((i) => [String(i._id), i]));
      const allocations = [];
      for (const a of order.allocations) {
        const inv = byId.get(String(a.invoiceId));
        const open = inv && OPEN.includes(inv.status) ? inv.total - inv.paidAmount : 0;
        const take = Math.min(open, a.amount);
        if (take > 0) allocations.push({ invoiceId: inv._id, invoiceNo: inv.invoiceNo, amount: take });
      }
      const unallocated = order.amount - allocations.reduce((t, a) => t + a.amount, 0);
      const p = await postPayment(s, {
        schoolId,
        studentId: order.studentId,
        allocations,
        unallocated,
        method: 'online',
        source: 'online',
        reference: gatewayPaymentId,
        paidAt: new Date(),
        actorId: null,
        gateway: { provider: order.provider, orderId: order.orderId, paymentId: gatewayPaymentId },
        ctx: { ...ctx, schoolId },
      });
      await PaymentOrder.updateOne({ _id: order._id, schoolId }, { status: 'paid', paymentId: p._id, gatewayPaymentId }, { session: s });
      return p;
    });
    return { payment, created: true };
  } catch (err) {
    if (err?.code === 11000 && /gateway\.paymentId/.test(err.message)) {
      return { payment: await Payment.findOne({ schoolId, 'gateway.paymentId': gatewayPaymentId }).lean(), created: false };
    }
    throw err;
  }
}

/* ------------------------------ refunds ------------------------------ */

/** Payment in the caller's scope (campus-restricted staff only see their students' payments). */
async function getPaymentDoc(tenant, id, session) {
  const access = await studentAccess(tenant);
  const payment = await Payment.findOne({ _id: id, schoolId: tenant.schoolId }).session(session || null);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (access.restricted) {
    const ok = await Student.exists({ schoolId: tenant.schoolId, _id: payment.studentId, ...studentFilter(access) });
    if (!ok) throw ApiError.notFound('Payment not found');
  }
  return payment;
}

/**
 * Refunds part or all of a payment. Unallocated (advance) money is returned first, then invoice
 * allocations from the last one backwards; those invoices become payable again.
 * `gatewayRefund` performs the refund at the payment gateway for online payments.
 */
export async function refundPayment(tenant, paymentId, { amount, reason, method, reference }, ctx, { gatewayRefund } = {}) {
  const schoolId = tenant.schoolId;
  const payment = await getPaymentDoc(tenant, paymentId);
  const refundable = payment.amount - payment.refundedAmount;
  if (amount > refundable) throw ApiError.badRequest(`At most ${refundable} can be refunded on this payment`, { code: 'REFUND_EXCEEDS_PAYMENT', details: { refundable } });

  let refundMethod = method;
  let gatewayRefundId = null;
  if (payment.source === 'online') {
    if (!gatewayRefund) throw ApiError.badRequest('Online payments are refunded through the payment gateway', { code: 'GATEWAY_REFUND_REQUIRED' });
    gatewayRefundId = await gatewayRefund(payment, amount);
    refundMethod = 'online';
  } else if (!refundMethod || refundMethod === 'online') {
    throw ApiError.validation([{ field: 'body.method', message: 'Choose how the money was returned' }]);
  }

  const refund = await tx(async (s) => {
    const fresh = await Payment.findOne({ _id: payment._id, schoolId }).session(s);
    if (amount > fresh.amount - fresh.refundedAmount) throw ApiError.conflict('This payment was refunded meanwhile. Reload and try again.', { code: 'REFUND_EXCEEDS_PAYMENT' });
    const previous = await Refund.find({ schoolId, paymentId: fresh._id }).session(s).lean();
    const refundedPer = new Map();
    let advanceRefunded = 0;
    for (const r of previous) {
      advanceRefunded += r.amount - r.allocations.reduce((t, a) => t + a.amount, 0);
      for (const a of r.allocations) refundedPer.set(String(a.invoiceId), (refundedPer.get(String(a.invoiceId)) || 0) + a.amount);
    }
    let left = amount;
    const fromAdvance = Math.min(left, fresh.unallocatedAmount - advanceRefunded);
    left -= fromAdvance;
    const allocations = [];
    for (const a of [...fresh.allocations].reverse()) {
      if (!left) break;
      const take = Math.min(left, a.amount - (refundedPer.get(String(a.invoiceId)) || 0));
      if (take > 0) allocations.push({ invoiceId: a.invoiceId, invoiceNo: a.invoiceNo, amount: take });
      left -= take;
    }
    if (left) throw new Error('Refund allocation mismatch');

    const invoices = await FeeInvoice.find({ schoolId, _id: { $in: allocations.map((a) => a.invoiceId) } }).session(s).lean();
    for (const a of allocations) await removeFromInvoice(schoolId, a.invoiceId, a.amount, s);
    fresh.refundedAmount += amount;
    fresh.status = fresh.refundedAmount >= fresh.amount ? 'refunded' : 'partially_refunded';
    await fresh.save({ session: s });
    const now = new Date();
    const [doc] = await Refund.create(
      [{ schoolId, refundNo: await nextNumber(schoolId, 'refund_no', 'RFD', s), paymentId: fresh._id, studentId: fresh.studentId, amount, allocations, reason, method: refundMethod, reference, gatewayRefundId, refundedBy: ctx.actorId, refundedAt: now }],
      { session: s },
    );
    await postLedger({ schoolId, session: s, type: 'refund', voucher: doc, method: refundMethod, invoicesById: new Map(invoices.map((i) => [String(i._id), i])), allocations, unallocated: fromAdvance, studentId: fresh.studentId, actorId: ctx.actorId, date: now });
    await recordAudit({ ...ctx, action: 'payment.refunded', entityType: 'Payment', entityId: fresh._id, metadata: { refundNo: doc.refundNo, amount, reason, method: refundMethod } }, { session: s });
    return doc;
  }).catch((err) => {
    // The gateway already returned the money: this must be reconciled by hand.
    if (gatewayRefundId) logger.error({ err, paymentId: payment._id, gatewayRefundId, amount }, 'Gateway refund succeeded but recording it failed');
    throw err;
  });
  return { refund: refund.toObject(), receipt: await getReceipt(tenant, payment._id) };
}

/* ------------------------------ receipts & lists ------------------------------ */

export async function receiptFor(schoolId, payment) {
  const [school, student, invoices, collector, refunds] = await Promise.all([
    School.findById(schoolId).select('name address phone email currency settings.branding').lean(),
    Student.findOne({ schoolId, _id: payment.studentId }).setOptions({ withDeleted: true }).select('firstName lastName admissionNo').lean(),
    FeeInvoice.find({ schoolId, _id: { $in: payment.allocations.map((a) => a.invoiceId) } }).select('invoiceNo title classId sectionId total paidAmount').lean(),
    payment.collectedBy ? User.findById(payment.collectedBy).select('name').lean() : null,
    Refund.find({ schoolId, paymentId: payment._id }).select('refundNo amount refundedAt reason method').sort({ refundedAt: 1 }).lean(),
  ]);
  const invBy = new Map(invoices.map((i) => [String(i._id), i]));
  const first = invoices[0];
  const [cls, sec] = await Promise.all([
    first?.classId ? SchoolClass.findOne({ _id: first.classId, schoolId }).setOptions({ withDeleted: true }).select('name').lean() : null,
    first?.sectionId ? Section.findOne({ _id: first.sectionId, schoolId }).select('name').lean() : null,
  ]);
  return {
    id: payment._id,
    receiptNo: payment.receiptNo,
    paidAt: payment.paidAt,
    status: payment.status,
    school: school ? { name: school.name, address: school.address ?? null, phone: school.phone ?? null, email: school.email ?? null, logoUrl: school.settings?.branding?.logoUrl ?? null } : null,
    currency: school?.currency || 'INR',
    student: student ? { id: student._id, name: fullName(student), admissionNo: student.admissionNo, classSection: cls ? `${cls.name}${sec ? ` - ${sec.name}` : ''}` : null } : null,
    method: payment.method,
    source: payment.source,
    reference: payment.reference ?? null,
    notes: payment.notes ?? null,
    items: payment.allocations.map((a) => {
      const inv = invBy.get(String(a.invoiceId));
      return { invoiceId: a.invoiceId, invoiceNo: a.invoiceNo, title: inv?.title ?? null, amount: a.amount, balanceAfter: inv ? Math.max(0, inv.total - inv.paidAmount) : null };
    }),
    unallocatedAmount: payment.unallocatedAmount || 0,
    amount: payment.amount,
    amountInWords: amountInWords(payment.amount),
    refundedAmount: payment.refundedAmount,
    refunds,
    collectedBy: collector?.name ?? (payment.source === 'online' ? 'Online payment' : null),
  };
}

export async function getReceipt(tenant, paymentId) {
  const payment = await getPaymentDoc(tenant, paymentId);
  return receiptFor(tenant.schoolId, payment.toObject());
}

export async function listPayments(tenant, { page, limit, from, to, method, source, studentId, status, search }) {
  const schoolId = tenant.schoolId;
  const filter = { schoolId };
  const access = await studentAccess(tenant);
  if (access.restricted) filter.studentId = { $in: await Student.distinct('_id', { schoolId, ...studentFilter(access) }) };
  if (studentId) {
    await getStudentDoc(tenant, studentId);
    filter.studentId = studentId;
  }
  if (from || to) filter.paidAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: new Date(to.getTime() + 86400000) } : {}) };
  if (method) filter.method = method;
  if (source) filter.source = source;
  if (status) filter.status = status;
  if (search) filter.receiptNo = new RegExp(`^${search.replace(/[^A-Za-z0-9]/g, '')}`, 'i');
  const [rows, total] = await Promise.all([
    Payment.find(filter).sort({ paidAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Payment.countDocuments(filter),
  ]);
  const students = await Student.find({ schoolId, _id: { $in: rows.map((r) => r.studentId) } }).setOptions({ withDeleted: true }).select('firstName lastName admissionNo').lean();
  const sBy = new Map(students.map((s) => [String(s._id), s]));
  return {
    items: rows.map((r) => {
      const s = sBy.get(String(r.studentId));
      return {
        _id: r._id,
        receiptNo: r.receiptNo,
        paidAt: r.paidAt,
        student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo } : null,
        amount: r.amount,
        refundedAmount: r.refundedAmount,
        method: r.method,
        source: r.source,
        status: r.status,
        reference: r.reference ?? null,
        invoices: r.allocations.map((a) => a.invoiceNo),
      };
    }),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** Everything about a student's fees: invoices, totals and payments (staff and family views). */
export async function studentFeeAccount(tenant, studentId) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  const today = await schoolToday(tenant);
  const [invoices, payments] = await Promise.all([
    FeeInvoice.find({ schoolId, studentId: student._id }).sort({ dueDate: 1 }).lean(),
    Payment.find({ schoolId, studentId: student._id }).sort({ paidAt: -1 }).limit(50).lean(),
  ]);
  const live = invoices.filter((i) => i.status !== 'cancelled');
  const summary = {
    total: live.reduce((t, i) => t + i.total, 0),
    paid: live.reduce((t, i) => t + i.paidAmount, 0),
    overdue: live.filter((i) => i.dueDate < today).reduce((t, i) => t + (i.total - i.paidAmount), 0),
    nextDue: live.find((i) => i.status !== 'paid' && i.dueDate >= today) ?? null,
  };
  summary.balance = summary.total - summary.paid;
  const enrollment = await Enrollment.findOne({ schoolId, studentId: student._id, status: 'active' }).sort({ enrolledOn: -1 }).lean();
  return {
    student: { id: student._id, name: fullName(student), admissionNo: student.admissionNo, sectionId: enrollment?.sectionId ?? null },
    summary: { ...summary, nextDue: summary.nextDue ? { invoiceId: summary.nextDue._id, invoiceNo: summary.nextDue.invoiceNo, dueDate: summary.nextDue.dueDate, balance: summary.nextDue.total - summary.nextDue.paidAmount } : null },
    invoices: await decorateInvoices(schoolId, invoices, today),
    payments: payments.map((p) => ({ _id: p._id, receiptNo: p.receiptNo, paidAt: p.paidAt, amount: p.amount, refundedAmount: p.refundedAmount, method: p.method, source: p.source, status: p.status })),
  };
}
