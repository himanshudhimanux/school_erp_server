import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, teardownDb, createUser, createSchool, addMember, createApp, PASSWORD, Campus } from './helpers.js';

const { AcademicSession, SchoolClass, Section, Subject, ClassSubject, TeachingAssignment } = await import('../src/modules/academics/academics.models.js');
const { Student, Enrollment } = await import('../src/modules/students/student.model.js');
const { Guardian, StudentGuardian } = await import('../src/modules/parents/guardian.model.js');
const { Notification } = await import('../src/modules/notifications/notification.model.js');
const { normalizeBands, gradeFor, computeResult, assignRanks, combineResults } = await import('../src/modules/exams/grading.js');
const { todayIn, addDays, formatDateOnly } = await import('../src/utils/dates.js');

let app;
const S = {};
const T = {};
const M = {};
const ids = {};
const today = todayIn('UTC');
const ymd = (d) => formatDateOnly(d);
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
const api = (method, path, token) => request(app)[method](`/api/v1${path}`).set(bearer(token));
const expectStatus = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));

const BANDS = [
  { grade: 'A1', minPercent: 90, gradePoint: 10 },
  { grade: 'A2', minPercent: 80, gradePoint: 9 },
  { grade: 'B', minPercent: 60, gradePoint: 7 },
  { grade: 'C', minPercent: 40, gradePoint: 5 },
  { grade: 'D', minPercent: 33, gradePoint: 4 },
  { grade: 'E', minPercent: 0, gradePoint: 0 },
];

describe('grading calculations', () => {
  test('bands are validated and sorted', () => {
    assert.deepEqual(normalizeBands([{ grade: 'A', minPercent: 50 }]).errors, ['The lowest band must start at 0%']);
    assert.ok(normalizeBands([{ grade: 'A', minPercent: 0 }, { grade: 'a', minPercent: 50 }]).errors.includes('Grades must be unique'));
    const { bands } = normalizeBands([...BANDS].reverse());
    assert.equal(bands[0].grade, 'A1');
    assert.equal(gradeFor(bands, 89.99).grade, 'A2');
    assert.equal(gradeFor(bands, 0).grade, 'E');
  });

  test('absent counts as zero, exempt is excluded, missing makes it incomplete', () => {
    const papers = [
      { _id: 'p1', subjectId: 's1', maxMarks: 100, passMarks: 33, subject: { name: 'Maths' } },
      { _id: 'p2', subjectId: 's2', maxMarks: 50, passMarks: 17, subject: { name: 'English' } },
    ];
    const r = computeResult(papers, new Map([['p1', { status: 'present', marks: 90 }], ['p2', { status: 'exempt' }]]), BANDS);
    assert.deepEqual([r.total, r.maxTotal, r.percentage, r.grade, r.result], [90, 100, 90, 'A1', 'pass']);
    const a = computeResult(papers, new Map([['p1', { status: 'absent' }], ['p2', { status: 'present', marks: 50 }]]), BANDS);
    assert.deepEqual([a.total, a.maxTotal, a.result, a.subjects[0].passed], [50, 150, 'fail', false]);
    assert.equal(computeResult(papers, new Map([['p1', { status: 'present', marks: 90 }]]), BANDS).result, 'incomplete');
  });

  test('competition ranking and weighted session results', () => {
    const rows = [{ percentage: 80, result: 'pass' }, { percentage: 90, result: 'pass' }, { percentage: 80, result: 'fail' }, { percentage: null, result: 'incomplete' }, { percentage: 70, result: 'pass' }];
    assignRanks(rows, 'rank');
    assert.deepEqual(rows.map((r) => r.rank), [2, 1, 2, null, 4]);
    const c = combineResults(
      [
        { exam: { _id: 'e1', name: 'Half', weightage: 40 }, result: { percentage: 90, subjects: [{ subjectId: 'm', percentage: 90 }] } },
        { exam: { _id: 'e2', name: 'Final', weightage: 60 }, result: { percentage: 80, subjects: [{ subjectId: 'm', percentage: 80 }] } },
      ],
      BANDS,
    );
    assert.deepEqual([c.percentage, c.grade, c.subjects[0].percentage], [84, 'A2', 84]);
  });
});

