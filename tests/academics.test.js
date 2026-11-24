import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, teardownDb, createUser, createSchool, addMember, createApp, PASSWORD, Campus, Membership } from './helpers.js';

const { nonWorkingDates } = await import('../src/modules/calendar/calendar.service.js');
const { getTeacherScope } = await import('../src/modules/academics/curriculum.service.js');
const { parseDateOnly } = await import('../src/utils/dates.js');

let app;
const S = {};
const T = {};
const M = {}; // membership ids
const ids = {};

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
const api = (method, path, token) => request(app)[method](`/api/v1/academics${path}`).set(bearer(token));
const cal = (method, path, token) => request(app)[method](`/api/v1/calendar${path}`).set(bearer(token));

before(async () => {
  await setupDb();
  app = createApp();
  S.a = await createSchool('acad-a');
  S.b = await createSchool('acad-b');
  ids.mainA = String((await Campus.findOne({ schoolId: S.a._id, isMain: true }))._id);
  ids.eastA = String((await Campus.create({ schoolId: S.a._id, name: 'East', code: 'EAST' }))._id);
  ids.mainB = String((await Campus.findOne({ schoolId: S.b._id }))._id);

  const people = {
    adminA: ['admin@acad-a.test', S.a, ['school_admin'], {}],
    teacherA: ['teacher@acad-a.test', S.a, ['teacher'], {}],
    teacher2A: ['teacher2@acad-a.test', S.a, ['teacher'], {}],
    eastTeacherA: ['east.teacher@acad-a.test', S.a, ['teacher'], { campusIds: [ids.eastA] }],
    eastAdminA: ['east.admin@acad-a.test', S.a, ['school_admin'], { campusIds: [ids.eastA] }],
    parentA: ['parent@acad-a.test', S.a, ['parent'], {}],
    ownerB: ['owner@acad-b.test', S.b, ['school_owner'], {}],
  };
  for (const [key, [email, school, roles, extra]] of Object.entries(people)) {
    const u = await createUser(email);
    M[key] = String((await addMember(school, u, roles, extra))._id);
    T[key] = await tokenFor(email);
  }
});
after(teardownDb);

