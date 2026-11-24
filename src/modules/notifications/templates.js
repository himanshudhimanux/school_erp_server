import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';

/**
 * Message templates for automatic notifications. Each school may override the wording of any
 * template; placeholders are written {{name}} and only the variables listed for the template
 * may be used. The same text goes to every channel (SMS/WhatsApp use the body).
 */
export const TEMPLATE_CATALOG = Object.freeze({
  'attendance.absent': {
    label: 'Absent alert',
    description: 'Sent to parents when a student is marked absent for the day.',
    variables: ['student', 'class', 'date', 'school'],
    title: '{{student}} was marked absent today',
    body: '{{student}} ({{class}}) was marked absent on {{date}}. Please contact the school if this is unexpected. - {{school}}',
  },
  'attendance.late': {
    label: 'Late arrival alert',
    description: 'Sent to parents when a student is marked late (only if late alerts are on).',
    variables: ['student', 'class', 'date', 'school'],
    title: '{{student}} was marked late today',
    body: '{{student}} ({{class}}) was marked late on {{date}}. Please contact the school if this is unexpected. - {{school}}',
  },
  'fees.reminder.before': {
    label: 'Fee reminder: before due date',
    description: 'Automated reminder sent the configured number of days before an invoice is due.',
    variables: ['student', 'invoiceNo', 'invoiceTitle', 'amount', 'dueDate', 'school'],
    title: 'Fee due on {{dueDate}}',
    body: '{{invoiceTitle}} ({{invoiceNo}}) for {{student}}: {{amount}} is due on {{dueDate}}. - {{school}}',
  },
  'fees.reminder.due': {
    label: 'Fee reminder: due today',
    description: 'Sent on the due date of an unpaid invoice.',
    variables: ['student', 'invoiceNo', 'invoiceTitle', 'amount', 'dueDate', 'school'],
    title: 'Fee due today',
    body: '{{invoiceTitle}} ({{invoiceNo}}) for {{student}}: {{amount}} is due today. - {{school}}',
  },
  'fees.reminder.overdue': {
    label: 'Fee reminder: overdue',
    description: 'Sent the configured number of days after the due date while the invoice is unpaid.',
    variables: ['student', 'invoiceNo', 'invoiceTitle', 'amount', 'dueDate', 'school'],
    title: 'Fee overdue',
    body: '{{invoiceTitle}} ({{invoiceNo}}) for {{student}}: {{amount}} was due on {{dueDate}} and is still unpaid. Please pay at the earliest. - {{school}}',
  },
  'exam.results': {
    label: 'Exam results published',
    description: 'Sent to students and parents when exam results are published.',
    variables: ['exam', 'student', 'school'],
    title: '{{exam}} results are out',
    body: '{{exam}} results for {{student}} have been published. Open the app to view the report card. - {{school}}',
  },
});

export const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATE_CATALOG));

const templateSchema = new mongoose.Schema(
  {
    key: { type: String, enum: TEMPLATE_KEYS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
templateSchema.plugin(tenantPlugin);
templateSchema.index({ schoolId: 1, key: 1 }, { unique: true });
export const NotificationTemplate = mongoose.model('NotificationTemplate', templateSchema);

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/** Placeholders used in `text` that the template does not offer. */
export function unknownPlaceholders(key, text) {
  const allowed = new Set(TEMPLATE_CATALOG[key].variables);
  return [...new Set([...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]).filter((v) => !allowed.has(v)))];
}

export const fill = (text, vars) => String(text).replace(PLACEHOLDER, (_m, name) => (vars[name] === undefined || vars[name] === null ? '' : String(vars[name])));

/**
 * Loads a school's overrides once and returns render(key, vars) → { title, body }.
 * Use one renderer per batch of notifications.
 */
export async function templateRenderer(schoolId) {
  const overrides = await NotificationTemplate.find({ schoolId }).select('key title body').lean();
  const byKey = new Map(overrides.map((o) => [o.key, o]));
  return (key, vars) => {
    const t = byKey.get(key) || TEMPLATE_CATALOG[key];
    return { title: fill(t.title, vars).slice(0, 200), body: fill(t.body, vars).slice(0, 2000) };
  };
}