before(async () => {
  await setupDb();
  app = createApp();
  S.a = await createSchool('exam-a', { timezone: 'UTC' });
  S.b = await createSchool('exam-b');
  const schoolId = S.a._id;
  const campusId = (await Campus.findOne({ schoolId, isMain: true }))._id;
  const session = await AcademicSession.create({ schoolId, name: 'Current', startDate: addDays(today, -100), endDate: addDays(today, 200), status: 'active', isCurrent: true });
  const [g1, g2] = await SchoolClass.create([
    { schoolId, name: 'Grade 1', code: 'G1', order: 1 },
    { schoolId, name: 'Grade 2', code: 'G2', order: 2 },
  ]);
  const [math, eng, sci] = await Subject.create([
    { schoolId, name: 'Maths', code: 'MATH' },
    { schoolId, name: 'English', code: 'ENG' },
    { schoolId, name: 'Science', code: 'SCI' },
  ]);
  await ClassSubject.create([
    { schoolId, sessionId: session._id, classId: g1._id, subjectId: math._id },
    { schoolId, sessionId: session._id, classId: g1._id, subjectId: eng._id },
    { schoolId, sessionId: session._id, classId: g2._id, subjectId: math._id },
  ]);
  Object.assign(ids, { session: String(session._id), g1: String(g1._id), g2: String(g2._id), math: String(math._id), eng: String(eng._id), sci: String(sci._id) });

  const people = {
    admin: ['admin@exam-a.test', S.a, ['school_admin']],
    principal: ['principal@exam-a.test', S.a, ['principal']],
    teacher: ['teacher@exam-a.test', S.a, ['teacher']],
    teacher2: ['teacher2@exam-a.test', S.a, ['teacher']],
    parent: ['parent@exam-a.test', S.a, ['parent']],
    student: ['student@exam-a.test', S.a, ['student']],
    ownerB: ['owner@exam-b.test', S.b, ['school_owner']],
  };
  for (const [key, [email, school, roles]] of Object.entries(people)) {
    const u = await createUser(email);
    M[key] = String((await addMember(school, u, roles))._id);
    T[key] = await tokenFor(email);
  }
  const [a, b, g2a] = await Section.create([
    { schoolId, sessionId: session._id, classId: g1._id, campusId, name: 'A', classTeacherId: M.teacher },
    { schoolId, sessionId: session._id, classId: g1._id, campusId, name: 'B' },
    { schoolId, sessionId: session._id, classId: g2._id, campusId, name: 'A' },
  ]);
  Object.assign(ids, { secA: String(a._id), secB: String(b._id), secG2: String(g2a._id) });
  await TeachingAssignment.create([
    { schoolId, sessionId: session._id, sectionId: a._id, subjectId: math._id, teacherId: M.teacher },
    { schoolId, sessionId: session._id, sectionId: a._id, subjectId: eng._id, teacherId: M.teacher2 },
    { schoolId, sessionId: session._id, sectionId: b._id, subjectId: eng._id, teacherId: M.teacher2 },
  ]);
  const mk = async (firstName, sec, cls, extra = {}) => {
    const s = await Student.create({ schoolId, admissionNo: `E-${firstName.toUpperCase()}`, firstName, lastName: 'Rao', gender: 'male', campusId, admissionDate: today, ...extra });
    await Enrollment.create({ schoolId, studentId: s._id, sessionId: session._id, classId: cls, sectionId: sec, campusId });
    return String(s._id);
  };
  ids.s1 = await mk('Arun', a._id, g1._id);
  ids.s2 = await mk('Bhanu', a._id, g1._id, { membershipId: M.student });
  ids.s3 = await mk('Chetan', a._id, g1._id);
  ids.s4 = await mk('Deepak', b._id, g1._id);
  ids.s5 = await mk('Eshan', g2a._id, g2._id);
  const guardian = await Guardian.create({ schoolId, name: 'Parent Arun', phone: '+919822222222', phoneNormalized: '+919822222222', membershipId: M.parent });
  await StudentGuardian.create({ schoolId, studentId: ids.s1, guardianId: guardian._id, relation: 'father', isPrimary: true });
});
after(teardownDb);

