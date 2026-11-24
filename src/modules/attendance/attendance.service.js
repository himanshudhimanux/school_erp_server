import mongoose from 'mongoose';
import { AttendanceSheet, AttendanceRecord, LeaveRequest } from './attendance.models.js';
import { Student, Enrollment, fullName } from '../students/student.model.js';
import { Guardian, StudentGuardian } from '../parents/guardian.model.js';
import { Section, SchoolClass, AcademicSession } from '../academics/academics.models.js';
import { CalendarEvent } from '../calendar/calendarEvent.model.js';
import { School } from '../schools/school.model.js';
import { getSessionOr404, assertSessionOpen, nameMap, idStr } from '../academics/academics.common.js';
import { studentAccess, getStudentDoc, assertSectionAccess } from '../students/access.js';
import { currentPlacement } from '../parents/guardian.service.js';
import { nonWorkingDates } from '../calendar/calendar.service.js';
import { queueNotifications, cancelUnsent, buildDeliveries, alertChannels } from '../notifications/notification.service.js';
import { guardianRecipients } from '../notifications/recipients.js';
import { templateRenderer } from '../notifications/templates.js';
import { Notification } from '../notifications/notification.model.js';
import { todayIn, formatDateOnly, addDays, weekday, parseDateOnly, daysBetween } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const ALERT_TYPES = ['attendance.absent', 'attendance.late'];
const ATTENDED = ['present', 'late'];

/* ------------------------------ settings & days ------------------------------ */

const DEFAULTS = { weeklyOffDays: [0], teacherEditDays: 1, absentAlerts: true, alertOnLate: false, lowAttendanceThreshold: 75 };

export async function attendanceSettings(schoolId) {
  const s = await School.findById(schoolId).select('name timezone settings.attendance').lean();
  const a = s?.settings?.attendance || {};
  const pick = (k) => (a[k] === undefined || a[k] === null ? DEFAULTS[k] : a[k]);
  return {
    weeklyOffDays: pick('weeklyOffDays'),
    teacherEditDays: pick('teacherEditDays'),
    absentAlerts: pick('absentAlerts'),
    alertOnLate: pick('alertOnLate'),
    lowAttendanceThreshold: pick('lowAttendanceThreshold'),
    timezone: s?.timezone || 'UTC',
    schoolName: s?.name || '',
  };
}

/** Is the date a working day for a campus? Weekly days off and calendar holidays/vacations are not. */
async function dayInfo(schoolId, date, campusId, settings) {
  if (settings.weeklyOffDays.includes(weekday(date))) return { isWorkingDay: false, reason: 'weekly_off', title: null };
  const holiday = await CalendarEvent.findOne({
    schoolId,
    isNonWorking: true,
    startDate: { $lte: date },
    endDate: { $gte: date },
    $or: [{ campusIds: { $size: 0 } }, ...(campusId ? [{ campusIds: campusId }] : [])],
  })
    .select('title type')
    .lean();
  if (holiday) return { isWorkingDay: false, reason: holiday.type, title: holiday.title };
  return { isWorkingDay: true, reason: null, title: null };
}

/**
 * Whether the caller may submit attendance for `date`. `attendance.update` (admin, principal)
 * may edit any date in an open session; `attendance.mark` alone (teachers) only within the
 * school's teacherEditDays window.
 */
function editState(tenant, date, today, settings) {
  if (date > today) return { canEdit: false, reason: 'FUTURE_DATE' };
  if (tenant.permissions.has('attendance.update')) return { canEdit: true, reason: null };
  if (!tenant.permissions.has('attendance.mark')) return { canEdit: false, reason: 'PERMISSION_DENIED' };
  if (date < addDays(today, -settings.teacherEditDays)) return { canEdit: false, reason: 'ATTENDANCE_LOCKED' };
  return { canEdit: true, reason: null };
}

/** A section the caller may work with: campus access, and for teachers only their own sections. */
async function loadSection(tenant, sectionId) {
  const section = await Section.findOne({ _id: sectionId, schoolId: tenant.schoolId }).lean();
  if (!section) throw ApiError.notFound('Section not found');
  const access = await studentAccess(tenant, { sessionId: section.sessionId });
  assertSectionAccess(access, section);
  const cls = await SchoolClass.findOne({ _id: section.classId, schoolId: tenant.schoolId }).setOptions({ withDeleted: true }).select('name order').lean();
  return { section, access, displayName: `${cls?.name ?? ''} - ${section.name}`, classOrder: cls?.order ?? 9999 };
}

