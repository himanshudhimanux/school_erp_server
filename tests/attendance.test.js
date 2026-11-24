import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, teardownDb, createUser, createSchool, createPlan, addMember, createApp, PASSWORD, Campus } from './helpers.js';

const { AcademicSession, SchoolClass, Section, Subject, ClassSubject, TeachingAssignment } = await import('../src/modules/academics/academics.models.js');
const { Student, Enrollment } = await import('../src/modules/students/student.model.js');
const { Guardian, StudentGuardian } = await import('../src/modules/parents/guardian.model.js');
const { CalendarEvent } = await import('../src/modules/calendar/calendarEvent.model.js');
const { Notification } = await import('../src/modules/notifications/notification.model.js');
const { processEmailQueue, queueNotifications } = await import('../src/modules/notifications/notification.service.js');
const { todayIn, addDays, formatDateOnly, weekday } = await import('../src/utils/dates.js');

let app;
const S = {};
const T = {};
const M = {};
const ids = {};
const today = todayIn('UTC');
const ymd = (d) => formatDateOnly(d);
const TODAY = ymd(today);

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
const api = (method, path, token) => request(app)[method](`/api/v1${path}`).set(bearer(token));
const expectStatus = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));
const mark = (sectionId, token, body) => api('put', `/attendance/sections/${sectionId}`, token).send(body);

before(async () => {
  await setupDb();
  app = createApp();
  S.a = await createSchool('att-a', { timezone: 'UTC', settings: { attendance: { weeklyOffDays: [], teacherEditDays: 1 } } });
  S.b = await createSchool('att-b');
  S.fees = await createSchool('att-fees', { plan: await createPlan('fees-only', { modules: ['fees'] }) });
  const schoolId = S.a._id;
  const campusId = (await Campus.findOne({ schoolId, isMain: true }))._id;

  const session = await AcademicSession.create({ schoolId, name: 'Current', startDate: addDays(today, -200), endDate: addDays(today, 150), status: 'active', isCurrent: true });
  const g1 = await SchoolClass.create({ schoolId, name: 'Grade 1', code: 'G1', order: 1 });
  const [math, eng, sci] = await Subject.create([
    { schoolId, name: 'Maths', code: 'MATH' },
    { schoolId, name: 'English', code: 'ENG' },
    { schoolId, name: 'Science', code: 'SCI' },
  ]);
  await ClassSubject.create([
    { schoolId, sessionId: session._id, classId: g1._id, subjectId: math._id },
    { schoolId, sessionId: session._id, classId: g1._id, subjectId: eng._id },
  ]);
  Object.assign(ids, { session: session._id, g1: g1._id, math: String(math._id), eng: String(eng._id), sci: String(sci._id), campusId });

  const people = {
    admin: ['admin@att-a.test', S.a, ['school_admin']],
    principal: ['principal@att-a.test', S.a, ['principal']],
    teacher: ['teacher@att-a.test', S.a, ['teacher']],
    teacher2: ['teacher2@att-a.test', S.a, ['teacher']],
    other: ['other@att-a.test', S.a, ['teacher']],
    parent: ['parent@att-a.test', S.a, ['parent']],
    ownerB: ['owner@att-b.test', S.b, ['school_owner']],
    ownerFees: ['owner@att-fees.test', S.fees, ['school_owner']],
  };
  for (const [key, [email, school, roles]] of Object.entries(people)) {
    const u = await createUser(email);
    M[key] = String((await addMember(school, u, roles))._id);
    T[key] = await tokenFor(email);
  }

  const secA = await Section.create({ schoolId, sessionId: session._id, classId: g1._id, campusId, name: 'A', classTeacherId: M.teacher });
  const secB = await Section.create({ schoolId, sessionId: session._id, classId: g1._id, campusId, name: 'B' });
  ids.secA = String(secA._id);
  ids.secB = String(secB._id);
  const ta = await TeachingAssignment.create([
    { schoolId, sessionId: session._id, sectionId: secA._id, subjectId: math._id, teacherId: M.teacher },
    { schoolId, sessionId: session._id, sectionId: secA._id, subjectId: eng._id, teacherId: M.teacher2 },
    { schoolId, sessionId: session._id, sectionId: secB._id, subjectId: math._id, teacherId: M.teacher2 },
  ]);
  ids.mathAssignmentA = String(ta[0]._id);

  const mkStudent = async (firstName, sectionId, rollNo) => {
    const s = await Student.create({ schoolId, admissionNo: `S-${firstName.toUpperCase()}`, firstName, lastName: 'Test', gender: 'male', campusId, admissionDate: today });
    await Enrollment.create({ schoolId, studentId: s._id, sessionId: session._id, classId: g1._id, sectionId, campusId, rollNo });
    return String(s._id);
  };
  ids.s1 = await mkStudent('Asha', secA._id, 1); // parent with portal + email
  ids.s2 = await mkStudent('Bala', secA._id, 2); // guardian with email only
  ids.s3 = await mkStudent('Chitra', secA._id, 3); // guardian with no contact channel
  ids.s4 = await mkStudent('Dev', secA._id, 4); // no guardian
  ids.s5 = await mkStudent('Esha', secB._id, 1);

  const g = async (name, extra) => (await Guardian.create({ schoolId, name, phone: '+919800000000', phoneNormalized: '+919800000000', ...extra }))._id;
  const parentGuardian = await g('Parent One', { email: 'parent@att-a.test', membershipId: M.parent });
  const emailGuardian = await g('Parent Two', { email: 'two@family.test' });
  const silentGuardian = await g('Parent Three', {});
  await StudentGuardian.create([
    { schoolId, studentId: ids.s1, guardianId: parentGuardian, relation: 'mother', isPrimary: true },
    { schoolId, studentId: ids.s2, guardianId: emailGuardian, relation: 'father', isPrimary: true },
    { schoolId, studentId: ids.s3, guardianId: silentGuardian, relation: 'father', isPrimary: true },
  ]);
});
after(teardownDb);