describe('academic sessions', () => {
  test('first session becomes current; validation', async () => {
    const r = await api('post', '/sessions', T.adminA).send({ name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.isCurrent, true);
    assert.equal(r.body.data.status, 'active');
    assert.equal(r.body.data.startDate, '2026-04-01T00:00:00.000Z');
    ids.s1 = r.body.data._id;

    assert.equal((await api('post', '/sessions', T.adminA).send({ name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31' })).status, 409);
    assert.equal((await api('post', '/sessions', T.adminA).send({ name: 'Bad', startDate: '2027-04-01', endDate: '2026-03-31' })).status, 422);
    assert.equal((await api('post', '/sessions', T.adminA).send({ name: 'Bad', startDate: '2026-02-30', endDate: '2027-03-31' })).status, 422);
    assert.equal((await api('post', '/sessions', T.adminA).send({ name: 'Long', startDate: '2026-01-01', endDate: '2029-01-01' })).status, 422);

    const r2 = await api('post', '/sessions', T.adminA).send({ name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' });
    assert.equal(r2.body.data.isCurrent, false);
    assert.equal(r2.body.data.status, 'planned');
    ids.s2 = r2.body.data._id;

    const cur = await api('get', '/sessions/current', T.teacherA);
    assert.equal(cur.body.data._id, ids.s1);
  });

  test('teacher can read but not create sessions', async () => {
    assert.equal((await api('get', '/sessions', T.teacherA)).status, 200);
    assert.equal((await api('post', '/sessions', T.teacherA).send({ name: 'X1', startDate: '2030-04-01', endDate: '2031-03-31' })).status, 403);
  });

  test('current session cannot be closed or deleted', async () => {
    assert.equal((await api('patch', `/sessions/${ids.s1}`, T.adminA).send({ status: 'closed' })).body.error.code, 'CURRENT_SESSION');
    assert.equal((await api('delete', `/sessions/${ids.s1}`, T.adminA)).body.error.code, 'CURRENT_SESSION');
  });

  test('other schools cannot see sessions', async () => {
    assert.equal((await api('get', `/sessions/${ids.s1}`, T.ownerB)).status, 404);
    const list = await api('get', '/sessions', T.ownerB);
    assert.equal(list.body.meta.total, 0);
    assert.equal((await api('get', '/sessions/current', T.ownerB)).status, 404);
  });
});

describe('classes and subjects', () => {
  test('create, unique codes, ordered list', async () => {
    for (const [name, code, order] of [['Grade 2', 'G2', 3], ['Nursery', 'NUR', 0], ['Grade 1', 'G1', 2]]) {
      const r = await api('post', '/classes', T.adminA).send({ name, code, order });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids[code] = r.body.data._id;
    }
    assert.equal((await api('post', '/classes', T.adminA).send({ name: 'Dup', code: 'g1', order: 5 })).status, 409);
    const list = await api('get', '/classes', T.teacherA);
    assert.deepEqual(list.body.data.map((c) => c.code), ['NUR', 'G1', 'G2']);

    for (const [name, code, type] of [['Mathematics', 'MATH', 'theory'], ['English', 'ENG', 'theory'], ['Science', 'SCI', 'theory_practical'], ['Art', 'ART', 'activity']]) {
      const r = await api('post', '/subjects', T.adminA).send({ name, code, type });
      assert.equal(r.status, 201);
      ids[code] = r.body.data._id;
    }
    assert.equal((await api('post', '/classes', T.ownerB).send({ name: 'Grade 1', code: 'G1', order: 1 })).status, 201, 'same code allowed in another school');
  });

  test('soft-deleted class frees its code; inactive class cannot get sections', async () => {
    const tmp = await api('post', '/classes', T.adminA).send({ name: 'Temp', code: 'TMP', order: 50 });
    assert.equal((await api('delete', `/classes/${tmp.body.data._id}`, T.adminA)).status, 200);
    assert.equal((await api('get', `/classes/${tmp.body.data._id}`, T.adminA)).status, 404);
    assert.equal((await api('post', '/classes', T.adminA).send({ name: 'Temp again', code: 'TMP', order: 51 })).status, 201);

    const inactive = await api('post', '/classes', T.adminA).send({ name: 'Old', code: 'OLD', order: 60, status: 'inactive' });
    const r = await api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId: inactive.body.data._id, campusId: ids.mainA, name: 'A' });
    assert.equal(r.body.error.code, 'CLASS_INACTIVE');
  });
});

describe('sections', () => {
  test('create with class teacher; duplicates rejected; list ordered by class', async () => {
    const mk = (classId, name, extra = {}) => api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId, campusId: ids.mainA, name, ...extra });
    const a = await mk(ids.G1, 'a', { classTeacherId: M.teacherA, capacity: 40, room: '101' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.data.name, 'A');
    assert.equal(a.body.data.displayName, 'Grade 1 - A');
    assert.equal(a.body.data.classTeacher.name, 'teacher');
    ids.g1a = a.body.data._id;
    ids.g1b = (await mk(ids.G1, 'B')).body.data._id;
    ids.nurA = (await mk(ids.NUR, 'A')).body.data._id;
    ids.g2a = (await mk(ids.G2, 'A')).body.data._id;
    assert.equal((await mk(ids.G1, 'A')).status, 409);

    const east = await api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId: ids.G1, campusId: ids.eastA, name: 'A', classTeacherId: M.eastTeacherA });
    assert.equal(east.status, 201, 'same name allowed at another campus');
    ids.g1East = east.body.data._id;

    const list = await api('get', '/sections', T.teacherA);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((s) => s.displayName), ['Nursery - A', 'Grade 1 - A', 'Grade 1 - A', 'Grade 1 - B', 'Grade 2 - A']);
    assert.equal(String(list.body.meta.sessionId), ids.s1, 'defaults to current session');
  });

  test('teacher must be valid staff of this school, at the section campus', async () => {
    const mk = (teacher, campusId = ids.mainA, name = 'Z') => api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId: ids.G2, campusId, name, classTeacherId: teacher });
    assert.equal((await mk(M.parentA)).body.error.code, 'INVALID_TEACHER');
    assert.equal((await mk(M.ownerB)).body.error.code, 'INVALID_TEACHER', 'membership from another school');
    assert.equal((await mk(M.eastTeacherA)).body.error.code, 'TEACHER_CAMPUS_MISMATCH');
  });

  test('references from other schools are rejected', async () => {
    const bClass = (await api('get', '/classes', T.ownerB)).body.data[0]._id;
    assert.equal((await api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId: bClass, campusId: ids.mainA, name: 'X' })).status, 404);
    assert.equal((await api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId: ids.G1, campusId: ids.mainB, name: 'X' })).body.error.code, 'INVALID_CAMPUS');
    assert.equal((await api('get', `/sections/${ids.g1a}`, T.ownerB)).status, 404);
    assert.equal((await api('patch', `/sections/${ids.g1a}`, T.ownerB).send({ room: 'x' })).status, 404);
  });

  test('campus-restricted admin only sees and manages their campus sections', async () => {
    const list = await api('get', '/sections', T.eastAdminA);
    assert.deepEqual(list.body.data.map((s) => s._id), [ids.g1East]);
    assert.equal((await api('get', `/sections/${ids.g1a}`, T.eastAdminA)).body.error.code, 'CAMPUS_ACCESS_DENIED');
    assert.equal((await api('post', '/sections', T.eastAdminA).send({ sessionId: ids.s1, classId: ids.G2, campusId: ids.mainA, name: 'Q' })).body.error.code, 'CAMPUS_ACCESS_DENIED');
    const structure = await api('get', '/structure', T.eastAdminA);
    const g1 = structure.body.data.classes.find((c) => c.code === 'G1');
    assert.deepEqual(g1.sections.map((s) => s.id), [ids.g1East]);
  });

  test('session, class and campus of a section are immutable', async () => {
    assert.equal((await api('patch', `/sections/${ids.g1a}`, T.adminA).send({ classId: ids.G2 })).status, 422);
  });
});

