import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { Membership } from '../memberships/membership.model.js';
import { StaffProfile } from '../staff/staffProfile.model.js';
import { School } from '../schools/school.model.js';
import { AcademicSession } from '../academics/academics.models.js';
import { LedgerEntry } from '../fees/fee.models.js';
import { nextNumber } from '../fees/invoice.service.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { withTransaction } from '../../utils/transaction.js';
import { todayIn, addDays, weekday, parseDateOnly } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const { ObjectId } = mongoose.Schema.Types;
const money = { type: Number, min: 0, validate: { validator: Number.isInteger, message: 'Amounts are whole paise' } };
const line = { _id: false, name: { type: String, required: true, trim: true, maxlength: 60 }, amount: { ...money, required: true } };

/* ------------------------------ models ------------------------------ */

export const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid', 'other'];

const leaveSchema = new mongoose.Schema(
  {
    membershipId: { type: ObjectId, ref: 'Membership', required: true },
    type: { type: String, enum: LEAVE_TYPES, required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    // Working days (weekly days off excluded) at the time of applying.
    days: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    reviewedBy: { type: ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);
leaveSchema.plugin(tenantPlugin);
leaveSchema.index({ schoolId: 1, membershipId: 1, fromDate: -1 });
leaveSchema.index({ schoolId: 1, status: 1, fromDate: 1 });
export const StaffLeave = mongoose.model('StaffLeave', leaveSchema);

/** Monthly pay of one staff member: basic + allowances − fixed deductions. */
const salarySchema = new mongoose.Schema(
  {
    membershipId: { type: ObjectId, ref: 'Membership', required: true },
    basic: { ...money, required: true },
    allowances: { type: [line], default: [], validate: { validator: (v) => v.length <= 15, message: 'Too many allowances' } },
    deductions: { type: [line], default: [], validate: { validator: (v) => v.length <= 15, message: 'Too many deductions' } },
    bankAccount: { type: String, trim: true, maxlength: 40 },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
salarySchema.plugin(tenantPlugin);
salarySchema.index({ schoolId: 1, membershipId: 1 }, { unique: true });
export const SalaryStructure = mongoose.model('SalaryStructure', salarySchema);

const runSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    status: { type: String, enum: ['draft', 'finalized', 'paid'], default: 'draft' },
    totals: { staff: { type: Number, default: 0 }, gross: { type: Number, default: 0 }, deductions: { type: Number, default: 0 }, net: { type: Number, default: 0 } },
    voucherNo: { type: String, default: null },
    paidAt: { type: Date, default: null },
    paymentMethod: { type: String, enum: ['bank_transfer', 'cash', 'cheque', null], default: null },
    paymentReference: { type: String, trim: true, maxlength: 100 },
    createdBy: { type: ObjectId, ref: 'User' },
    finalizedBy: { type: ObjectId, ref: 'User', default: null },
    paidBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
runSchema.plugin(tenantPlugin);
runSchema.index({ schoolId: 1, month: 1 }, { unique: true });
export const PayrollRun = mongoose.model('PayrollRun', runSchema);

/** One staff member's pay for a month (a snapshot of their salary structure at generation). */
const payslipSchema = new mongoose.Schema(
  {
    runId: { type: ObjectId, ref: 'PayrollRun', required: true },
    month: { type: String, required: true },
    membershipId: { type: ObjectId, ref: 'Membership', required: true },
    employee: { name: String, email: String, employeeCode: String, designation: String, department: String, bankAccount: String },
    earnings: { type: [line], default: [] },
    deductions: { type: [line], default: [] },
    unpaidLeaveDays: { type: Number, default: 0 },
    daysInMonth: { type: Number, required: true },
    gross: { ...money, required: true },
    totalDeductions: { ...money, required: true },
    net: { ...money, required: true },
    status: { type: String, enum: ['draft', 'finalized', 'paid'], default: 'draft' },
  },
  { timestamps: true },
);
payslipSchema.plugin(tenantPlugin);
payslipSchema.index({ schoolId: 1, runId: 1, membershipId: 1 }, { unique: true });
payslipSchema.index({ schoolId: 1, membershipId: 1, month: -1 });
export const Payslip = mongoose.model('Payslip', payslipSchema);

/* ------------------------------ settings & helpers ------------------------------ */

const QUOTA_DEFAULTS = { casual: 12, sick: 10, earned: 15 };

async function hrContext(schoolId) {
  const s = await School.findById(schoolId).select('timezone settings.attendance settings.hr').lean();
  return { timezone: s?.timezone || 'UTC', weeklyOffDays: s?.settings?.attendance?.weeklyOffDays ?? [0], quota: { ...QUOTA_DEFAULTS, ...(s?.settings?.hr?.leaveQuota || {}) } };
}

export async function hrSettings(schoolId) {
  const c = await hrContext(schoolId);
  return { leaveQuota: c.quota, weeklyOffDays: c.weeklyOffDays };
}

export async function updateHrSettings(tenant, { leaveQuota }, ctx) {
  const set = Object.fromEntries(Object.entries(leaveQuota).map(([k, v]) => [`settings.hr.leaveQuota.${k}`, v]));
  await School.updateOne({ _id: tenant.schoolId }, { $set: set });
  await recordAudit({ ...ctx, action: 'hr.settings_updated', entityType: 'School', entityId: tenant.schoolId, metadata: { leaveQuota } });
  return hrSettings(tenant.schoolId);
}

/** Working days between two dates (inclusive), skipping the school's weekly days off. */
export function workingDays(from, to, weeklyOffDays) {
  let n = 0;
  for (let d = new Date(from); d <= to; d = addDays(d, 1)) if (!weeklyOffDays.includes(weekday(d))) n += 1;
  return n;
}

const isStaff = (m) => m && (m.roles.some((r) => STAFF_ROLE_VALUES.includes(r)) || m.customRoleIds?.length > 0);

async function staffMembership(schoolId, membershipId) {
  const m = await Membership.findOne({ _id: membershipId, schoolId }).populate('userId', 'name email').lean();
  if (!isStaff(m)) throw ApiError.notFound('Staff member not found');
  return m;
}

/** Leave year: the current academic session, or the calendar year when there is none. */
async function leaveYear(schoolId, today) {
  const s = await AcademicSession.findOne({ schoolId, isCurrent: true }).select('startDate endDate name').lean();
  if (s) return { from: s.startDate, to: s.endDate, label: s.name };
  const y = today.getUTCFullYear();
  return { from: parseDateOnly(`${y}-01-01`), to: parseDateOnly(`${y}-12-31`), label: String(y) };
}

/* ------------------------------ leave ------------------------------ */

export async function leaveBalance(schoolId, membershipId) {
  const c = await hrContext(schoolId);
  const year = await leaveYear(schoolId, todayIn(c.timezone));
  const used = await StaffLeave.aggregate([
    { $match: { schoolId: new mongoose.Types.ObjectId(String(schoolId)), membershipId: new mongoose.Types.ObjectId(String(membershipId)), status: { $in: ['approved', 'pending'] }, fromDate: { $gte: year.from, $lte: year.to } } },
    { $group: { _id: { type: '$type', status: '$status' }, days: { $sum: '$days' } } },
  ]);
  const get = (type, status) => used.find((u) => u._id.type === type && u._id.status === status)?.days || 0;
  return {
    year: year.label,
    types: LEAVE_TYPES.map((type) => {
      const quota = c.quota[type] ?? null;
      const taken = get(type, 'approved');
      const pending = get(type, 'pending');
      return { type, quota, taken, pending, available: quota === null ? null : Math.max(0, quota - taken - pending) };
    }),
  };
}

/** A staff member applies for leave. Quota leave types cannot exceed the remaining balance. */
export async function applyLeave(tenant, { type, fromDate, toDate, reason }, ctx) {
  const schoolId = tenant.schoolId;
  await staffMembership(schoolId, tenant.membershipId);
  const c = await hrContext(schoolId);
  const days = workingDays(fromDate, toDate, c.weeklyOffDays);
  if (!days) throw ApiError.badRequest('These dates are all days off', { code: 'NO_WORKING_DAYS' });
  const overlap = await StaffLeave.exists({ schoolId, membershipId: tenant.membershipId, status: { $in: ['pending', 'approved'] }, fromDate: { $lte: toDate }, toDate: { $gte: fromDate } });
  if (overlap) throw ApiError.conflict('You already have leave on these dates', { code: 'LEAVE_OVERLAP' });
  const bal = (await leaveBalance(schoolId, tenant.membershipId)).types.find((t) => t.type === type);
  if (bal.available !== null && days > bal.available) throw ApiError.badRequest(`Only ${bal.available} ${type} leave day(s) left`, { code: 'INSUFFICIENT_LEAVE', details: { available: bal.available, requested: days } });
  const leave = await StaffLeave.create({ schoolId, membershipId: tenant.membershipId, type, fromDate, toDate, days, reason });
  await recordAudit({ ...ctx, action: 'hr.leave_applied', entityType: 'StaffLeave', entityId: leave._id, metadata: { type, days } });
  return leave;
}

async function decorateLeaves(schoolId, rows) {
  const members = await Membership.find({ schoolId, _id: { $in: rows.map((r) => r.membershipId) } }).populate('userId', 'name email').lean();
  const m = new Map(members.map((x) => [String(x._id), x]));
  return rows.map((r) => ({ ...r, staff: m.get(String(r.membershipId)) ? { id: r.membershipId, name: m.get(String(r.membershipId)).userId?.name, email: m.get(String(r.membershipId)).userId?.email } : null }));
}

export async function listLeaves(tenant, { page, limit, status, membershipId, mine }) {
  const filter = { schoolId: tenant.schoolId };
  if (mine) filter.membershipId = tenant.membershipId;
  else if (membershipId) filter.membershipId = membershipId;
  if (status) filter.status = status;
  const [rows, total] = await Promise.all([StaffLeave.find(filter).sort({ fromDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), StaffLeave.countDocuments(filter)]);
  return { items: await decorateLeaves(tenant.schoolId, rows), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function reviewLeave(tenant, id, { status, note }, ctx) {
  const leave = await StaffLeave.findOne({ _id: id, schoolId: tenant.schoolId });
  if (!leave) throw ApiError.notFound('Leave request not found');
  if (String(leave.membershipId) === String(tenant.membershipId)) throw ApiError.forbidden('You cannot approve your own leave', { code: 'SELF_APPROVAL' });
  if (leave.status !== 'pending') throw ApiError.badRequest(`This request is already ${leave.status}`, { code: 'LEAVE_NOT_PENDING' });
  leave.set({ status, reviewNote: note, reviewedBy: ctx.actorId, reviewedAt: new Date() });
  await leave.save();
  await recordAudit({ ...ctx, action: `hr.leave_${status}`, entityType: 'StaffLeave', entityId: leave._id, metadata: { membershipId: leave.membershipId, days: leave.days } });
  const [row] = await decorateLeaves(tenant.schoolId, [leave.toObject()]);
  return row;
}

export async function cancelMyLeave(tenant, id, ctx) {
  const leave = await StaffLeave.findOne({ _id: id, schoolId: tenant.schoolId, membershipId: tenant.membershipId });
  if (!leave) throw ApiError.notFound('Leave request not found');
  const today = todayIn((await hrContext(tenant.schoolId)).timezone);
  if (leave.status === 'approved' && leave.fromDate <= today) throw ApiError.badRequest('Leave that has started cannot be cancelled', { code: 'LEAVE_STARTED' });
  if (!['pending', 'approved'].includes(leave.status)) throw ApiError.badRequest(`This request is already ${leave.status}`, { code: 'LEAVE_NOT_CANCELLABLE' });
  leave.status = 'cancelled';
  await leave.save();
  await recordAudit({ ...ctx, action: 'hr.leave_cancelled', entityType: 'StaffLeave', entityId: leave._id });
  return leave.toObject();
}

/* ------------------------------ salaries ------------------------------ */

export async function listSalaries(tenant) {
  const schoolId = tenant.schoolId;
  const members = await Membership.find({ schoolId, status: 'active', $or: [{ roles: { $in: STAFF_ROLE_VALUES } }, { 'customRoleIds.0': { $exists: true } }] }).populate('userId', 'name email').lean();
  const [structures, profiles] = await Promise.all([SalaryStructure.find({ schoolId }).lean(), StaffProfile.find({ schoolId }).select('membershipId employeeCode designation department employmentStatus').lean()]);
  const s = new Map(structures.map((x) => [String(x.membershipId), x]));
  const p = new Map(profiles.map((x) => [String(x.membershipId), x]));
  return members
    .map((m) => {
      const st = s.get(String(m._id));
      const gross = st ? st.basic + st.allowances.reduce((t, a) => t + a.amount, 0) : null;
      const ded = st ? st.deductions.reduce((t, a) => t + a.amount, 0) : null;
      return { membershipId: m._id, name: m.userId?.name, email: m.userId?.email, roles: m.roles, profile: p.get(String(m._id)) || null, salary: st || null, monthlyGross: gross, monthlyNet: st ? gross - ded : null };
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function saveSalary(tenant, membershipId, data, ctx) {
  await staffMembership(tenant.schoolId, membershipId);
  const doc = await SalaryStructure.findOneAndUpdate({ schoolId: tenant.schoolId, membershipId }, { $set: { ...data, updatedBy: ctx.actorId } }, { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true });
  await recordAudit({ ...ctx, action: 'hr.salary_saved', entityType: 'SalaryStructure', entityId: doc._id, metadata: { membershipId, basic: data.basic } });
  return doc;
}

/* ------------------------------ payroll ------------------------------ */

const monthRange = (month) => {
  const from = parseDateOnly(`${month}-01`);
  const to = addDays(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)), -1);
  return { from, to, days: to.getUTCDate() };
};

/** Unpaid-leave working days inside the month for each staff member. */
async function unpaidLeaveDays(schoolId, membershipIds, month, weeklyOffDays) {
  const { from, to } = monthRange(month);
  const leaves = await StaffLeave.find({ schoolId, membershipId: { $in: membershipIds }, type: 'unpaid', status: 'approved', fromDate: { $lte: to }, toDate: { $gte: from } }).lean();
  const out = new Map();
  for (const l of leaves) {
    const d = workingDays(new Date(Math.max(l.fromDate, from)), new Date(Math.min(l.toDate, to)), weeklyOffDays);
    out.set(String(l.membershipId), (out.get(String(l.membershipId)) || 0) + d);
  }
  return out;
}

/** Builds payslips for every active staff member with a salary (exited staff are skipped). */
async function buildPayslips(schoolId, run) {
  const c = await hrContext(schoolId);
  const { days } = monthRange(run.month);
  const structures = await SalaryStructure.find({ schoolId }).lean();
  const members = await Membership.find({ schoolId, _id: { $in: structures.map((s) => s.membershipId) }, status: 'active' }).populate('userId', 'name email').lean();
  const profiles = await StaffProfile.find({ schoolId, membershipId: { $in: members.map((m) => m._id) } }).lean();
  const pBy = new Map(profiles.map((p) => [String(p.membershipId), p]));
  const lop = await unpaidLeaveDays(schoolId, members.map((m) => m._id), run.month, c.weeklyOffDays);
  const sBy = new Map(structures.map((s) => [String(s.membershipId), s]));
  const slips = [];
  for (const m of members.filter(isStaff)) {
    const profile = pBy.get(String(m._id));
    if (profile?.employmentStatus === 'exited') continue;
    const s = sBy.get(String(m._id));
    const earnings = [{ name: 'Basic', amount: s.basic }, ...s.allowances];
    const gross = earnings.reduce((t, e) => t + e.amount, 0);
    const lopDays = lop.get(String(m._id)) || 0;
    const deductions = [...s.deductions];
    if (lopDays) deductions.push({ name: `Unpaid leave (${lopDays} day${lopDays > 1 ? 's' : ''})`, amount: Math.round((gross * lopDays) / days) });
    const totalDeductions = Math.min(gross, deductions.reduce((t, d) => t + d.amount, 0));
    slips.push({
      schoolId,
      runId: run._id,
      month: run.month,
      membershipId: m._id,
      employee: { name: m.userId?.name, email: m.userId?.email, employeeCode: profile?.employeeCode, designation: profile?.designation, department: profile?.department, bankAccount: s.bankAccount },
      earnings,
      deductions,
      unpaidLeaveDays: lopDays,
      daysInMonth: days,
      gross,
      totalDeductions,
      net: gross - totalDeductions,
    });
  }
  return slips;
}

async function writeRun(schoolId, run) {
  await Payslip.deleteMany({ schoolId, runId: run._id });
  const slips = await buildPayslips(schoolId, run);
  if (slips.length) await Payslip.insertMany(slips);
  run.totals = { staff: slips.length, gross: slips.reduce((t, s) => t + s.gross, 0), deductions: slips.reduce((t, s) => t + s.totalDeductions, 0), net: slips.reduce((t, s) => t + s.net, 0) };
  await run.save();
  return run;
}

export async function createRun(tenant, { month }, ctx) {
  let run;
  try {
    run = await PayrollRun.create({ schoolId: tenant.schoolId, month, createdBy: ctx.actorId });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict(`Payroll for ${month} already exists`, { code: 'RUN_EXISTS' });
    throw err;
  }
  await writeRun(tenant.schoolId, run);
  await recordAudit({ ...ctx, action: 'hr.payroll_created', entityType: 'PayrollRun', entityId: run._id, metadata: { month, staff: run.totals.staff, net: run.totals.net } });
  return getRun(tenant, run._id);
}

async function getRunDoc(schoolId, id) {
  const run = await PayrollRun.findOne({ _id: id, schoolId });
  if (!run) throw ApiError.notFound('Payroll run not found');
  return run;
}

export async function getRun(tenant, id) {
  const run = await getRunDoc(tenant.schoolId, id);
  const payslips = await Payslip.find({ schoolId: tenant.schoolId, runId: run._id }).sort({ 'employee.name': 1 }).lean();
  return { ...run.toObject(), payslips };
}

export const listRuns = (tenant) => PayrollRun.find({ schoolId: tenant.schoolId }).sort({ month: -1 }).lean();

/** Recalculates a draft (after salary or leave changes). */
export async function regenerateRun(tenant, id, ctx) {
  const run = await getRunDoc(tenant.schoolId, id);
  if (run.status !== 'draft') throw ApiError.badRequest('Only draft payroll can be recalculated', { code: 'RUN_NOT_DRAFT' });
  await writeRun(tenant.schoolId, run);
  await recordAudit({ ...ctx, action: 'hr.payroll_recalculated', entityType: 'PayrollRun', entityId: run._id, metadata: { net: run.totals.net } });
  return getRun(tenant, run._id);
}

export async function deleteRun(tenant, id, ctx) {
  const run = await getRunDoc(tenant.schoolId, id);
  if (run.status !== 'draft') throw ApiError.badRequest('Only draft payroll can be deleted', { code: 'RUN_NOT_DRAFT' });
  await Payslip.deleteMany({ schoolId: tenant.schoolId, runId: run._id });
  await PayrollRun.deleteOne({ _id: run._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'hr.payroll_deleted', entityType: 'PayrollRun', entityId: run._id, metadata: { month: run.month } });
}

/** Finalizing freezes the payslips and makes them visible to staff. */
export async function finalizeRun(tenant, id, ctx) {
  const run = await getRunDoc(tenant.schoolId, id);
  if (run.status !== 'draft') throw ApiError.badRequest('This payroll is already finalized', { code: 'RUN_NOT_DRAFT' });
  if (!run.totals.staff) throw ApiError.badRequest('There are no payslips in this payroll', { code: 'EMPTY_RUN' });
  run.status = 'finalized';
  run.finalizedBy = ctx.actorId;
  await run.save();
  await Payslip.updateMany({ schoolId: tenant.schoolId, runId: run._id }, { status: 'finalized' });
  await recordAudit({ ...ctx, action: 'hr.payroll_finalized', entityType: 'PayrollRun', entityId: run._id, metadata: { month: run.month, net: run.totals.net } });
  return getRun(tenant, run._id);
}

/**
 * Records that salaries were paid and posts the journal (Dr SALARY_EXPENSE, Cr BANK/CASH) in one
 * transaction, like every other money movement.
 */
export async function payRun(tenant, id, { method, paidAt, reference }, ctx) {
  const schoolId = tenant.schoolId;
  await withTransaction(
    async (s) => {
      const run = await PayrollRun.findOne({ _id: id, schoolId }).session(s);
      if (!run) throw ApiError.notFound('Payroll run not found');
      if (run.status !== 'finalized') throw ApiError.badRequest('Finalize the payroll before marking it paid', { code: 'RUN_NOT_FINALIZED' });
      const when = paidAt || new Date();
      const voucherNo = await nextNumber(schoolId, 'payroll_no', 'PAY', s);
      const account = method === 'cash' ? 'CASH' : 'BANK';
      const base = { schoolId, date: when, voucherType: 'payroll', voucherId: run._id, voucherNo, createdBy: ctx.actorId };
      await LedgerEntry.insertMany(
        [
          { ...base, account: 'SALARY_EXPENSE', debit: run.totals.net, credit: 0, narration: `Salaries for ${run.month}` },
          { ...base, account, debit: 0, credit: run.totals.net, narration: `Salaries for ${run.month} (${method.replace('_', ' ')})` },
        ],
        { session: s },
      );
      run.set({ status: 'paid', paidAt: when, paymentMethod: method, paymentReference: reference, paidBy: ctx.actorId, voucherNo });
      await run.save({ session: s });
      await Payslip.updateMany({ schoolId, runId: run._id }, { status: 'paid' }, { session: s });
      await recordAudit({ ...ctx, action: 'hr.payroll_paid', entityType: 'PayrollRun', entityId: run._id, metadata: { month: run.month, net: run.totals.net, voucherNo, method } }, { session: s });
    },
    { required: true },
  );
  return getRun(tenant, id);
}

/** Staff see their own finalized or paid payslips. */
export async function myPayslips(tenant) {
  return Payslip.find({ schoolId: tenant.schoolId, membershipId: tenant.membershipId, status: { $in: ['finalized', 'paid'] } }).sort({ month: -1 }).limit(24).lean();
}

export async function getPayslip(tenant, id, { own }) {
  const filter = { _id: id, schoolId: tenant.schoolId, ...(own ? { membershipId: tenant.membershipId, status: { $in: ['finalized', 'paid'] } } : {}) };
  const slip = await Payslip.findOne(filter).lean();
  if (!slip) throw ApiError.notFound('Payslip not found');
  const school = await School.findById(tenant.schoolId).select('name address').lean();
  return { ...slip, school: { name: school?.name, address: school?.address ?? null } };
}