describe('attendance marking', () => {
  test('teacher opens the register for their section', async () => {
    const r = await api('get', `/attendance/sections/${ids.secA}`, T.teacher);
    expectStatus(r, 200);
    assert.equal(r.body.data.canEdit, true);
    assert.equal(r.body.data.day.isWorkingDay, true);
    assert.deepEqual(r.body.data.students.map((s) => [s.rollNo, s.status]), [[1, null], [2, null], [3, null], [4, null]]);
  });

  test('only staff of the section can open it', async () => {
    assert.equal((await api('get', `/attendance/sections/${ids.secA}`, T.other)).body.error.code, 'SECTION_ACCESS_DENIED');
    assert.equal((await api('get', `/attendance/sections/${ids.secA}`, T.parent)).body.error.code, 'SECTION_ACCESS_DENIED');
    expectStatus(await api('get', `/attendance/sections/${ids.secA}`, T.ownerB), 404);
  });

  test('validation: incomplete, outsiders, future and out-of-session dates', async () => {
    assert.equal((await mark(ids.secA, T.teacher, { date: TODAY, entries: [{ studentId: ids.s1, status: 'present' }] })).body.error.code, 'ATTENDANCE_INCOMPLETE');
    assert.equal((await mark(ids.secA, T.teacher, { date: TODAY, defaultStatus: 'present', entries: [{ studentId: ids.s5, status: 'absent' }] })).body.error.code, 'STUDENT_NOT_IN_SECTION');
    assert.equal((await mark(ids.secA, T.admin, { date: ymd(addDays(today, 1)), defaultStatus: 'present' })).body.error.code, 'FUTURE_DATE');
    assert.equal((await mark(ids.secA, T.admin, { date: ymd(addDays(today, -300)), defaultStatus: 'present' })).body.error.code, 'OUTSIDE_SESSION');
    expectStatus(await mark(ids.secA, T.teacher, { date: TODAY, defaultStatus: 'here' }), 422);
  });

  test('mark all present with exceptions; parents are alerted once', async () => {
    const r = await mark(ids.secA, T.teacher, {
      date: TODAY,
      defaultStatus: 'present',
      entries: [
        { studentId: ids.s1, status: 'absent' },
        { studentId: ids.s2, status: 'absent' },
        { studentId: ids.s3, status: 'absent', remark: 'No call' },
        { studentId: ids.s4, status: 'late' },
      ],
    });
    expectStatus(r, 200);
    assert.equal(r.body.data.result.created, true);
    assert.deepEqual(r.body.data.sheet.counts, { total: 4, present: 0, absent: 3, late: 1, leave: 0 });
    // s1: portal + email, s2: email, s3: no contact channel. Late does not alert by default.
    assert.equal(r.body.data.result.alertsQueued, 4);

    await processEmailQueue({ schoolId: S.a._id });
    const alerts = await Notification.find({ schoolId: S.a._id }).lean();
    const by = (sid, ch) => alerts.find((a) => String(a.data.studentId) === sid && a.channel === ch);
    assert.equal(by(ids.s1, 'in_app').status, 'sent');
    assert.equal(by(ids.s2, 'email').status, 'failed');
    assert.equal(by(ids.s2, 'email').error, 'EMAIL_NOT_CONFIGURED');
    assert.equal(by(ids.s3, 'none').error, 'NO_CONTACT_CHANNEL');
    assert.equal(alerts.filter((a) => String(a.data.studentId) === ids.s4).length, 0);

    const again = await mark(ids.secA, T.teacher, { date: TODAY, defaultStatus: 'present', entries: [{ studentId: ids.s1, status: 'absent' }, { studentId: ids.s2, status: 'absent' }, { studentId: ids.s3, status: 'absent' }, { studentId: ids.s4, status: 'late' }] });
    assert.equal(again.body.data.result.alertsQueued, 0);
    assert.equal(again.body.data.result.changed, 0);
    assert.equal(again.body.data.sheet.submissions, 2);
    assert.equal(await Notification.countDocuments({ schoolId: S.a._id }), 4);
  });

  test('correcting an absence cancels alerts that have not gone out', async () => {
    await Notification.updateMany({ schoolId: S.a._id, 'data.studentId': ids.s2, channel: 'email' }, { status: 'queued', attempts: 0 });
    const r = await mark(ids.secA, T.teacher, { date: TODAY, defaultStatus: 'present', entries: [{ studentId: ids.s1, status: 'absent' }, { studentId: ids.s3, status: 'absent' }, { studentId: ids.s4, status: 'late' }] });
    expectStatus(r, 200);
    assert.equal(r.body.data.result.changed, 1);
    const n = await Notification.findOne({ schoolId: S.a._id, 'data.studentId': ids.s2, channel: 'email' }).lean();
    assert.equal(n.status, 'cancelled');
  });

  test('duplicate notifications are skipped, new ones still inserted', async () => {
    const doc = (key) => ({ type: 'test.event', channel: 'none', recipient: {}, title: 't', body: 'b', data: {}, error: 'X', dedupeKey: key });
    assert.equal(await queueNotifications(S.a._id, [doc('dup-1')]), 1);
    assert.equal(await queueNotifications(S.a._id, [doc('dup-1'), doc('dup-2')]), 1);
    await Notification.deleteMany({ schoolId: S.a._id, type: 'test.event' });
  });

  test('parent sees the alert in their inbox', async () => {
    const inbox = await api('get', '/portal/notifications', T.parent);
    expectStatus(inbox, 200);
    assert.equal(inbox.body.data.length, 1);
    assert.match(inbox.body.data[0].title, /Asha Test was marked absent/);
    assert.equal(inbox.body.meta.unread, 1);
    expectStatus(await api('post', `/portal/notifications/${inbox.body.data[0]._id}/read`, T.parent), 200);
    assert.equal((await api('get', '/portal/notifications', T.parent)).body.meta.unread, 0);
    expectStatus(await api('post', `/portal/notifications/${inbox.body.data[0]._id}/read`, T.teacher), 404);
  });

  test('daily summary for admins and teachers', async () => {
    const r = await api('get', '/attendance/daily', T.admin);
    expectStatus(r, 200);
    const t = r.body.data.totals;
    assert.deepEqual([t.enrolled, t.sections, t.markedSections, t.present, t.absent, t.late], [5, 2, 1, 1, 2, 1]);
    assert.equal(t.percentage, 50);
    assert.deepEqual(r.body.data.unmarked.map((u) => u.displayName), ['Grade 1 - B']);
    assert.equal(r.body.data.classes[0].name, 'Grade 1');
    assert.ok(r.body.data.alerts.sent >= 1);

    const mine = await api('get', '/attendance/daily', T.teacher);
    assert.deepEqual(mine.body.data.sections.map((s) => s.displayName), ['Grade 1 - A']);
    expectStatus(await api('get', '/attendance/daily', T.parent), 403);
  });

  test('teachers can only edit recent days; admins can backfill without alerts', async () => {
    const old = ymd(addDays(today, -3));
    assert.equal((await mark(ids.secA, T.teacher, { date: old, defaultStatus: 'present' })).body.error.code, 'ATTENDANCE_LOCKED');
    const sheet = await api('get', `/attendance/sections/${ids.secA}?date=${old}`, T.teacher);
    assert.equal(sheet.body.data.canEdit, false);
    assert.equal(sheet.body.data.lockedReason, 'ATTENDANCE_LOCKED');
    const r = await mark(ids.secA, T.admin, { date: old, defaultStatus: 'present', entries: [{ studentId: ids.s3, status: 'absent' }] });
    expectStatus(r, 200);
    assert.equal(r.body.data.result.alertsQueued, 0, 'no alerts for past dates');
    expectStatus(await mark(ids.secA, T.teacher, { date: ymd(addDays(today, -1)), defaultStatus: 'present', entries: [{ studentId: ids.s3, status: 'absent' }] }), 200);
  });

  test('holidays and weekly days off cannot be marked', async () => {
    const holiday = addDays(today, -5);
    await CalendarEvent.create({ schoolId: S.a._id, sessionId: ids.session, title: 'Founders Day', type: 'holiday', startDate: holiday, endDate: holiday });
    const r = await mark(ids.secA, T.admin, { date: ymd(holiday), defaultStatus: 'present' });
    assert.equal(r.body.error.code, 'NON_WORKING_DAY');
    assert.equal(r.body.error.details.title, 'Founders Day');
    const sheet = await api('get', `/attendance/sections/${ids.secA}?date=${ymd(holiday)}`, T.admin);
    assert.equal(sheet.body.data.day.isWorkingDay, false);

    const off = addDays(today, -6);
    expectStatus(await api('patch', '/school/settings', T.admin).send({ attendance: { weeklyOffDays: [weekday(off)] } }), 200);
    assert.equal((await mark(ids.secA, T.admin, { date: ymd(off), defaultStatus: 'present' })).body.error.details.reason, 'weekly_off');
    await api('patch', '/school/settings', T.admin).send({ attendance: { weeklyOffDays: [] } });
  });
});