describe('grading scales and exams', () => {
  test('grading scale', async () => {
    expectStatus(await api('post', '/exams/grading-scales', T.admin).send({ name: 'Bad', bands: [{ grade: 'A', minPercent: 50 }] }), 422);
    expectStatus(await api('post', '/exams/grading-scales', T.teacher).send({ name: 'CBSE', bands: BANDS }), 403);
    const r = await api('post', '/exams/grading-scales', T.admin).send({ name: 'CBSE', bands: [...BANDS].reverse() });
    expectStatus(r, 201);
    assert.equal(r.body.data.isDefault, true, 'first scale becomes the default');
    assert.equal(r.body.data.bands[0].grade, 'A1');
    ids.scale = r.body.data._id;
  });

  test('create exam', async () => {
    const body = { sessionId: ids.session, name: 'Half Yearly', type: 'term', classIds: [ids.g1, ids.g2], startDate: ymd(addDays(today, -10)), endDate: ymd(addDays(today, -5)), weightage: 40 };
    assert.equal((await api('post', '/exams', T.admin).send({ ...body, endDate: ymd(addDays(today, 300)) })).body.error.code, 'OUTSIDE_SESSION');
    const r = await api('post', '/exams', T.principal).send(body);
    expectStatus(r, 201);
    ids.exam = r.body.data._id;
    assert.deepEqual(r.body.data.classes.map((c) => c.name), ['Grade 1', 'Grade 2']);
    assert.equal((await api('post', '/exams', T.admin).send(body)).body.error.code, 'NAME_TAKEN');
    assert.equal((await api('get', '/exams', T.parent)).body.error.code, 'STAFF_ONLY');
    expectStatus(await api('get', `/exams/${ids.exam}`, T.ownerB), 404);
  });

  test('paper schedule rules', async () => {
    const d1 = ymd(addDays(today, -9));
    const put = (classId, papers) => api('put', `/exams/${ids.exam}/papers`, T.admin).send({ classId, papers });
    const math = { subjectId: ids.math, date: d1, startTime: '09:00', endTime: '12:00', maxMarks: 100, passMarks: 33 };
    const eng = { subjectId: ids.eng, date: d1, startTime: '13:00', endTime: '15:00', maxMarks: 50, passMarks: 17 };
    assert.equal((await put(ids.g1, [math, { ...eng, subjectId: ids.sci }])).body.error.code, 'SUBJECT_NOT_IN_CLASS');
    assert.equal((await put(ids.g1, [math, { ...eng, startTime: '11:00' }])).body.error.code, 'PAPER_CLASH');
    assert.equal((await put(ids.g1, [{ ...math, date: ymd(today) }])).body.error.code, 'OUTSIDE_EXAM_DATES');
    expectStatus(await put(ids.g1, [{ ...math, passMarks: 101 }]), 422);
    const r = await put(ids.g1, [math, eng]);
    expectStatus(r, 200);
    assert.deepEqual(r.body.data.map((p) => p.subject.code), ['MATH', 'ENG']);
    expectStatus(await put(ids.g2, [math]), 200);
    const exam = await api('get', `/exams/${ids.exam}`, T.teacher);
    ids.mathG1 = exam.body.data.papers.find((p) => p.classId === ids.g1 && p.subject.code === 'MATH')._id;
    ids.engG1 = exam.body.data.papers.find((p) => p.classId === ids.g1 && p.subject.code === 'ENG')._id;
    ids.mathG2 = exam.body.data.papers.find((p) => p.classId === ids.g2)._id;
  });
});