describe('curriculum and teaching assignments', () => {
  test('set class subjects; other-school and inactive subjects rejected', async () => {
    const r = await api('put', '/class-subjects', T.adminA).send({
      sessionId: ids.s1,
      classId: ids.G1,
      subjects: [{ subjectId: ids.MATH, periodsPerWeek: 6 }, { subjectId: ids.ENG }, { subjectId: ids.ART, isOptional: true }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.subjects.map((s) => s.subject.code), ['MATH', 'ENG', 'ART']);

    const bSubject = (await request(app).post('/api/v1/academics/subjects').set(bearer(T.ownerB)).send({ name: 'Hindi', code: 'HIN' })).body.data._id;
    const bad = await api('put', '/class-subjects', T.adminA).send({ sessionId: ids.s1, classId: ids.G1, subjects: [{ subjectId: bSubject }] });
    assert.equal(bad.body.error.code, 'INVALID_SUBJECT');

    await api('patch', `/subjects/${ids.SCI}`, T.adminA).send({ status: 'inactive' });
    const inactive = await api('put', '/class-subjects', T.adminA).send({ sessionId: ids.s1, classId: ids.G1, subjects: [{ subjectId: ids.SCI }] });
    assert.equal(inactive.body.error.code, 'SUBJECT_INACTIVE');
    await api('patch', `/subjects/${ids.SCI}`, T.adminA).send({ status: 'active' });

    const get = await api('get', `/class-subjects?classId=${ids.G1}`, T.teacherA);
    assert.equal(get.body.data.subjects.length, 3);
  });

  test('assign teachers; subject must be in the class curriculum', async () => {
    const mk = (sectionId, subjectId, teacherId) => api('post', '/teaching-assignments', T.adminA).send({ sectionId, subjectId, teacherId });
    const notIn = await mk(ids.g1a, ids.SCI, M.teacherA);
    assert.equal(notIn.body.error.code, 'SUBJECT_NOT_IN_CLASS');
    const a1 = await mk(ids.g1a, ids.MATH, M.teacher2A);
    assert.equal(a1.status, 201, JSON.stringify(a1.body));
    assert.equal(a1.body.data.teacher.name, 'teacher2');
    assert.equal(a1.body.data.section.displayName, 'Grade 1 - A');
    ids.assignMath = a1.body.data._id;
    assert.equal((await mk(ids.g1a, ids.MATH, M.teacher2A)).status, 409);
    assert.equal((await mk(ids.g1a, ids.ART, M.teacher2A)).status, 201);
    assert.equal((await mk(ids.g1b, ids.ENG, M.teacherA)).status, 201);
    assert.equal((await mk(ids.g1a, ids.ENG, M.eastTeacherA)).body.error.code, 'TEACHER_CAMPUS_MISMATCH');

    const list = await api('get', `/teaching-assignments?sectionId=${ids.g1a}`, T.teacherA);
    assert.equal(list.body.data.length, 2);
  });

  test('my-assignments and teacher scope', async () => {
    const mine = await api('get', '/my-assignments', T.teacherA);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.data.classTeacherOf.map((s) => s.displayName), ['Grade 1 - A']);
    assert.deepEqual(mine.body.data.subjects.map((a) => `${a.section.displayName}:${a.subject.code}`), ['Grade 1 - B:ENG']);

    const scope = await getTeacherScope(S.a._id, M.teacherA, ids.s1);
    assert.deepEqual(scope.sectionIds.sort(), [ids.g1a, ids.g1b].sort());
  });

  test('removing a subject from a class removes its teaching assignments', async () => {
    const r = await api('put', '/class-subjects', T.adminA).send({ sessionId: ids.s1, classId: ids.G1, subjects: [{ subjectId: ids.MATH }, { subjectId: ids.ENG }] });
    assert.equal(r.body.data.assignmentsRemoved, 1);
    const list = await api('get', `/teaching-assignments?sectionId=${ids.g1a}`, T.adminA);
    assert.deepEqual(list.body.data.map((a) => a.subject.code), ['MATH']);
  });

  test('delete guards across modules', async () => {
    const del = await request(app).delete(`/api/v1/members/${M.teacherA}`).set(bearer(T.adminA));
    assert.equal(del.status, 409);
    assert.equal(del.body.error.code, 'MEMBER_IN_USE');
    assert.match(del.body.error.message, /class teacher of 1 section/);

    const campus = await request(app).delete(`/api/v1/campuses/${ids.eastA}`).set(bearer(T.adminA));
    assert.equal(campus.status, 409);
    assert.equal(campus.body.error.code, 'CAMPUS_IN_USE');

    assert.equal((await api('delete', `/classes/${ids.G1}`, T.adminA)).body.error.code, 'CLASS_IN_USE');
    assert.equal((await api('delete', `/subjects/${ids.MATH}`, T.adminA)).body.error.code, 'SUBJECT_IN_USE');
    assert.equal((await api('delete', `/subjects/${ids.SCI}`, T.adminA)).status, 200, 'unused subject can be deleted');
  });

  test('deleting a section removes its assignments', async () => {
    const s = await api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId: ids.G1, campusId: ids.mainA, name: 'TMP' });
    await api('post', '/teaching-assignments', T.adminA).send({ sectionId: s.body.data._id, subjectId: ids.ENG, teacherId: M.teacherA });
    assert.equal((await api('delete', `/sections/${s.body.data._id}`, T.adminA)).status, 200);
    const left = await api('get', `/teaching-assignments?sectionId=${ids.g1a}`, T.adminA);
    assert.ok(left.body.data.every((a) => a.sectionId !== s.body.data._id));
  });
});