describe('leave requests', () => {
  test('parent requests leave; the class teacher approves and absences become leave', async () => {
    const req1 = await api('post', '/portal/leave-requests', T.parent).send({ studentId: ids.s1, fromDate: TODAY, toDate: ymd(addDays(today, 1)), reason: 'Fever' });
    expectStatus(req1, 201);
    assert.equal(req1.body.data.status, 'pending');
    ids.leave1 = req1.body.data._id;
    expectStatus(await api('post', '/portal/leave-requests', T.parent).send({ studentId: ids.s2, fromDate: TODAY, toDate: TODAY, reason: 'Not my child' }), 404);
    assert.equal((await api('post', '/portal/leave-requests', T.parent).send({ studentId: ids.s1, fromDate: TODAY, toDate: TODAY, reason: 'Again' })).body.error.code, 'LEAVE_OVERLAP');
    assert.equal((await api('post', '/portal/leave-requests', T.parent).send({ studentId: ids.s1, fromDate: ymd(addDays(today, -9)), toDate: ymd(addDays(today, -8)), reason: 'Past' })).body.error.code, 'PAST_LEAVE');

    const list = await api('get', '/attendance/leave-requests?status=pending', T.teacher);
    assert.deepEqual(list.body.data.map((l) => l.student.name), ['Asha Test']);
    assert.equal((await api('get', '/attendance/leave-requests', T.other)).body.meta.total, 0);
    expectStatus(await api('post', `/attendance/leave-requests/${ids.leave1}/review`, T.other).send({ status: 'approved' }), 404);

    const ok = await api('post', `/attendance/leave-requests/${ids.leave1}/review`, T.teacher).send({ status: 'approved', note: 'Get well soon' });
    expectStatus(ok, 200);
    assert.equal(ok.body.data.recordsConverted, 1);
    const sheet = await api('get', `/attendance/sections/${ids.secA}`, T.teacher);
    assert.equal(sheet.body.data.sheet.counts.leave, 1);
    assert.equal(sheet.body.data.students.find((s) => s.studentId === ids.s1).status, 'leave');
    assert.equal((await api('post', `/attendance/leave-requests/${ids.leave1}/review`, T.teacher).send({ status: 'rejected' })).body.error.code, 'LEAVE_NOT_PENDING');
    assert.equal((await api('post', `/portal/leave-requests/${ids.leave1}/cancel`, T.parent)).body.error.code, 'LEAVE_STARTED');

    const mine = await api('get', '/portal/leave-requests', T.parent);
    assert.deepEqual(mine.body.data.map((l) => l.status), ['approved']);
  });

  test('staff-entered leave is approved and pre-fills the register', async () => {
    const r = await api('post', '/attendance/leave-requests', T.teacher2).send({ studentId: ids.s5, fromDate: TODAY, toDate: TODAY, reason: 'Family function' });
    expectStatus(r, 201);
    assert.equal(r.body.data.status, 'approved');
    const sheet = await api('get', `/attendance/sections/${ids.secB}`, T.teacher2);
    assert.equal(sheet.body.data.students[0].suggestedStatus, 'leave');
    const m = await mark(ids.secB, T.teacher2, { date: TODAY, defaultStatus: 'present' });
    assert.deepEqual(m.body.data.sheet.counts, { total: 1, present: 0, absent: 0, late: 0, leave: 1 });
  });
});

