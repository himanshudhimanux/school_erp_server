import mongoose from 'mongoose';
import { FeeInvoice, Payment, Refund, LedgerEntry, FeeCategory } from './fee.models.js';
import { staffInvoiceScope, schoolToday, decorateInvoices } from './invoice.service.js';
import { Student, fullName } from '../students/student.model.js';
import { Guardian, StudentGuardian } from '../parents/guardian.model.js';
import { SchoolClass, Section } from '../academics/academics.models.js';
import { Notification } from '../notifications/notification.model.js';
import { nameMap, idStr } from '../academics/academics.common.js';
import { studentAccess, studentFilter } from '../students/access.js';
import { addDays, daysBetween } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const OPEN = ['unpaid', 'partially_paid'];
const DAY = 86400000;

/** Student filter for payments/ledger when the caller is campus-restricted (null = all). */
async function restrictedStudentIds(tenant) {
  const access = await studentAccess(tenant);
  if (!access.restricted) return null;
  return Student.distinct('_id', { schoolId: tenant.schoolId, ...studentFilter(access) });
}

const sum = async (Model, match, field) => (await Model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: `$${field}` }, n: { $sum: 1 } } }]))[0] || { v: 0, n: 0 };

/** Fee dashboard. "Today" and "this month" use the school's timezone; all figures come from stored records. */
export async function dashboard(tenant) {
  const schoolId = oid(tenant.schoolId);
  const today = await schoolToday(tenant);
  const tomorrow = addDays(today, 1);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const scope = { ...(await staffInvoiceScope(tenant)), schoolId };
  const students = await restrictedStudentIds(tenant);
  const pScope = { schoolId, ...(students ? { studentId: { $in: students } } : {}) };

  const [todayIn, monthIn, monthRefunds, bySource, outstanding, overdue, recent, upcoming, reminders] = await Promise.all([
    sum(Payment, { ...pScope, paidAt: { $gte: today, $lt: tomorrow } }, 'amount'),
    sum(Payment, { ...pScope, paidAt: { $gte: monthStart, $lt: tomorrow } }, 'amount'),
    sum(Refund, { ...pScope, refundedAt: { $gte: monthStart, $lt: tomorrow } }, 'amount'),
    Payment.aggregate([{ $match: { ...pScope, paidAt: { $gte: monthStart, $lt: tomorrow } } }, { $group: { _id: '$source', v: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    FeeInvoice.aggregate([{ $match: { ...scope, status: { $in: OPEN } } }, { $group: { _id: null, v: { $sum: { $subtract: ['$total', '$paidAmount'] } }, n: { $sum: 1 } } }]),
    FeeInvoice.aggregate([{ $match: { ...scope, status: { $in: OPEN }, dueDate: { $lt: today } } }, { $group: { _id: null, v: { $sum: { $subtract: ['$total', '$paidAmount'] } }, n: { $sum: 1 }, students: { $addToSet: '$studentId' } } }]),
    Payment.find(pScope).sort({ paidAt: -1, _id: -1 }).limit(10).lean(),
    FeeInvoice.find({ ...scope, status: { $in: OPEN }, dueDate: { $gte: today, $lte: addDays(today, 7) } }).sort({ dueDate: 1 }).limit(10).lean(),
    Notification.aggregate([{ $match: { schoolId, type: 'fees.reminder', createdAt: { $gte: addDays(today, -30) } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const studentsById = await nameMap(Student, schoolId, recent.map((p) => p.studentId), 'firstName lastName admissionNo');
  const src = Object.fromEntries(bySource.map((s) => [s._id, { amount: s.v, count: s.n }]));
  return {
    date: today,
    collection: {
      today: { amount: todayIn.v, count: todayIn.n },
      month: { amount: monthIn.v, count: monthIn.n, refunds: monthRefunds.v, net: monthIn.v - monthRefunds.v },
      online: src.online || { amount: 0, count: 0 },
      offline: src.offline || { amount: 0, count: 0 },
    },
    outstanding: { amount: outstanding[0]?.v || 0, invoices: outstanding[0]?.n || 0 },
    overdue: { amount: overdue[0]?.v || 0, invoices: overdue[0]?.n || 0, students: overdue[0]?.students.length || 0 },
    recentPayments: recent.map((p) => {
      const s = studentsById.get(idStr(p.studentId));
      return { _id: p._id, receiptNo: p.receiptNo, paidAt: p.paidAt, amount: p.amount, method: p.method, source: p.source, status: p.status, student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo } : null };
    }),
    upcomingDue: await decorateInvoices(schoolId, upcoming, today),
    reminders: Object.fromEntries(reminders.map((r) => [r._id, r.n])),
  };
}

/** Students with overdue balances, largest first, with the primary contact to call. */
export async function defaulters(tenant, { sessionId, classId, sectionId, minAmount, page, limit }) {
  const schoolId = oid(tenant.schoolId);
  const today = await schoolToday(tenant);
  const match = { ...(await staffInvoiceScope(tenant)), schoolId, status: { $in: OPEN }, dueDate: { $lt: today } };
  if (sessionId) match.sessionId = oid(sessionId);
  if (classId) match.classId = oid(classId);
  if (sectionId) match.sectionId = oid(sectionId);
  const [res] = await FeeInvoice.aggregate([
    { $match: match },
    { $group: { _id: '$studentId', overdue: { $sum: { $subtract: ['$total', '$paidAmount'] } }, invoices: { $sum: 1 }, oldestDue: { $min: '$dueDate' }, classId: { $last: '$classId' }, sectionId: { $last: '$sectionId' } } },
    { $match: { overdue: { $gte: minAmount || 1 } } },
    { $facet: { items: [{ $sort: { overdue: -1, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }], amount: [{ $group: { _id: null, v: { $sum: '$overdue' } } }] } },
  ]);
  const ids = res.items.map((r) => r._id);
  const [students, classes, sections, links] = await Promise.all([
    nameMap(Student, schoolId, ids, 'firstName lastName admissionNo status'),
    nameMap(SchoolClass, schoolId, res.items.map((r) => r.classId), 'name'),
    nameMap(Section, schoolId, res.items.map((r) => r.sectionId), 'name'),
    StudentGuardian.find({ schoolId, studentId: { $in: ids }, isPrimary: true }).lean(),
  ]);
  const guardians = await nameMap(Guardian, schoolId, links.map((l) => l.guardianId), 'name phone email');
  const gBy = new Map(links.map((l) => [String(l.studentId), guardians.get(idStr(l.guardianId))]));
  const total = res.total[0]?.n ?? 0;
  return {
    items: res.items.map((r) => {
      const s = students.get(idStr(r._id));
      const c = classes.get(idStr(r.classId));
      const sec = sections.get(idStr(r.sectionId));
      const g = gBy.get(String(r._id));
      return {
        studentId: r._id,
        name: s ? fullName(s) : null,
        admissionNo: s?.admissionNo ?? null,
        studentStatus: s?.status ?? null,
        classSection: c ? `${c.name}${sec ? ` - ${sec.name}` : ''}` : null,
        overdueAmount: r.overdue,
        overdueInvoices: r.invoices,
        oldestDueDate: r.oldestDue,
        daysOverdue: daysBetween(r.oldestDue, today),
        primaryGuardian: g ? { name: g.name, phone: g.phone, email: g.email ?? null } : null,
      };
    }),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), totalOverdue: res.amount[0]?.v ?? 0, asOf: today },
  };
}

/**
 * Collections between two dates. groupBy:
 *  day | method   gross receipts (refunds reported separately)
 *  category       net fee income from the ledger (receipts minus refunds), late fee as its own row
 *  class          receipts by the class on the invoice
 */
export async function collections(tenant, { from, to, groupBy }) {
  const schoolId = oid(tenant.schoolId);
  if (daysBetween(from, to) > 400) throw ApiError.validation([{ field: 'query.to', message: 'Range can be at most 400 days' }]);
  const end = new Date(to.getTime() + DAY);
  const students = await restrictedStudentIds(tenant);
  const sFilter = students ? { studentId: { $in: students } } : {};
  const pMatch = { schoolId, paidAt: { $gte: from, $lt: end }, ...sFilter };

  let rows;
  if (groupBy === 'category') {
    const raw = await LedgerEntry.aggregate([
      { $match: { schoolId, account: 'FEE_INCOME', date: { $gte: from, $lt: end }, ...sFilter } },
      { $group: { _id: '$categoryId', received: { $sum: '$credit' }, refunded: { $sum: '$debit' } } },
    ]);
    const cats = await nameMap(FeeCategory, schoolId, raw.map((r) => r._id), 'name code');
    rows = raw.map((r) => ({ key: r._id ? String(r._id) : 'late_fee', label: r._id ? cats.get(idStr(r._id))?.name ?? 'Unknown' : 'Late fee', received: r.received, refunded: r.refunded, net: r.received - r.refunded }));
  } else if (groupBy === 'class') {
    const raw = await Payment.aggregate([
      { $match: pMatch },
      { $unwind: '$allocations' },
      { $lookup: { from: FeeInvoice.collection.name, localField: 'allocations.invoiceId', foreignField: '_id', as: 'inv' } },
      { $group: { _id: { $first: '$inv.classId' }, amount: { $sum: '$allocations.amount' }, payments: { $addToSet: '$_id' } } },
    ]);
    const classes = await nameMap(SchoolClass, schoolId, raw.map((r) => r._id), 'name order');
    rows = raw
      .map((r) => ({ key: r._id ? String(r._id) : 'none', label: classes.get(idStr(r._id))?.name ?? 'No class', order: classes.get(idStr(r._id))?.order ?? 9999, amount: r.amount, count: r.payments.length }))
      .sort((a, b) => a.order - b.order);
  } else {
    const key = groupBy === 'method' ? '$method' : { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } };
    const raw = await Payment.aggregate([{ $match: pMatch }, { $group: { _id: key, amount: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
    rows = raw.map((r) => ({ key: r._id, label: r._id, amount: r.amount, count: r.count }));
  }
  const [gross, refunds] = await Promise.all([sum(Payment, pMatch, 'amount'), sum(Refund, { schoolId, refundedAt: { $gte: from, $lt: end }, ...sFilter }, 'amount')]);
  return { from, to, groupBy, rows, totals: { received: gross.v, payments: gross.n, refunded: refunds.v, net: gross.v - refunds.v } };
}

/** Outstanding balance by class (and overdue part) for a session or all. */
export async function outstandingByClass(tenant, { sessionId }) {
  const schoolId = oid(tenant.schoolId);
  const today = await schoolToday(tenant);
  const match = { ...(await staffInvoiceScope(tenant)), schoolId, status: { $in: OPEN } };
  if (sessionId) match.sessionId = oid(sessionId);
  const raw = await FeeInvoice.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$classId',
        balance: { $sum: { $subtract: ['$total', '$paidAmount'] } },
        overdue: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, { $subtract: ['$total', '$paidAmount'] }, 0] } },
        invoices: { $sum: 1 },
        students: { $addToSet: '$studentId' },
      },
    },
  ]);
  const classes = await nameMap(SchoolClass, schoolId, raw.map((r) => r._id), 'name order');
  const rows = raw
    .map((r) => ({ classId: r._id, name: classes.get(idStr(r._id))?.name ?? 'No class', order: classes.get(idStr(r._id))?.order ?? 9999, balance: r.balance, overdue: r.overdue, invoices: r.invoices, students: r.students.length }))
    .sort((a, b) => a.order - b.order);
  return { asOf: today, rows, totals: { balance: rows.reduce((t, r) => t + r.balance, 0), overdue: rows.reduce((t, r) => t + r.overdue, 0) } };
}

/** Day book: journal entries in a range with debit/credit totals per account. */
export async function ledger(tenant, { from, to, account, page, limit }) {
  const schoolId = oid(tenant.schoolId);
  const students = await restrictedStudentIds(tenant);
  const match = { schoolId, date: { $gte: from, $lt: new Date(to.getTime() + DAY) }, ...(students ? { studentId: { $in: students } } : {}) };
  if (account) match.account = account;
  const [rows, total, byAccount] = await Promise.all([
    LedgerEntry.find(match).sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    LedgerEntry.countDocuments(match),
    LedgerEntry.aggregate([{ $match: match }, { $group: { _id: '$account', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } }, { $sort: { _id: 1 } }]),
  ]);
  const cats = await nameMap(FeeCategory, schoolId, rows.map((r) => r.categoryId), 'name');
  return {
    items: rows.map((r) => ({ ...r, category: r.categoryId ? cats.get(idStr(r.categoryId))?.name ?? null : null })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), byAccount: byAccount.map((a) => ({ account: a._id, debit: a.debit, credit: a.credit })) },
  };
}