describe('year rollover', () => {
  test('copy structure into next session, skipping inactive teachers; idempotent', async () => {
    await Membership.updateOne({ schoolId: S.a._id, _id: M.teacher2A }, { status: 'suspended' });
    const r = await api('post', `/sessions/${ids.s2}/copy-structure`, T.adminA).send({ fromSessionId: ids.s1, teachers: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.sectionsCreated, 5);
    assert.equal(r.body.data.classSubjectsCreated, 2);
    assert.equal(r.body.data.assignmentsCreated, 1, 'only the active teacher assignment is copied');
    assert.equal(r.body.data.teachersSkipped, 1);

    const again = await api('post', `/sessions/${ids.s2}/copy-structure`, T.adminA).send({ fromSessionId: ids.s1, teachers: true });
    assert.equal(again.body.data.sectionsCreated, 0);
    assert.equal(again.body.data.classSubjectsCreated, 0);

    const next = await api('get', `/sections?sessionId=${ids.s2}`, T.adminA);
    const g1a = next.body.data.find((s) => s.displayName === 'Grade 1 - A' && s.campus.code === 'MAIN');
    assert.equal(g1a.classTeacher.name, 'teacher');
    await Membership.updateOne({ schoolId: S.a._id, _id: M.teacher2A }, { status: 'active' });
  });

  test('switch current session, close the old one; closed session is read-only', async () => {
    assert.equal((await api('post', `/sessions/${ids.s2}/set-current`, T.adminA)).status, 200);
    assert.equal((await api('get', '/sessions/current', T.adminA)).body.data._id, ids.s2);
    assert.equal((await api('patch', `/sessions/${ids.s1}`, T.adminA).send({ status: 'closed' })).status, 200);

    const r = await api('post', '/sections', T.adminA).send({ sessionId: ids.s1, classId: ids.G2, campusId: ids.mainA, name: 'NEW' });
    assert.equal(r.body.error.code, 'SESSION_CLOSED');
    assert.equal((await api('patch', `/sections/${ids.g1a}`, T.adminA).send({ room: '202' })).body.error.code, 'SESSION_CLOSED');
    assert.equal((await api('put', '/class-subjects', T.adminA).send({ sessionId: ids.s1, classId: ids.G1, subjects: [] })).body.error.code, 'SESSION_CLOSED');
    assert.equal((await api('post', `/sessions/${ids.s1}/set-current`, T.adminA)).body.error.code, 'SESSION_CLOSED');
    assert.equal((await api('delete', `/sessions/${ids.s1}`, T.adminA)).body.error.code, 'SESSION_IN_USE');

    // Reading history still works.
    assert.equal((await api('get', `/sections?sessionId=${ids.s1}`, T.adminA)).body.meta.total, 5);
  });
});

describe('academic calendar', () => {
  test('create events within the session; campus-specific visibility', async () => {
    const holiday = await cal('post', '', T.adminA).send({ sessionId: ids.s2, title: 'Independence Day', type: 'holiday', startDate: '2027-08-15' });
    assert.equal(holiday.status, 201, JSON.stringify(holiday.body));
    assert.equal(holiday.body.data.isNonWorking, true);
    assert.equal(holiday.body.data.endDate, '2027-08-15T00:00:00.000Z');

    const vacation = await cal('post', '', T.adminA).send({ sessionId: ids.s2, title: 'East campus break', type: 'vacation', startDate: '2027-10-01', endDate: '2027-10-03', campusIds: [ids.eastA] });
    assert.equal(vacation.status, 201);
    await cal('post', '', T.adminA).send({ sessionId: ids.s2, title: 'Annual Day', type: 'event', startDate: '2027-12-20' });

    const outside = await cal('post', '', T.adminA).send({ sessionId: ids.s2, title: 'Too early', startDate: '2026-01-01' });
    assert.equal(outside.body.error.code, 'OUTSIDE_SESSION');
    const inverted = await cal('post', '', T.adminA).send({ sessionId: ids.s2, title: 'Inverted', startDate: '2027-09-10', endDate: '2027-09-01' });
    assert.equal(inverted.status, 422);

    const parentView = await cal('get', '', T.parentA);
    assert.equal(parentView.status, 200, 'parents can read the calendar');
    assert.equal(parentView.body.data.items.length, 3);

    const mainOnly = await cal('get', `?campusId=${ids.mainA}`, T.teacherA);
    assert.deepEqual(mainOnly.body.data.items.map((e) => e.title), ['Independence Day', 'Annual Day']);

    const holidaysOnly = await cal('get', '?type=holiday&from=2027-08-01&to=2027-08-31', T.teacherA);
    assert.equal(holidaysOnly.body.data.items.length, 1);

    assert.equal((await cal('post', '', T.teacherA).send({ sessionId: ids.s2, title: 'Nope', startDate: '2027-09-01' })).status, 403);
    const eastAdminWide = await cal('post', '', T.eastAdminA).send({ sessionId: ids.s2, title: 'All campuses', startDate: '2027-09-01' });
    assert.equal(eastAdminWide.body.error.code, 'CAMPUS_ACCESS_DENIED');
  });

  test('non-working dates helper respects campus', async () => {
    const from = parseDateOnly('2027-08-01');
    const to = parseDateOnly('2027-10-31');
    assert.deepEqual(await nonWorkingDates(S.a._id, { from, to, campusId: ids.mainA }), ['2027-08-15']);
    assert.deepEqual(await nonWorkingDates(S.a._id, { from, to, campusId: ids.eastA }), ['2027-08-15', '2027-10-01', '2027-10-02', '2027-10-03']);
  });

  test('session dates cannot shrink past its events', async () => {
    const r = await api('patch', `/sessions/${ids.s2}`, T.adminA).send({ endDate: '2027-11-30' });
    assert.equal(r.body.error.code, 'EVENTS_OUTSIDE_SESSION');
  });

  test('other schools cannot see events', async () => {
    const r = await cal('get', `?sessionId=${ids.s2}`, T.ownerB);
    assert.equal(r.status, 404);
  });
});