describe('attendance reports', () => {
  test('student attendance for staff and family', async () => {
    const r = await api('get', `/attendance/students/${ids.s3}`, T.admin);
    expectStatus(r, 200);
    assert.deepEqual([r.body.data.summary.total, r.body.data.summary.absent, r.body.data.summary.percentage], [3, 3, 0]);
    const mine = await api('get', '/portal/attendance', T.parent);
    expectStatus(mine, 200);
    assert.equal(mine.body.data.student.name, 'Asha Test');
    expectStatus(await api('get', `/portal/attendance?studentId=${ids.s2}`, T.parent), 404);
    expectStatus(await api('get', `/attendance/students/${ids.s2}`, T.parent), 404);
  });

  test('low attendance list', async () => {
    const r = await api('get', '/attendance/reports/low', T.admin);
    expectStatus(r, 200);
    const names = r.body.data.map((x) => x.name);
    assert.equal(names[0], 'Chitra Test');
    assert.ok(!names.includes('Bala Test'));
    assert.equal(r.body.meta.threshold, 75);
    assert.equal(r.body.data[0].primaryGuardian.name, 'Parent Three');
  });

  test('monthly register', async () => {
    const month = TODAY.slice(0, 7);
    const r = await api('get', `/attendance/sections/${ids.secA}/register?month=${month}`, T.teacher);
    expectStatus(r, 200);
    const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
    assert.equal(r.body.data.days.length, daysInMonth);
    assert.equal(r.body.data.students.find((s) => s.studentId === ids.s1).days[TODAY], 'leave');
  });

  test('alert log shows who could not be reached', async () => {
    const r = await api('get', '/attendance/alerts?status=failed', T.admin);
    expectStatus(r, 200);
    assert.ok(r.body.data.some((a) => a.error === 'NO_CONTACT_CHANNEL' && a.student.name === 'Chitra Test'));
  });

  test('students and sections with attendance cannot be deleted', async () => {
    assert.equal((await api('delete', `/students/${ids.s4}`, T.admin)).body.error.code, 'STUDENT_IN_USE');
    assert.equal((await api('delete', `/academics/sections/${ids.secA}`, T.admin)).body.error.code, 'SECTION_IN_USE');
  });

  test('attendance and timetable need their plan modules', async () => {
    assert.equal((await api('get', '/attendance/daily', T.ownerFees)).body.error.code, 'MODULE_NOT_ENABLED');
    assert.equal((await api('get', '/timetable/bell-schedules', T.ownerFees)).body.error.code, 'MODULE_NOT_ENABLED');
  });
});

