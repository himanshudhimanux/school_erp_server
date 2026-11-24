import mongoose from 'mongoose';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { Membership } from '../memberships/membership.model.js';
import { AttendanceSheet, AttendanceRecord } from '../attendance/attendance.models.js';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models.js';
import { Exam, ExamResult } from '../exams/exam.models.js';
import { HostelRoom } from '../hostel/hostel.service.js';
import { Notification } from '../notifications/notification.model.js';
import { studentAccess, studentFilter, assertSectionAccess } from '../students/access.js';
import { studentSummary, listStudents } from '../students/student.service.js';
import { listStaff } from '../staff/staff.service.js';
import { listPayments } from '../fees/payment.service.js';
import { collections, outstandingByClass, defaulters } from '../fees/report.service.js';
import { schoolToday } from '../fees/invoice.service.js';
import { librarySummary } from '../library/library.service.js';
import { sectionResults } from '../exams/marks.service.js';
import { nameMap, idStr } from '../academics/academics.common.js';
import { currentPlacement } from '../parents/guardian.service.js';
import { STAFF_ROLE_VALUES, ROLE_LABELS } from '../../constants/roles.js';
import { isCampusRestricted } from '../../utils/campusScope.js';
import { addDays, daysBetween, formatDateOnly } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';
import { toCsv, rupees } from './csv.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const MAX_ROWS = 20000;
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);

/* ------------------------------ overview ------------------------------ */

async function studentsSection(tenant, session) {
  const schoolId = tenant.schoolId;
  const access = await studentAccess(tenant);
  const summary = await studentSummary(tenant);
  let byClass = [];
  let byGender = {};
  if (session) {
    const ids = await Student.distinct('_id', { schoolId, status: 'active', ...studentFilter(access) });
    const rows = await Enrollment.aggregate([
      { $match: { schoolId: oid(schoolId), sessionId: session._id, status: 'active', studentId: { $in: ids } } },
      { $group: { _id: '$classId', n: { $sum: 1 } } },
    ]);
    const classes = await nameMap(SchoolClass, schoolId, rows.map((r) => r._id), 'name order');
    byClass = rows.map((r) => ({ classId: r._id, name: classes.get(idStr(r._id))?.name ?? '—', order: classes.get(idStr(r._id))?.order ?? 9999, students: r.n })).sort((a, b) => a.order - b.order);
    const genders = await Student.aggregate([{ $match: { schoolId: oid(schoolId), isDeleted: false, status: 'active', _id: { $in: ids } } }, { $group: { _id: '$gender', n: { $sum: 1 } } }]);
    byGender = Object.fromEntries(genders.map((g) => [g._id || 'unspecified', g.n]));
  }
  return { ...summary, byClass, byGender };
}

async function staffSection(tenant) {
  const match = { schoolId: oid(tenant.schoolId), status: 'active', roles: { $in: STAFF_ROLE_VALUES } };
  if (isCampusRestricted(tenant)) match.$or = [{ campusIds: { $size: 0 } }, { campusIds: { $in: tenant.campusIds.map(oid) } }];
  const [total, byRole] = await Promise.all([
    Membership.countDocuments(match),
    Membership.aggregate([{ $match: match }, { $unwind: '$roles' }, { $match: { roles: { $in: STAFF_ROLE_VALUES } } }, { $group: { _id: '$roles', n: { $sum: 1 } } }]),
  ]);
  return { active: total, byRole: byRole.map((r) => ({ role: r._id, label: ROLE_LABELS[r._id], count: r.n })).sort((a, b) => b.count - a.count) };
}