describe('marks entry', () => {
  const marksUrl = (paper) => `/exams/${ids.exam}/papers/${paper}/marks`;

  test('subject teachers enter marks only for their subject and sections', async () => {
    const r = await api('get', `${marksUrl(ids.mathG1)}?sectionId=${ids.secA}`, T.teacher);
    expectStatus(r, 200);
    assert.equal(r.body.data.canEdit, true);
    assert.equal(r.body.data.students.length, 3);
    const eng = await api('get', `${marksUrl(ids.engG1)}?sectionId=${ids.secA}`, T.teacher);
    assert.deepEqual([eng.body.data.canEdit, eng.body.data.lockedReason], [false, 'NOT_SUBJECT_TEACHER']);
    assert.equal((await api('put', marksUrl(ids.engG1), T.teacher).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, marks: 40 }] })).body.error.code, 'NOT_SUBJECT_TEACHER');
    assert.equal((await api('get', `${marksUrl(ids.mathG1)}?sectionId=${ids.secB}`, T.teacher)).body.error.code, 'SECTION_ACCESS_DENIED');
    assert.equal((await api('get', `${marksUrl(ids.mathG2)}?sectionId=${ids.secA}`, T.admin)).body.error.code, 'SECTION_MISMATCH');
  });

  test('validation', async () => {
    const put = (entries) => api('put', marksUrl(ids.mathG1), T.teacher).send({ sectionId: ids.secA, entries });
    expectStatus(await put([{ studentId: ids.s1, marks: 101 }]), 422);
    expectStatus(await put([{ studentId: ids.s1 }]), 422);
    expectStatus(await put([{ studentId: ids.s1, marks: 10, status: 'absent' }]), 422);
    expectStatus(await put([{ studentId: ids.s1, marks: 2.555 }]), 422);
    assert.equal((await put([{ studentId: ids.s4, marks: 10 }])).body.error.code, 'STUDENT_NOT_IN_SECTION');
  });

  test('bulk entry and corrections', async () => {
    const r = await api('put', marksUrl(ids.mathG1), T.teacher).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, marks: 95 }, { studentId: ids.s2, marks: 30 }, { studentId: ids.s3, status: 'absent' }] });
    expectStatus(r, 200);
    assert.equal(r.body.data.entered, 3);
    expectStatus(await api('put', marksUrl(ids.engG1), T.teacher2).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, marks: 45 }, { studentId: ids.s2, marks: 40 }, { studentId: ids.s3, status: 'exempt' }] }), 200);
    expectStatus(await api('put', marksUrl(ids.engG1), T.teacher2).send({ sectionId: ids.secB, entries: [{ studentId: ids.s4, marks: 20 }] }), 200);
    // A correction is saved (and audited).
    const fix = await api('put', marksUrl(ids.engG1), T.teacher2).send({ sectionId: ids.secB, entries: [{ studentId: ids.s4, marks: 20.5 }] });
    assert.equal(fix.body.data.students[0].marks, 20.5);
  });

  test('progress and locking', async () => {
    const p = await api('get', `/exams/${ids.exam}/progress`, T.admin);
    const by = Object.fromEntries(p.body.data.sections.map((s) => [s.displayName, s.complete]));
    assert.deepEqual(by, { 'Grade 1 - A': true, 'Grade 1 - B': false, 'Grade 2 - A': false });
    const mine = await api('get', `/exams/${ids.exam}/progress`, T.teacher);
    assert.deepEqual(mine.body.data.sections.map((s) => s.displayName), ['Grade 1 - A']);

    expectStatus(await api('post', `/exams/${ids.exam}/lock`, T.admin), 200);
    assert.equal((await api('put', marksUrl(ids.mathG1), T.teacher).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, marks: 96 }] })).body.error.code, 'MARKS_LOCKED');
    expectStatus(await api('put', marksUrl(ids.mathG1), T.admin).send({ sectionId: ids.secB, entries: [{ studentId: ids.s4, marks: 50 }] }), 200);
    expectStatus(await api('post', `/exams/${ids.exam}/unlock`, T.admin), 200);
  });
});

