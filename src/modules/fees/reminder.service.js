import mongoose from 'mongoose';
import { FeeInvoice } from './fee.models.js';
import { staffInvoiceScope, schoolToday, getInvoiceDoc } from './invoice.service.js';
import { formatMoney } from './money.js';
import { Student, fullName } from '../students/student.model.js';
import { School } from '../schools/school.model.js';
import { Notification } from '../notifications/notification.model.js';
import { queueNotifications, buildDeliveries, providerStatus, CHANNEL_LABELS } from '../notifications/notification.service.js';
import { guardianRecipients } from '../notifications/recipients.js';
import { templateRenderer } from '../notifications/templates.js';
import { addDays, formatDateOnly } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const OPEN = ['unpaid', 'partially_paid'];
const DEFAULTS = { enabled: false, beforeDays: [3, 1], onDueDate: true, afterDays: [3, 7], channels: ['in_app', 'email'], sendHour: 9 };
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export async function reminderSettings(schoolId) {
  const s = await School.findById(schoolId).select('name currency timezone settings.fees').lean();
  const r = s?.settings?.fees?.reminders || {};
  const pick = (k) => (r[k] === undefined || r[k] === null ? DEFAULTS[k] : r[k]);
  return {
    enabled: pick('enabled'),
    beforeDays: pick('beforeDays'),
    onDueDate: pick('onDueDate'),
    afterDays: pick('afterDays'),
    channels: pick('channels'),
    sendHour: pick('sendHour'),
    schoolName: s?.name || '',
    currency: s?.currency || 'INR',
    timezone: s?.timezone || 'UTC',
  };
}

/** Rules as day offsets from the due date: -3 = three days before, 0 = due date, 7 = a week late. */
function rules(settings) {
  return [
    ...settings.beforeDays.map((d) => ({ key: `before_${d}`, offset: -d })),
    ...(settings.onDueDate ? [{ key: 'due', offset: 0 }] : []),
    ...settings.afterDays.map((d) => ({ key: `after_${d}`, offset: d })),
  ];
}

/** Which reminder template applies: before the due date, on it, or overdue. */
function templateKey(inv, rule, today) {
  if (rule.offset < 0) return 'fees.reminder.before';
  if (rule.offset === 0 && inv.dueDate >= today) return 'fees.reminder.due';
  return 'fees.reminder.overdue';
}

/** Builds one notification per guardian (receiving alerts) and configured channel they can be reached on. */
async function buildDocs(schoolId, invoices, settings, ruleFor, today) {
  const studentIds = [...new Set(invoices.map((i) => String(i.studentId)))];
  const [students, contacts, render] = await Promise.all([
    Student.find({ schoolId, _id: { $in: studentIds } }).select('firstName lastName status').lean(),
    guardianRecipients(schoolId, studentIds),
    templateRenderer(schoolId),
  ]);
  const sBy = new Map(students.map((s) => [String(s._id), s]));
  const unreachable = [];
  const items = [];
  for (const inv of invoices) {
    const student = sBy.get(String(inv.studentId));
    if (!student) continue;
    const rule = ruleFor(inv);
    const { title, body } = render(templateKey(inv, rule, today), {
      student: fullName(student),
      invoiceNo: inv.invoiceNo,
      invoiceTitle: inv.title,
      amount: formatMoney(inv.total - inv.paidAmount, settings.currency),
      dueDate: fmtDate(inv.dueDate),
      school: settings.schoolName,
    });
    const data = { studentId: inv.studentId, invoiceId: inv._id, date: today };
    const base = `fees.reminder:${inv._id}:${rule.key}`;
    const guardians = contacts.get(String(inv.studentId)) || [];
    if (!guardians.length) {
      unreachable.push({ type: 'fees.reminder', channel: 'none', recipient: {}, title, body, data, error: 'NO_GUARDIAN', dedupeKey: `${base}:none` });
      continue;
    }
    for (const recipient of guardians) items.push({ recipient, type: 'fees.reminder', title, body, data, key: `${base}:${recipient.guardianId}` });
  }
  return [...unreachable, ...(await buildDeliveries(schoolId, items, settings.channels))];
}