/** Daily attendance for the last 30 days from submitted registers (days without any register are left out). */
async function attendanceSection(tenant, today) {
  const match = { schoolId: oid(tenant.schoolId), date: { $gte: addDays(today, -29), $lte: today } };
  if (isCampusRestricted(tenant)) match.campusId = { $in: tenant.campusIds.map(oid) };
  const rows = await AttendanceSheet.aggregate([
    { $match: match },
    { $group: { _id: '$date', total: { $sum: '$counts.total' }, present: { $sum: '$counts.present' }, late: { $sum: '$counts.late' }, absent: { $sum: '$counts.absent' }, leave: { $sum: '$counts.leave' }, sections: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const days = rows.map((r) => ({ date: formatDateOnly(r._id), sections: r.sections, total: r.total, present: r.present, late: r.late, absent: r.absent, leave: r.leave, percentage: pct(r.present + r.late, r.total) }));
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  return { from: formatDateOnly(addDays(today, -29)), to: formatDateOnly(today), days, average: pct(sum('present') + sum('late'), sum('total')), today: days.find((d) => d.date === formatDateOnly(today)) || null };
}

/** Receipts per month for the last 12 months (school timezone dates) plus what is still owed. */
async function feesSection(tenant, today) {
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const [daily, outstanding] = await Promise.all([collections(tenant, { from, to: today, groupBy: 'day' }), outstandingByClass(tenant, {})]);
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    months.push({ month: d.toISOString().slice(0, 7), amount: 0, count: 0 });
  }
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const r of daily.rows) {
    const m = byMonth.get(String(r.key).slice(0, 7));
    if (m) {
      m.amount += r.amount;
      m.count += r.count;
    }
  }
  return { months, totals: daily.totals, outstanding: outstanding.totals, outstandingByClass: outstanding.rows };
}

/** Pass rates of the most recently published exams. */
async function examsSection(tenant, session) {
  if (!session) return { exams: [] };
  const exams = await Exam.find({ schoolId: tenant.schoolId, sessionId: session._id, status: 'published' }).sort({ publishedAt: -1 }).limit(5).select('name publishedAt').lean();
  const access = await studentAccess(tenant);
  const studentIds = access.restricted ? await Student.distinct('_id', { schoolId: tenant.schoolId, ...studentFilter(access) }) : null;
  const stats = await ExamResult.aggregate([
    { $match: { schoolId: oid(tenant.schoolId), examId: { $in: exams.map((e) => e._id) }, ...(studentIds ? { studentId: { $in: studentIds } } : {}) } },
    { $group: { _id: '$examId', students: { $sum: 1 }, pass: { $sum: { $cond: [{ $eq: ['$result', 'pass'] }, 1, 0] } }, fail: { $sum: { $cond: [{ $eq: ['$result', 'fail'] }, 1, 0] } }, average: { $avg: '$percentage' } } },
  ]);
  const by = new Map(stats.map((s) => [String(s._id), s]));
  return {
    exams: exams.map((e) => {
      const s = by.get(String(e._id)) || { students: 0, pass: 0, fail: 0, average: null };
      return { examId: e._id, name: e.name, publishedAt: e.publishedAt, students: s.students, pass: s.pass, fail: s.fail, passRate: pct(s.pass, s.pass + s.fail), average: s.average === null ? null : Math.round(s.average * 10) / 10 };
    }),
  };
}

async function hostelSection(tenant) {
  const [r] = await HostelRoom.aggregate([{ $match: { schoolId: oid(tenant.schoolId), status: { $ne: 'inactive' } } }, { $group: { _id: null, rooms: { $sum: 1 }, beds: { $sum: '$capacity' }, occupied: { $sum: '$occupied' } } }]);
  return { rooms: r?.rooms ?? 0, beds: r?.beds ?? 0, occupied: r?.occupied ?? 0, occupancy: pct(r?.occupied ?? 0, r?.beds ?? 0) };
}

async function communicationSection(tenant, today) {
  const rows = await Notification.aggregate([
    { $match: { schoolId: oid(tenant.schoolId), createdAt: { $gte: addDays(today, -29) } } },
    { $group: { _id: { channel: '$channel', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const byChannel = {};
  for (const r of rows) (byChannel[r._id.channel] ||= {})[r._id.status] = r.n;
  return { since: formatDateOnly(addDays(today, -29)), byChannel };
}

/**
 * The school at a glance. Each section is included only when the caller holds the permission for
 * that area, so the overview never shows more than the caller could see on the module's own pages.
 * Every figure is computed from stored records.
 */
export async function overview(tenant) {
  const can = (p) => tenant.permissions.has(p);
  const today = await schoolToday(tenant);
  const session = await AcademicSession.findOne({ schoolId: tenant.schoolId, isCurrent: true }).select('name').lean();
  const tasks = {
    students: can('students.read') && studentsSection(tenant, session),
    staff: can('staff.read') && staffSection(tenant),
    attendance: can('attendance.reports') && attendanceSection(tenant, today),
    fees: can('fees.reports') && feesSection(tenant, today),
    exams: can('exams.read') && examsSection(tenant, session),
    library: can('library.read') && librarySummary(tenant),
    hostel: can('hostel.read') && hostelSection(tenant),
    communication: can('communication.send') && communicationSection(tenant, today),
  };
  const entries = await Promise.all(Object.entries(tasks).filter(([, t]) => t).map(async ([k, t]) => [k, await t]));
  return { asOf: formatDateOnly(today), session: session ? { id: session._id, name: session.name } : null, ...Object.fromEntries(entries) };
}

/* ------------------------------ exports ------------------------------ */

/** Pages through a list function until every row is collected (capped). */
async function collectAll(fn, query) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const { items } = await fn({ ...query, page, limit: 100 });
    out.push(...items);
    if (items.length < 100) break;
    if (out.length >= MAX_ROWS) throw ApiError.badRequest(`The report has more than ${MAX_ROWS} rows; narrow the filters`, { code: 'REPORT_TOO_LARGE' });
  }
  return out;
}

async function attendanceRows(tenant, { from, to, classId, sectionId }) {
  if (to < from) throw ApiError.validation([{ field: 'query.to', message: 'End date must be on or after the start date' }]);
  if (daysBetween(from, to) > 366) throw ApiError.validation([{ field: 'query.to', message: 'Range can be at most one year' }]);
  const schoolId = tenant.schoolId;
  const access = await studentAccess(tenant);
  const match = { schoolId: oid(schoolId), date: { $gte: from, $lte: to } };
  if (sectionId) {
    const section = await Section.findOne({ _id: sectionId, schoolId }).lean();
    if (!section) throw ApiError.notFound('Section not found');
    assertSectionAccess(access, section);
    match.sectionId = section._id;
  } else if (classId) {
    const sections = await Section.find({ schoolId, classId }).select('_id campusId').lean();
    match.sectionId = { $in: sections.filter((s) => (!access.campusIds || access.campusIds.includes(String(s.campusId))) && (!access.sectionIds || access.sectionIds.includes(String(s._id)))).map((s) => s._id) };
  } else if (access.restricted) {
    if (access.campusIds) match.campusId = { $in: access.campusIds.map(oid) };
    if (access.sectionIds) match.sectionId = { $in: access.sectionIds.map(oid) };
  }
  const rows = await AttendanceRecord.aggregate([
    { $match: match },
    { $group: { _id: '$studentId', days: { $sum: 1 }, present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } }, late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } }, absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } }, leave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } }, sectionId: { $last: '$sectionId' }, sessionId: { $last: '$sessionId' } } },
  ]);
  if (rows.length > MAX_ROWS) throw ApiError.badRequest(`The report has more than ${MAX_ROWS} rows; narrow the filters`, { code: 'REPORT_TOO_LARGE' });
  const students = await nameMap(Student, schoolId, rows.map((r) => r._id), 'firstName lastName admissionNo');
  const placement = new Map();
  for (const sessionId of new Set(rows.map((r) => String(r.sessionId)))) {
    const ids = rows.filter((r) => String(r.sessionId) === sessionId).map((r) => r._id);
    for (const [k, v] of await currentPlacement(schoolId, sessionId, ids)) placement.set(k, v);
  }
  return rows
    .map((r) => {
      const s = students.get(idStr(r._id));
      return { admissionNo: s?.admissionNo ?? '', name: s ? fullName(s) : '', classSection: placement.get(String(r._id))?.displayName ?? '', ...r, percentage: pct(r.present + r.late, r.days) };
    })
    .sort((a, b) => a.classSection.localeCompare(b.classSection) || a.name.localeCompare(b.name));
}