describe('timetable', () => {
  const periods = [
    { number: 1, startTime: '08:00', endTime: '08:40' },
    { number: 2, startTime: '08:40', endTime: '09:20' },
    { number: 3, label: 'Break', startTime: '09:20', endTime: '09:40', isBreak: true },
    { number: 4, startTime: '09:40', endTime: '10:20' },
  ];

  test('bell schedule is required and validated', async () => {
    assert.equal((await api('put', `/timetable/sections/${ids.secA}`, T.admin).send({ entries: [] })).body.error.code, 'NO_BELL_SCHEDULE');
    expectStatus(await api('post', '/timetable/bell-schedules', T.admin).send({ sessionId: String(ids.session), name: 'Bad', periods: [{ number: 1, startTime: '08:00', endTime: '08:45' }, { number: 2, startTime: '08:30', endTime: '09:00' }] }), 422);
    expectStatus(await api('post', '/timetable/bell-schedules', T.teacher).send({ sessionId: String(ids.session), name: 'Regular', periods }), 403);
    const r = await api('post', '/timetable/bell-schedules', T.admin).send({ sessionId: String(ids.session), name: 'Regular', workingDays: [1, 2, 3, 4, 5], periods });
    expectStatus(r, 201);
    ids.schedule = r.body.data._id;
    assert.equal((await api('post', '/timetable/bell-schedules', T.admin).send({ sessionId: String(ids.session), name: 'Dup', periods })).body.error.code, 'SCHEDULE_EXISTS');
  });

  test('section timetable rules', async () => {
    const put = (entries, sec = ids.secA) => api('put', `/timetable/sections/${sec}`, T.admin).send({ entries });
    assert.equal((await put([{ day: 1, periodNumber: 3, subjectId: ids.math }])).body.error.code, 'INVALID_PERIOD');
    assert.equal((await put([{ day: 0, periodNumber: 1, subjectId: ids.math }])).body.error.code, 'INVALID_DAY');
    assert.equal((await put([{ day: 1, periodNumber: 1, subjectId: ids.sci }])).body.error.code, 'SUBJECT_NOT_IN_CLASS');
    assert.equal((await put([{ day: 1, periodNumber: 1, subjectId: ids.math, teacherId: M.other }])).body.error.code, 'TEACHER_NOT_ASSIGNED');
    expectStatus(await put([{ day: 1, periodNumber: 1, subjectId: ids.math }, { day: 1, periodNumber: 1, subjectId: ids.eng }]), 422);

    const r = await put([
      { day: 1, periodNumber: 1, subjectId: ids.math, teacherId: M.teacher, room: '101' },
      { day: 1, periodNumber: 2, subjectId: ids.eng, teacherId: M.teacher2 },
      { day: 2, periodNumber: 1, subjectId: ids.math },
    ]);
    expectStatus(r, 200);
    assert.equal(r.body.data.entries.length, 3);
    assert.equal(r.body.data.entries[0].teacher.name, 'teacher');

    const clash = await put([{ day: 1, periodNumber: 2, subjectId: ids.math, teacherId: M.teacher2 }], ids.secB);
    assert.equal(clash.body.error.code, 'TEACHER_CLASH');
    assert.equal(clash.body.error.details.clashes[0].section.displayName, 'Grade 1 - A');
    expectStatus(await put([{ day: 1, periodNumber: 1, subjectId: ids.math, teacherId: M.teacher2 }], ids.secB), 200);
  });

  test('teacher and family views', async () => {
    const my = await api('get', '/timetable/my', T.teacher2);
    expectStatus(my, 200);
    assert.deepEqual(my.body.data.entries.map((e) => [e.section.displayName, e.periodNumber, e.period.startTime]), [['Grade 1 - B', 1, '08:00'], ['Grade 1 - A', 2, '08:40']]);
    assert.equal((await api('get', '/timetable/my?day=2', T.teacher2)).body.data.entries.length, 0);
    expectStatus(await api('get', '/timetable/my?day=today', T.teacher2), 200);
    expectStatus(await api('get', `/timetable/teachers/${M.teacher2}`, T.teacher), 403);
    expectStatus(await api('get', `/timetable/teachers/${M.teacher2}`, T.admin), 200);
    expectStatus(await api('get', `/timetable/sections/${ids.secA}`, T.teacher), 200);

    const child = await api('get', '/portal/timetable', T.parent);
    expectStatus(child, 200);
    assert.equal(child.body.data.entries.length, 3);
    assert.equal(child.body.data.schedule.periods.length, 4);
  });

  test('schedule changes that would orphan periods are refused', async () => {
    const p = (await api('patch', `/timetable/bell-schedules/${ids.schedule}`, T.admin).send({ periods: periods.filter((x) => x.number !== 2) })).body;
    assert.equal(p.error.code, 'PERIOD_IN_USE');
    assert.equal((await api('patch', `/timetable/bell-schedules/${ids.schedule}`, T.admin).send({ workingDays: [1, 3, 4, 5] })).body.error.code, 'DAY_IN_USE');
    expectStatus(await api('patch', `/timetable/bell-schedules/${ids.schedule}`, T.admin).send({ name: 'Regular Day' }), 200);
    assert.equal((await api('delete', `/timetable/bell-schedules/${ids.schedule}`, T.admin)).body.error.code, 'SCHEDULE_IN_USE');
  });

  test('curriculum and assignment changes keep timetables consistent', async () => {
    assert.equal((await api('delete', `/academics/teaching-assignments/${ids.mathAssignmentA}`, T.admin)).body.error.code, 'TEACHING_ASSIGNMENT_IN_USE');
    const r = await api('put', '/academics/class-subjects', T.admin).send({ sessionId: String(ids.session), classId: String(ids.g1), subjects: [{ subjectId: ids.math }] });
    expectStatus(r, 200);
    const tt = await api('get', `/timetable/sections/${ids.secA}`, T.admin);
    assert.deepEqual(tt.body.data.entries.map((e) => e.subject.code), ['MATH', 'MATH']);
    assert.equal((await api('delete', `/members/${M.teacher}`, T.admin)).body.error.code, 'MEMBER_IN_USE');
  });
});