const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Approved leave covering `date` for the given students: studentId → leaveRequestId. */
async function approvedLeaves(schoolId, studentIds, date) {
  const rows = await LeaveRequest.find({ schoolId, studentId: { $in: studentIds }, status: 'approved', fromDate: { $lte: date }, toDate: { $gte: date } })
    .select('studentId')
    .lean();
  return new Map(rows.map((r) => [String(r.studentId), r._id]));
}

export async function recomputeSheetCounts(schoolId, sheetIds) {
  const ids = [...new Set(sheetIds.map(String))];
  if (!ids.length) return;
  const rows = await AttendanceRecord.aggregate([
    { $match: { schoolId: oid(schoolId), sheetId: { $in: ids.map(oid) } } },
    { $group: { _id: { sheet: '$sheetId', status: '$status' }, n: { $sum: 1 } } },
  ]);
  for (const id of ids) {
    const counts = { total: 0, present: 0, absent: 0, late: 0, leave: 0 };
    for (const r of rows.filter((x) => String(x._id.sheet) === id)) {
      counts[r._id.status] = r.n;
      counts.total += r.n;
    }
    await AttendanceSheet.updateOne({ _id: id, schoolId }, { counts });
  }
}

const percentage = (attended, total) => (total ? Math.round((attended / total) * 1000) / 10 : null);

/* ------------------------------ section register ------------------------------ */

/** The attendance sheet of a section for a date (today in the school's timezone by default). */
export async function getSectionSheet(tenant, sectionId, date) {
  const schoolId = tenant.schoolId;
  const { section, displayName } = await loadSection(tenant, sectionId);
  const settings = await attendanceSettings(schoolId);
  const today = todayIn(settings.timezone);
  const day = date || today;
  const session = await getSessionOr404(schoolId, section.sessionId);

  const inSession = day >= session.startDate && day <= session.endDate;
  const info = inSession ? await dayInfo(schoolId, day, section.campusId, settings) : { isWorkingDay: false, reason: 'outside_session', title: null };

  const [enrollments, records, sheet] = await Promise.all([
    Enrollment.find({ schoolId, sectionId: section._id, status: 'active' }).select('studentId rollNo').lean(),
    AttendanceRecord.find({ schoolId, sectionId: section._id, date: day }).lean(),
    AttendanceSheet.findOne({ schoolId, sectionId: section._id, date: day }).populate('markedBy updatedBy', 'name').lean(),
  ]);
  const rollBy = new Map(enrollments.map((e) => [String(e.studentId), e.rollNo]));
  const recordBy = new Map(records.map((r) => [String(r.studentId), r]));
  const studentIds = [...new Set([...rollBy.keys(), ...recordBy.keys()])];
  const [students, leaves] = await Promise.all([
    Student.find({ schoolId, _id: { $in: studentIds } }).select('admissionNo firstName lastName gender photoUrl').lean(),
    approvedLeaves(schoolId, studentIds, day),
  ]);

  const rows = students
    .map((s) => {
      const id = String(s._id);
      const rec = recordBy.get(id);
      return {
        studentId: s._id,
        rollNo: rollBy.get(id) ?? null,
        admissionNo: s.admissionNo,
        name: fullName(s),
        gender: s.gender,
        photoUrl: s.photoUrl ?? null,
        inSection: rollBy.has(id),
        status: rec?.status ?? null,
        remark: rec?.remark ?? null,
        onApprovedLeave: leaves.has(id),
        suggestedStatus: rec ? null : leaves.has(id) ? 'leave' : null,
      };
    })
    .sort((a, b) => (a.rollNo ?? Infinity) - (b.rollNo ?? Infinity) || a.name.localeCompare(b.name));

  let edit = editState(tenant, day, today, settings);
  if (edit.canEdit && session.status === 'closed') edit = { canEdit: false, reason: 'SESSION_CLOSED' };
  if (edit.canEdit && !info.isWorkingDay) edit = { canEdit: false, reason: 'NON_WORKING_DAY' };

  return {
    section: { id: section._id, displayName, campusId: section.campusId, sessionId: section.sessionId },
    date: day,
    today,
    day: info,
    sheet: sheet
      ? { id: sheet._id, counts: sheet.counts, markedAt: sheet.markedAt, markedBy: sheet.markedBy?.name ?? null, updatedAt: sheet.updatedAt, updatedBy: sheet.updatedBy?.name ?? null, submissions: sheet.submissions }
      : null,
    canEdit: edit.canEdit,
    lockedReason: edit.reason,
    students: rows,
  };
}