/**
 * Downloadable reports. Each declares the permission it needs (on top of reports.read) and is
 * built from the same service functions as the on-screen pages, so access rules are identical.
 */
export const EXPORTS = {
  students: {
    label: 'Students',
    description: 'Student list with class, section and primary guardian.',
    permission: 'students.read',
    async build(tenant, q) {
      const rows = await collectAll((p) => listStudents(tenant, p), { ...q, sort: 'name' });
      return toCsv(
        [
          { header: 'Admission No', value: (r) => r.admissionNo },
          { header: 'Name', value: (r) => r.fullName },
          { header: 'Class - Section', value: (r) => r.enrollment?.displayName ?? '' },
          { header: 'Roll No', value: (r) => r.enrollment?.rollNo ?? '' },
          { header: 'Gender', value: (r) => r.gender },
          { header: 'Date of Birth', value: (r) => r.dateOfBirth },
          { header: 'Status', value: (r) => r.status },
          { header: 'Admission Date', value: (r) => r.admissionDate },
          { header: 'Guardian', value: (r) => r.primaryGuardian?.name ?? '' },
          { header: 'Relation', value: (r) => r.primaryGuardian?.relation ?? '' },
          { header: 'Guardian Phone', value: (r) => r.primaryGuardian?.phone ?? '' },
        ],
        rows,
      );
    },
  },
  staff: {
    label: 'Teachers & staff',
    description: 'Employee directory with roles, department and contact details.',
    permission: 'staff.read',
    async build(tenant, q) {
      const rows = await collectAll((p) => listStaff(tenant, p), q);
      return toCsv(
        [
          { header: 'Employee Code', value: (r) => r.profile?.employeeCode ?? '' },
          { header: 'Name', value: (r) => r.user.name },
          { header: 'Roles', value: (r) => r.roleLabels.join('; ') },
          { header: 'Department', value: (r) => r.profile?.department ?? '' },
          { header: 'Designation', value: (r) => r.profile?.designation ?? '' },
          { header: 'Email', value: (r) => r.user.email },
          { header: 'Phone', value: (r) => r.user.phone ?? '' },
          { header: 'Joining Date', value: (r) => r.profile?.joiningDate ?? '' },
          { header: 'Employment Status', value: (r) => r.profile?.employmentStatus ?? '' },
          { header: 'Account Status', value: (r) => r.status },
        ],
        rows,
      );
    },
  },
  attendance: {
    label: 'Attendance summary',
    description: 'Days present, late, absent and on leave per student for a date range.',
    permission: 'attendance.reports',
    async build(tenant, q) {
      const rows = await attendanceRows(tenant, q);
      return toCsv(
        [
          { header: 'Admission No', value: (r) => r.admissionNo },
          { header: 'Name', value: (r) => r.name },
          { header: 'Class - Section', value: (r) => r.classSection },
          { header: 'Days Marked', value: (r) => r.days },
          { header: 'Present', value: (r) => r.present },
          { header: 'Late', value: (r) => r.late },
          { header: 'Absent', value: (r) => r.absent },
          { header: 'Leave', value: (r) => r.leave },
          { header: 'Attendance %', value: (r) => r.percentage },
        ],
        rows,
      );
    },
  },
  'fee-payments': {
    label: 'Fee payments',
    description: 'Every receipt in a date range with method, source and refunds.',
    permission: 'fees.reports',
    async build(tenant, q) {
      const rows = await collectAll((p) => listPayments(tenant, p), q);
      return toCsv(
        [
          { header: 'Receipt No', value: (r) => r.receiptNo },
          { header: 'Date', value: (r) => r.paidAt },
          { header: 'Admission No', value: (r) => r.student?.admissionNo ?? '' },
          { header: 'Student', value: (r) => r.student?.name ?? '' },
          { header: 'Amount', value: (r) => rupees(r.amount) },
          { header: 'Refunded', value: (r) => rupees(r.refundedAmount) },
          { header: 'Method', value: (r) => r.method },
          { header: 'Source', value: (r) => r.source },
          { header: 'Status', value: (r) => r.status },
          { header: 'Reference', value: (r) => r.reference ?? '' },
          { header: 'Invoices', value: (r) => r.invoices.join('; ') },
        ],
        rows,
      );
    },
  },
  'fee-defaulters': {
    label: 'Fee defaulters',
    description: 'Students with overdue balances and the guardian to contact.',
    permission: 'fees.reports',
    async build(tenant, q) {
      const rows = await collectAll((p) => defaulters(tenant, p), q);
      return toCsv(
        [
          { header: 'Admission No', value: (r) => r.admissionNo },
          { header: 'Student', value: (r) => r.name },
          { header: 'Class - Section', value: (r) => r.classSection ?? '' },
          { header: 'Overdue Amount', value: (r) => rupees(r.overdueAmount) },
          { header: 'Overdue Invoices', value: (r) => r.overdueInvoices },
          { header: 'Oldest Due Date', value: (r) => r.oldestDueDate },
          { header: 'Days Overdue', value: (r) => r.daysOverdue },
          { header: 'Guardian', value: (r) => r.primaryGuardian?.name ?? '' },
          { header: 'Guardian Phone', value: (r) => r.primaryGuardian?.phone ?? '' },
          { header: 'Guardian Email', value: (r) => r.primaryGuardian?.email ?? '' },
        ],
        rows,
      );
    },
  },
  'exam-results': {
    label: 'Exam results',
    description: 'Marks, grade and rank for one section of an exam.',
    permission: 'exams.read',
    async build(tenant, q) {
      const data = await sectionResults(tenant, q.examId, q.sectionId);
      const subjects = [...new Map(data.results.flatMap((r) => r.subjects.map((s) => [String(s.subjectId), s.subjectName || s.name || 'Subject']))).entries()];
      return toCsv(
        [
          { header: 'Admission No', value: (r) => r.student?.admissionNo ?? '' },
          { header: 'Student', value: (r) => r.student?.name ?? '' },
          ...subjects.map(([sid, name]) => ({ header: name, value: (r) => r.subjects.find((s) => String(s.subjectId) === sid)?.marks ?? '' })),
          { header: 'Total', value: (r) => r.total },
          { header: 'Max Total', value: (r) => r.maxTotal },
          { header: 'Percentage', value: (r) => r.percentage },
          { header: 'Grade', value: (r) => r.grade ?? '' },
          { header: 'Result', value: (r) => r.result },
          { header: 'Rank in Section', value: (r) => r.rankInSection ?? '' },
          { header: 'Rank in Class', value: (r) => r.rankInClass ?? '' },
          { header: 'Status', value: () => (data.preview ? 'Draft (not published)' : 'Published') },
        ],
        data.results,
      );
    },
  },
};

export function exportCatalog(tenant) {
  return Object.entries(EXPORTS).map(([key, e]) => ({ key, label: e.label, description: e.description, available: tenant.permissions.has(e.permission) }));
}