describe('results and publication', () => {
  test('live preview with grades and ranks', async () => {
    const r = await api('get', `/exams/${ids.exam}/results?sectionId=${ids.secA}`, T.teacher);
    expectStatus(r, 200);
    assert.equal(r.body.data.preview, true);
    const rows = Object.fromEntries(r.body.data.results.map((x) => [x.student.name, x]));
    assert.deepEqual([rows['Arun Rao'].total, rows['Arun Rao'].percentage, rows['Arun Rao'].grade, rows['Arun Rao'].result, rows['Arun Rao'].rankInSection], [140, 93.33, 'A1', 'pass', 1]);
    assert.deepEqual([rows['Bhanu Rao'].percentage, rows['Bhanu Rao'].grade, rows['Bhanu Rao'].result], [46.67, 'C', 'fail']);
    assert.deepEqual([rows['Chetan Rao'].total, rows['Chetan Rao'].maxTotal, rows['Chetan Rao'].result], [0, 100, 'fail']);
    // Class rank across sections: Deepak (70.5/150 = 47%) ranks above Bhanu (46.67%).
    assert.deepEqual([rows['Arun Rao'].rankInClass, rows['Bhanu Rao'].rankInClass, rows['Chetan Rao'].rankInClass], [1, 3, 4]);
    assert.deepEqual(r.body.data.summary, { students: 3, pass: 1, fail: 2, incomplete: 0, average: 46.67 });
  });

  test('class teacher remarks', async () => {
    expectStatus(await api('put', `/exams/${ids.exam}/remarks`, T.teacher).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, remark: 'Excellent work' }] }), 200);
    assert.equal((await api('put', `/exams/${ids.exam}/remarks`, T.teacher2).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, remark: 'No' }] })).body.error.code, 'NOT_CLASS_TEACHER');
  });

  test('publishing needs complete marks unless allowed; families are notified', async () => {
    const r = await api('post', `/exams/${ids.exam}/publish`, T.principal).send({});
    assert.equal(r.body.error.code, 'MARKS_INCOMPLETE');
    assert.equal(r.body.error.details.incomplete, 1);
    assert.deepEqual(r.body.error.details.students[0].missing, ['Maths']);
    expectStatus(await api('post', `/exams/${ids.exam}/publish`, T.teacher).send({}), 403);

    const ok = await api('post', `/exams/${ids.exam}/publish`, T.principal).send({ allowIncomplete: true });
    expectStatus(ok, 200);
    assert.deepEqual([ok.body.data.students, ok.body.data.pass, ok.body.data.fail, ok.body.data.incomplete], [5, 2, 2, 1]);
    assert.equal(ok.body.data.notificationsQueued, 2, 'parent of Arun and Bhanu (student login)');
    assert.equal(await Notification.countDocuments({ schoolId: S.a._id, type: 'exam.results' }), 2);

    assert.equal((await api('put', `/exams/${ids.exam}/papers/${ids.mathG1}/marks`, T.admin).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, marks: 99 }] })).body.error.code, 'EXAM_PUBLISHED');
    assert.equal((await api('put', `/exams/${ids.exam}/papers`, T.admin).send({ classId: ids.g1, papers: [] })).body.error.code, 'EXAM_PUBLISHED');
    const snap = await api('get', `/exams/${ids.exam}/results?sectionId=${ids.secA}`, T.admin);
    assert.equal(snap.body.data.preview, false);
    assert.equal(snap.body.data.results[0].remark, 'Excellent work');
  });

  test('families see published report cards only for their own children', async () => {
    const list = await api('get', '/portal/results', T.parent);
    expectStatus(list, 200);
    assert.deepEqual(list.body.data.results.map((r) => [r.exam.name, r.grade]), [['Half Yearly', 'A1']]);
    const card = await api('get', `/portal/results/${ids.exam}`, T.parent);
    expectStatus(card, 200);
    const c = card.body.data;
    assert.deepEqual([c.student.name, c.student.classSection, c.percentage, c.rankInSection, c.remark, c.preview], ['Arun Rao', 'Grade 1 - A', 93.33, 1, 'Excellent work', false]);
    assert.equal(c.subjects.length, 2);
    assert.equal(c.gradingScale.length, 6);
    expectStatus(await api('get', `/portal/results/${ids.exam}?studentId=${ids.s2}`, T.parent), 404);
    const self = await api('get', `/portal/results/${ids.exam}`, T.student);
    assert.equal(self.body.data.student.name, 'Bhanu Rao');
    const schedule = await api('get', '/portal/exams', T.parent);
    assert.equal(schedule.body.data.exams[0].papers.length, 2);
  });

  test('unpublish and republish (no repeat notifications)', async () => {
    expectStatus(await api('post', `/exams/${ids.exam}/unpublish`, T.principal).send({ reason: 'Marks correction' }), 200);
    expectStatus(await api('get', `/portal/results/${ids.exam}`, T.parent), 404);
    assert.equal((await api('put', `/exams/${ids.exam}/papers/${ids.mathG1}/marks`, T.teacher).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, marks: 96 }] })).body.error.code, 'MARKS_LOCKED');
    expectStatus(await api('put', `/exams/${ids.exam}/papers/${ids.mathG2}/marks`, T.admin).send({ sectionId: ids.secG2, entries: [{ studentId: ids.s5, marks: 60 }] }), 200);
    const staffPreview = await api('get', `/exams/${ids.exam}/report-cards/${ids.s5}`, T.admin);
    assert.equal(staffPreview.body.data.preview, true);
    const r = await api('post', `/exams/${ids.exam}/publish`, T.principal).send({});
    expectStatus(r, 200);
    assert.equal(r.body.data.incomplete, 0);
    assert.equal(r.body.data.notificationsQueued, 0);
  });

  test('session report card combines exams by weightage', async () => {
    const f = await api('post', '/exams', T.admin).send({ sessionId: ids.session, name: 'Final', type: 'final', classIds: [ids.g1], startDate: ymd(addDays(today, -4)), endDate: ymd(addDays(today, -1)), weightage: 60 });
    ids.final = f.body.data._id;
    await api('put', `/exams/${ids.final}/papers`, T.admin).send({ classId: ids.g1, papers: [{ subjectId: ids.math, date: ymd(addDays(today, -3)), maxMarks: 100, passMarks: 33 }] });
    const paperId = (await api('get', `/exams/${ids.final}/papers`, T.admin)).body.data[0]._id;
    await api('put', `/exams/${ids.final}/papers/${paperId}/marks`, T.admin).send({ sectionId: ids.secA, entries: [{ studentId: ids.s1, marks: 85 }] });
    expectStatus(await api('post', `/exams/${ids.final}/publish`, T.admin).send({ allowIncomplete: true }), 200);

    const card = await api('get', '/portal/report-card', T.parent);
    expectStatus(card, 200);
    const math = card.body.data.subjects.find((s) => s.code === 'MATH');
    assert.equal(math.percentage, 89); // (95 x 40 + 85 x 60) / 100
    assert.equal(card.body.data.percentage, 88.33); // (93.33 x 40 + 85 x 60) / 100
    assert.equal(card.body.data.grade, 'A2');
    assert.deepEqual(card.body.data.exams.map((e) => e.name), ['Half Yearly', 'Final']);
    const staff = await api('get', `/exams/students/${ids.s1}/report-card`, T.admin);
    assert.equal(staff.body.data.percentage, 88.33);
  });
});

describe('exam guards', () => {
  test('records in use cannot be deleted', async () => {
    assert.equal((await api('delete', `/exams/${ids.exam}`, T.admin)).body.error.code, 'EXAM_PUBLISHED');
    assert.equal((await api('put', '/academics/class-subjects', T.admin).send({ sessionId: ids.session, classId: ids.g1, subjects: [{ subjectId: ids.math }] })).body.error.code, 'CLASS_SUBJECTS_IN_USE');
    assert.equal((await api('delete', `/exams/grading-scales/${ids.scale}`, T.admin)).body.error.code, 'SCALE_IN_USE');
    assert.equal((await api('patch', `/exams/grading-scales/${ids.scale}`, T.admin).send({ bands: BANDS.slice(1) })).body.error.code, 'SCALE_IN_USE');
    assert.equal((await api('delete', `/students/${ids.s1}`, T.admin)).body.error.code, 'STUDENT_IN_USE');
  });
});