/**
 * Submits (or re-submits) a section's attendance for a date. Every active student needs a status:
 * from `entries`, else approved leave, else `defaultStatus` ("mark all present").
 * Parent alerts go out only for today's attendance and only for status changes, so re-submitting
 * never repeats an alert.
 */
export async function markSection(tenant, sectionId, { date, entries = [], defaultStatus }, ctx) {
  const schoolId = tenant.schoolId;
  const { section, displayName } = await loadSection(tenant, sectionId);
  if (section.status !== 'active') throw ApiError.badRequest('This section is inactive', { code: 'SECTION_INACTIVE' });
  const session = await getSessionOr404(schoolId, section.sessionId);
  assertSessionOpen(session);
  const settings = await attendanceSettings(schoolId);
  const today = todayIn(settings.timezone);

  if (date < session.startDate || date > session.endDate) throw ApiError.badRequest(`The date is outside academic session ${session.name}`, { code: 'OUTSIDE_SESSION' });
  if (date > today) throw ApiError.badRequest('Attendance cannot be marked for a future date', { code: 'FUTURE_DATE' });
  const edit = editState(tenant, date, today, settings);
  if (!edit.canEdit) {
    throw ApiError.forbidden(`Attendance older than ${settings.teacherEditDays} day(s) can only be changed by an administrator or principal`, { code: 'ATTENDANCE_LOCKED' });
  }
  const info = await dayInfo(schoolId, date, section.campusId, settings);
  if (!info.isWorkingDay) {
    throw ApiError.badRequest(info.title ? `${fmtDate(date)} is a holiday (${info.title})` : `${fmtDate(date)} is a weekly day off`, { code: 'NON_WORKING_DAY', details: info });
  }

  const enrollments = await Enrollment.find({ schoolId, sectionId: section._id, status: 'active' }).select('studentId').lean();
  const roster = enrollments.map((e) => String(e.studentId));
  const rosterSet = new Set(roster);
  const entryBy = new Map(entries.map((e) => [String(e.studentId), e]));
  const outsiders = [...entryBy.keys()].filter((id) => !rosterSet.has(id));
  if (outsiders.length) throw ApiError.badRequest('Some students are not active in this section', { code: 'STUDENT_NOT_IN_SECTION', details: { studentIds: outsiders } });
  if (!roster.length) throw ApiError.badRequest('This section has no active students', { code: 'EMPTY_SECTION' });

  const leaves = await approvedLeaves(schoolId, roster, date);
  const final = [];
  const missing = [];
  for (const id of roster) {
    const status = entryBy.get(id)?.status ?? (leaves.has(id) ? 'leave' : defaultStatus);
    if (!status) missing.push(id);
    else final.push({ studentId: id, status, remark: entryBy.get(id)?.remark, leaveRequestId: status === 'leave' ? leaves.get(id) ?? null : null });
  }
  if (missing.length) throw ApiError.badRequest('Give every student a status, or use defaultStatus', { code: 'ATTENDANCE_INCOMPLETE', details: { missing } });

  const previous = await AttendanceRecord.find({ schoolId, studentId: { $in: roster }, date }).select('studentId status sheetId').lean();
  const prevBy = new Map(previous.map((p) => [String(p.studentId), p]));

  const existed = await AttendanceSheet.exists({ schoolId, sectionId: section._id, date });
  const sheet = await AttendanceSheet.findOneAndUpdate(
    { schoolId, sectionId: section._id, date },
    {
      $setOnInsert: { sessionId: section.sessionId, classId: section.classId, campusId: section.campusId, markedBy: ctx.actorId, markedAt: new Date() },
      $set: { updatedBy: ctx.actorId },
      $inc: { submissions: 1 },
    },
    { upsert: true, returnDocument: 'after' },
  );

  await AttendanceRecord.bulkWrite(
    final.map((f) => ({
      updateOne: {
        filter: { schoolId, studentId: f.studentId, date },
        update: {
          $set: {
            sheetId: sheet._id,
            sessionId: section.sessionId,
            sectionId: section._id,
            classId: section.classId,
            campusId: section.campusId,
            status: f.status,
            remark: f.remark,
            leaveRequestId: f.leaveRequestId,
            markedBy: ctx.actorId,
          },
        },
        upsert: true,
      },
    })),
  );
  // Records moved here from another section's sheet (same-day section change) update that sheet too.
  await recomputeSheetCounts(schoolId, [sheet._id, ...previous.map((p) => p.sheetId)]);

  const changed = final.filter((f) => prevBy.get(f.studentId)?.status !== f.status);
  const noLongerAlertable = changed.filter((f) => ['absent', 'late'].includes(prevBy.get(f.studentId)?.status)).map((f) => f.studentId);
  if (noLongerAlertable.length) {
    await cancelUnsent(schoolId, { type: { $in: ALERT_TYPES }, 'data.studentId': { $in: noLongerAlertable.map(oid) }, 'data.date': date });
  }
  let alertsQueued = 0;
  const alertStatuses = settings.alertOnLate ? ['absent', 'late'] : ['absent'];
  if (settings.absentAlerts && date.getTime() === today.getTime()) {
    const toAlert = changed.filter((f) => alertStatuses.includes(f.status));
    alertsQueued = await queueAttendanceAlerts(schoolId, settings, section, displayName, date, toAlert);
  }

  await recordAudit({
    ...ctx,
    action: existed ? 'attendance.updated' : 'attendance.marked',
    entityType: 'AttendanceSheet',
    entityId: sheet._id,
    metadata: { sectionId: section._id, date: formatDateOnly(date), changed: changed.length, changes: existed ? changed.slice(0, 50).map((c) => ({ studentId: c.studentId, from: prevBy.get(c.studentId)?.status ?? null, to: c.status })) : undefined },
  });

  const result = await getSectionSheet(tenant, section._id, date);
  return { ...result, result: { created: !existed, changed: changed.length, alertsQueued } };
}