/**
 * Sends today's reminders for every rule. Each (invoice, rule, guardian, channel) is sent at most
 * once, so running it many times a day is harmless. Called hourly by the scheduler.
 */
export async function runFeeReminders(schoolId, today, { settings: given } = {}) {
  const settings = given || (await reminderSettings(schoolId));
  if (!settings.enabled) return { enabled: false, invoices: 0, notificationsQueued: 0 };
  let invoices = 0;
  let queued = 0;
  for (const rule of rules(settings)) {
    const due = addDays(today, -rule.offset);
    const rows = await FeeInvoice.find({ schoolId, status: { $in: OPEN }, dueDate: due }).lean();
    if (!rows.length) continue;
    invoices += rows.length;
    queued += await queueNotifications(schoolId, await buildDocs(schoolId, rows, settings, () => rule, today));
  }
  return { enabled: true, invoices, notificationsQueued: queued };
}

/** Sends a reminder for one invoice now. At most one manual reminder per invoice per day. */
export async function remindInvoice(tenant, invoiceId, ctx) {
  const inv = (await getInvoiceDoc(tenant, invoiceId)).toObject();
  if (!OPEN.includes(inv.status)) throw ApiError.badRequest('Only unpaid invoices can be reminded', { code: 'INVOICE_NOT_OPEN' });
  const settings = await reminderSettings(tenant.schoolId);
  const today = await schoolToday(tenant);
  const rule = { key: `manual_${formatDateOnly(today)}`, offset: inv.dueDate < today ? 1 : inv.dueDate > today ? -1 : 0 };
  const docs = await buildDocs(tenant.schoolId, [inv], settings, () => rule, today);
  const queued = await queueNotifications(tenant.schoolId, docs);
  if (!queued) throw ApiError.conflict('A reminder for this invoice was already sent today', { code: 'ALREADY_REMINDED_TODAY' });
  await recordAudit({ ...ctx, action: 'invoice.reminder_sent', entityType: 'FeeInvoice', entityId: inv._id, metadata: { invoiceNo: inv.invoiceNo, notifications: queued } });
  return { notificationsQueued: queued, unreachable: docs.filter((d) => d.channel === 'none').length };
}

/** Everything the reminders page shows: settings, channels, what is coming up, and real delivery results. */
export async function reminderOverview(tenant) {
  const schoolId = tenant.schoolId;
  const settings = await reminderSettings(schoolId);
  const today = await schoolToday(tenant);
  const scope = await staffInvoiceScope(tenant);

  // Upcoming: invoices that a rule will remind in the next 7 days.
  const upcoming = [];
  for (let d = 0; d <= 7 && settings.enabled; d += 1) {
    const day = addDays(today, d);
    for (const rule of rules(settings)) {
      const n = await FeeInvoice.countDocuments({ ...scope, status: { $in: OPEN }, dueDate: addDays(day, -rule.offset) });
      if (n) upcoming.push({ date: formatDateOnly(day), rule: rule.key, invoices: n });
    }
  }
  const since = addDays(today, -30);
  const match = { schoolId: oid(schoolId), type: 'fees.reminder', createdAt: { $gte: since } };
  const [byStatus, byChannel, recent] = await Promise.all([
    Notification.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Notification.aggregate([{ $match: match }, { $group: { _id: { channel: '$channel', status: '$status' }, n: { $sum: 1 } } }]),
    Notification.find({ schoolId, type: 'fees.reminder' }).select('channel recipient.name title status error createdAt sentAt data').sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const { schoolName: _n, currency: _c, timezone, ...rest } = settings;
  return {
    settings: { ...rest, timezone },
    // Every channel, with whether the platform can deliver it; the page offers only available ones.
    channels: Object.entries(providerStatus()).map(([channel, available]) => ({ channel, label: channel === 'in_app' ? 'Parent app inbox' : CHANNEL_LABELS[channel], available })),
    upcoming,
    last30Days: { byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])), byChannel: byChannel.map((r) => ({ channel: r._id.channel, status: r._id.status, count: r.n })) },
    recent,
  };
}