/**
 * Creates parent notifications for absent/late students: one per guardian who receives alerts,
 * per channel the school uses for alerts and the guardian can be reached on. Wording comes from
 * the school's templates. Students with no reachable guardian get a failed record so the school
 * can see who was not informed.
 */
async function queueAttendanceAlerts(schoolId, settings, section, displayName, date, items) {
  if (!items.length) return 0;
  const ids = items.map((i) => i.studentId);
  const [students, contacts, render, channels] = await Promise.all([
    Student.find({ schoolId, _id: { $in: ids } }).select('firstName lastName').lean(),
    guardianRecipients(schoolId, ids),
    templateRenderer(schoolId),
    alertChannels(schoolId),
  ]);
  const nameBy = new Map(students.map((s) => [String(s._id), fullName(s)]));
  const ymd = formatDateOnly(date);

  const unreachable = [];
  const items2 = [];
  for (const item of items) {
    const type = `attendance.${item.status}`;
    const { title, body } = render(type, { student: nameBy.get(item.studentId) || 'Your child', class: displayName, date: fmtDate(date), school: settings.schoolName });
    const data = { studentId: item.studentId, sectionId: section._id, date };
    const guardians = contacts.get(item.studentId) || [];
    if (!guardians.length) {
      unreachable.push({ type, channel: 'none', recipient: {}, title, body, data, error: 'NO_GUARDIAN', dedupeKey: `${type}:${item.studentId}:${ymd}:none` });
      continue;
    }
    for (const recipient of guardians) items2.push({ recipient, type, title, body, data, key: `${type}:${item.studentId}:${ymd}:${recipient.guardianId}` });
  }
  return queueNotifications(schoolId, [...unreachable, ...(await buildDeliveries(schoolId, items2, channels))]);
}

/* ------------------------------ dashboards ------------------------------ */

async function sessionForDate(schoolId, day) {
  const current = await AcademicSession.findOne({ schoolId, isCurrent: true }).lean();
  if (current && day >= current.startDate && day <= current.endDate) return current;
  return AcademicSession.findOne({ schoolId, startDate: { $lte: day }, endDate: { $gte: day } }).lean();
}

/** Today's (or a date's) attendance across the sections the caller can see. */
export async function dailySummary(tenant, { date, campusId }) {
  const schoolId = tenant.schoolId;
  const settings = await attendanceSettings(schoolId);
  const today = todayIn(settings.timezone);
  const day = date || today;
  const session = await sessionForDate(schoolId, day);
  const empty = { total: 0, present: 0, absent: 0, late: 0, leave: 0 };
  if (!session) return { date: day, session: null, day: null, totals: { enrolled: 0, sections: 0, markedSections: 0, ...empty, percentage: null }, classes: [], sections: [], unmarked: [], alerts: {} };

  const access = await studentAccess(tenant, { sessionId: session._id });
  const filter = { schoolId, sessionId: session._id, status: 'active' };
  if (campusId) {
    if (access.campusIds && !access.campusIds.includes(String(campusId))) throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
    filter.campusId = campusId;
  } else if (access.campusIds) filter.campusId = { $in: access.campusIds };
  if (access.sectionIds) filter._id = { $in: access.sectionIds };

  const sections = await Section.find(filter).lean();
  const sectionIds = sections.map((s) => s._id);
  const [classes, enrolled, sheets, alertRows, info] = await Promise.all([
    nameMap(SchoolClass, schoolId, sections.map((s) => s.classId), 'name order'),
    Enrollment.aggregate([{ $match: { schoolId: oid(schoolId), sectionId: { $in: sectionIds }, status: 'active' } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]),
    AttendanceSheet.find({ schoolId, date: day, sectionId: { $in: sectionIds } }).lean(),
    Notification.aggregate([
      { $match: { schoolId: oid(schoolId), type: { $in: ALERT_TYPES }, 'data.date': day, 'data.sectionId': { $in: sectionIds } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    dayInfo(schoolId, day, campusId || null, settings),
  ]);
  const enrolledBy = new Map(enrolled.map((e) => [String(e._id), e.n]));
  const sheetBy = new Map(sheets.map((s) => [String(s.sectionId), s]));

  const rows = sections
    .map((s) => {
      const c = classes.get(idStr(s.classId));
      const sheet = sheetBy.get(String(s._id));
      return {
        sectionId: s._id,
        classId: s.classId,
        displayName: `${c?.name ?? ''} - ${s.name}`,
        classOrder: c?.order ?? 9999,
        campusId: s.campusId,
        enrolled: enrolledBy.get(String(s._id)) || 0,
        marked: Boolean(sheet),
        markedAt: sheet?.markedAt ?? null,
        counts: sheet?.counts ?? null,
        percentage: sheet ? percentage(sheet.counts.present + sheet.counts.late, sheet.counts.total) : null,
      };
    })
    .sort((a, b) => a.classOrder - b.classOrder || a.displayName.localeCompare(b.displayName));

  const totals = { enrolled: 0, sections: rows.length, markedSections: 0, ...empty };
  const byClass = new Map();
  for (const r of rows) {
    totals.enrolled += r.enrolled;
    const cls = byClass.get(String(r.classId)) || { classId: r.classId, name: r.displayName.split(' - ')[0], order: r.classOrder, enrolled: 0, sections: 0, markedSections: 0, ...empty };
    cls.enrolled += r.enrolled;
    cls.sections += 1;
    if (r.marked) {
      totals.markedSections += 1;
      cls.markedSections += 1;
      for (const k of Object.keys(empty)) {
        totals[k] += r.counts[k];
        cls[k] += r.counts[k];
      }
    }
    byClass.set(String(r.classId), cls);
  }
  totals.percentage = percentage(totals.present + totals.late, totals.total);
  const classList = [...byClass.values()].sort((a, b) => a.order - b.order).map((c) => ({ ...c, percentage: percentage(c.present + c.late, c.total) }));

  return {
    date: day,
    session: { id: session._id, name: session.name },
    day: info,
    totals,
    classes: classList,
    sections: rows,
    unmarked: info.isWorkingDay ? rows.filter((r) => !r.marked && r.enrolled > 0).map((r) => ({ sectionId: r.sectionId, displayName: r.displayName })) : [],
    alerts: Object.fromEntries(alertRows.map((a) => [a._id, a.n])),
  };
}

/** A student's attendance over a range (whole session to date by default). Family-safe. */
export async function studentAttendance(tenant, studentId, { sessionId, from, to }) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  const settings = await attendanceSettings(schoolId);
  const today = todayIn(settings.timezone);
  const session = sessionId ? await getSessionOr404(schoolId, sessionId) : await sessionForDate(schoolId, today);
  const start = from || session?.startDate;
  const end = to || (session ? new Date(Math.min(session.endDate, today)) : today);
  if (!start) throw ApiError.badRequest('No current academic session. Pass from and to.', { code: 'NO_CURRENT_SESSION' });
  if (end < start) throw ApiError.validation([{ field: 'query.to', message: 'End date must be on or after the start date' }]);
  if (daysBetween(start, end) > 400) throw ApiError.validation([{ field: 'query.to', message: 'Range can be at most 400 days' }]);

  const records = await AttendanceRecord.find({ schoolId, studentId: student._id, date: { $gte: start, $lte: end } }).select('date status remark sectionId').sort({ date: -1 }).lean();
  const summary = { total: records.length, present: 0, absent: 0, late: 0, leave: 0 };
  for (const r of records) summary[r.status] += 1;
  summary.percentage = percentage(summary.present + summary.late, summary.total);
  return {
    student: { id: student._id, name: fullName(student), admissionNo: student.admissionNo },
    session: session ? { id: session._id, name: session.name } : null,
    from: start,
    to: end,
    summary,
    threshold: settings.lowAttendanceThreshold,
    records: records.map((r) => ({ date: r.date, status: r.status, remark: r.remark ?? null })),
  };
}

/**
 * Students below the attendance threshold in a session. Percentage = (present + late) ÷ days
 * marked, with leave counted as a marked day not attended.
 */
export async function lowAttendance(tenant, { sessionId, threshold, classId, sectionId, minDays, page, limit }) {
  const schoolId = tenant.schoolId;
  const settings = await attendanceSettings(schoolId);
  const session = sessionId ? await getSessionOr404(schoolId, sessionId) : await sessionForDate(schoolId, todayIn(settings.timezone));
  if (!session) throw ApiError.badRequest('No current academic session. Pass sessionId.', { code: 'NO_CURRENT_SESSION' });
  const limitPct = threshold ?? settings.lowAttendanceThreshold;
  const access = await studentAccess(tenant, { sessionId: session._id });

  const match = { schoolId: oid(schoolId), sessionId: session._id };
  if (sectionId) {
    await loadSection(tenant, sectionId);
    match.sectionId = oid(sectionId);
  } else if (access.sectionIds) match.sectionId = { $in: access.sectionIds.map(oid) };
  if (classId) match.classId = oid(classId);
  if (access.campusIds) match.campusId = { $in: access.campusIds.map(oid) };
  if (access.studentIds) match.studentId = { $in: [...access.studentIds].map(oid) };

  const [res] = await AttendanceRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$studentId',
        total: { $sum: 1 },
        attended: { $sum: { $cond: [{ $in: ['$status', ATTENDED] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
        late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
        leave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
      },
    },
    { $match: { total: { $gte: minDays ?? 1 } } },
    { $addFields: { percentage: { $round: [{ $multiply: [{ $divide: ['$attended', '$total'] }, 100] }, 1] } } },
    { $match: { percentage: { $lt: limitPct } } },
    { $facet: { items: [{ $sort: { percentage: 1, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ]);
  const studentIds = res.items.map((r) => r._id);
  const [students, placement, primaryLinks] = await Promise.all([
    Student.find({ schoolId, _id: { $in: studentIds } }).select('admissionNo firstName lastName status').lean(),
    currentPlacement(schoolId, session._id, studentIds),
    StudentGuardian.find({ schoolId, studentId: { $in: studentIds }, isPrimary: true }).lean(),
  ]);
  const guardians = await Guardian.find({ schoolId, _id: { $in: primaryLinks.map((l) => l.guardianId) } }).select('name phone').lean();
  const gBy = new Map(guardians.map((g) => [String(g._id), g]));
  const primaryBy = new Map(primaryLinks.map((l) => [String(l.studentId), gBy.get(String(l.guardianId))]));
  const sBy = new Map(students.map((s) => [String(s._id), s]));
  const total = res.total[0]?.n ?? 0;
  return {
    items: res.items.map((r) => {
      const s = sBy.get(String(r._id));
      const g = primaryBy.get(String(r._id));
      return {
        studentId: r._id,
        name: s ? fullName(s) : null,
        admissionNo: s?.admissionNo ?? null,
        classSection: placement.get(String(r._id))?.displayName ?? null,
        daysMarked: r.total,
        attended: r.attended,
        absent: r.absent,
        late: r.late,
        leave: r.leave,
        percentage: r.percentage,
        primaryGuardian: g ? { name: g.name, phone: g.phone } : null,
      };
    }),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), threshold: limitPct, sessionId: session._id },
  };
}

/** Month grid for a section: students × days with each day's status. */
export async function sectionRegister(tenant, sectionId, month) {
  const schoolId = tenant.schoolId;
  const { section, displayName } = await loadSection(tenant, sectionId);
  const settings = await attendanceSettings(schoolId);
  const from = parseDateOnly(`${month}-01`);
  const to = addDays(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)), -1);

  const [records, enrollments, sheets, holidays] = await Promise.all([
    AttendanceRecord.find({ schoolId, sectionId: section._id, date: { $gte: from, $lte: to } }).select('studentId date status').lean(),
    Enrollment.find({ schoolId, sectionId: section._id, status: 'active' }).select('studentId rollNo').lean(),
    AttendanceSheet.find({ schoolId, sectionId: section._id, date: { $gte: from, $lte: to } }).select('date').lean(),
    nonWorkingDates(schoolId, { from, to, campusId: section.campusId }),
  ]);
  const holidaySet = new Set(holidays);
  const markedSet = new Set(sheets.map((s) => formatDateOnly(s.date)));
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const ymd = formatDateOnly(d);
    days.push({ date: ymd, weekday: weekday(d), isWorkingDay: !settings.weeklyOffDays.includes(weekday(d)) && !holidaySet.has(ymd), marked: markedSet.has(ymd) });
  }
  const rollBy = new Map(enrollments.map((e) => [String(e.studentId), e.rollNo]));
  const ids = [...new Set([...rollBy.keys(), ...records.map((r) => String(r.studentId))])];
  const students = await Student.find({ schoolId, _id: { $in: ids } }).select('admissionNo firstName lastName').lean();
  const rows = students
    .map((s) => {
      const id = String(s._id);
      const mine = records.filter((r) => String(r.studentId) === id);
      const totals = { total: mine.length, present: 0, absent: 0, late: 0, leave: 0 };
      const byDay = {};
      for (const r of mine) {
        byDay[formatDateOnly(r.date)] = r.status;
        totals[r.status] += 1;
      }
      return { studentId: s._id, rollNo: rollBy.get(id) ?? null, admissionNo: s.admissionNo, name: fullName(s), inSection: rollBy.has(id), days: byDay, totals: { ...totals, percentage: percentage(totals.present + totals.late, totals.total) } };
    })
    .sort((a, b) => (a.rollNo ?? Infinity) - (b.rollNo ?? Infinity) || a.name.localeCompare(b.name));
  return { section: { id: section._id, displayName }, month, days, students: rows };
}

/** Parent alerts for attendance on a date, for the sections the caller can see. */
export async function listAlerts(tenant, { date, status, sectionId, page, limit }) {
  const schoolId = tenant.schoolId;
  const settings = await attendanceSettings(schoolId);
  const day = date || todayIn(settings.timezone);
  const filter = { schoolId, type: { $in: ALERT_TYPES }, 'data.date': day };
  if (status) filter.status = status;
  if (sectionId) {
    await loadSection(tenant, sectionId);
    filter['data.sectionId'] = sectionId;
  } else {
    const session = await sessionForDate(schoolId, day);
    const access = await studentAccess(tenant, { sessionId: session?._id });
    if (access.sectionIds || access.campusIds) {
      const sf = { schoolId, ...(session ? { sessionId: session._id } : {}) };
      if (access.sectionIds) sf._id = { $in: access.sectionIds };
      if (access.campusIds) sf.campusId = { $in: access.campusIds };
      filter['data.sectionId'] = { $in: await Section.distinct('_id', sf) };
    }
  }
  const [rows, total] = await Promise.all([
    Notification.find(filter).select('type channel recipient.name recipient.email title status error sentAt data createdAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  const names = await nameMap(Student, schoolId, rows.map((r) => r.data?.studentId), 'firstName lastName admissionNo');
  return {
    items: rows.map((r) => {
      const s = names.get(idStr(r.data?.studentId));
      return { ...r, student: s ? { id: s._id, name: fullName(s), admissionNo: s.admissionNo } : null };
    }),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), date: day },
  };
}
