import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, teardownDb, createUser, createSchool, createPlan, addMember, createApp, PASSWORD, Campus, Membership, User } from './helpers.js';

const { AcademicSession, SchoolClass, Section, Subject, ClassSubject, TeachingAssignment } = await import('../src/modules/academics/academics.models.js');
const { Enrollment } = await import('../src/modules/students/student.model.js');
const { StaffProfile } = await import('../src/modules/staff/staffProfile.model.js');
const { devOutbox } = await import('../src/services/mail.service.js');
const { familyStudentIds } = await import('../src/modules/students/access.js');
const { parseDateOnly } = await import('../src/utils/dates.js');

let app;
const S = {};
const T = {};
const M = {};
const ids = {};

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
const api = (method, path, token) => request(app)[method](`/api/v1${path}`).set(bearer(token));
const expectStatus = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));

async function academics(school, campusIds) {
  const schoolId = school._id;
  const s1 = await AcademicSession.create({ schoolId, name: '2026-27', startDate: parseDateOnly('2026-04-01'), endDate: parseDateOnly('2027-03-31'), status: 'active', isCurrent: true });
  const s2 = await AcademicSession.create({ schoolId, name: '2027-28', startDate: parseDateOnly('2027-04-01'), endDate: parseDateOnly('2028-03-31'), status: 'planned' });
  const g1 = await SchoolClass.create({ schoolId, name: 'Grade 1', code: 'G1', order: 1 });
  const g2 = await SchoolClass.create({ schoolId, name: 'Grade 2', code: 'G2', order: 2 });
  const math = await Subject.create({ schoolId, name: 'Maths', code: 'MATH' });
  const mk = (sessionId, classId, name, campusId, capacity = 40) => Section.create({ schoolId, sessionId, classId, campusId, name, capacity });
  const out = {
    s1: s1._id,
    s2: s2._id,
    g1: g1._id,
    g2: g2._id,
    math: math._id,
    g1a: (await mk(s1._id, g1._id, 'A', campusIds.main))._id,
    g1b: (await mk(s1._id, g1._id, 'B', campusIds.main))._id,
    g1small: (await mk(s1._id, g1._id, 'S', campusIds.main, 2))._id,
    g1east: campusIds.east ? (await mk(s1._id, g1._id, 'E', campusIds.east))._id : null,
    g2next: (await mk(s2._id, g2._id, 'A', campusIds.main))._id,
  };
  await ClassSubject.create({ schoolId, sessionId: s1._id, classId: g1._id, subjectId: math._id });
  return out;
}

before(async () => {
  await setupDb();
  app = createApp();
  S.a = await createSchool('ppl-a');
  S.b = await createSchool('ppl-b');
  S.lim = await createSchool('ppl-lim', { plan: await createPlan('lim-students', { limits: { maxStudents: 2 } }) });
  S.noadm = await createSchool('ppl-noadm', { plan: await createPlan('no-admissions', { modules: ['attendance'] }) });

  ids.mainA = String((await Campus.findOne({ schoolId: S.a._id, isMain: true }))._id);
  ids.eastA = String((await Campus.create({ schoolId: S.a._id, name: 'East', code: 'EAST' }))._id);
  ids.mainLim = String((await Campus.findOne({ schoolId: S.lim._id }))._id);
  ids.a = await academics(S.a, { main: ids.mainA, east: ids.eastA });
  ids.lim = await academics(S.lim, { main: ids.mainLim });

  const people = {
    adminA: ['admin@ppl-a.test', S.a, ['school_admin'], {}],
    principalA: ['principal@ppl-a.test', S.a, ['principal'], {}],
    accountantA: ['accounts@ppl-a.test', S.a, ['accountant'], {}],
    teacherA: ['teacher@ppl-a.test', S.a, ['teacher'], {}],
    teacher2A: ['teacher2@ppl-a.test', S.a, ['teacher'], {}],
    eastAdminA: ['east.admin@ppl-a.test', S.a, ['school_admin'], { campusIds: [ids.eastA] }],
    ownerB: ['owner@ppl-b.test', S.b, ['school_owner'], {}],
    ownerLim: ['owner@ppl-lim.test', S.lim, ['school_owner'], {}],
    ownerNoadm: ['owner@ppl-noadm.test', S.noadm, ['school_owner'], {}],
  };
  for (const [key, [email, school, roles, extra]] of Object.entries(people)) {
    const u = await createUser(email);
    M[key] = String((await addMember(school, u, roles, extra))._id);
    T[key] = await tokenFor(email);
  }
  // teacherA teaches Grade 1-A.
  await TeachingAssignment.create({ schoolId: S.a._id, sessionId: ids.a.s1, sectionId: ids.a.g1a, subjectId: ids.a.math, teacherId: M.teacherA });
});
after(teardownDb);

const guardianInput = (name, phone, extra = {}) => ({ guardian: { name, phone, ...extra }, relation: 'father' });

describe('students', () => {
  test('create with a new guardian and enrollment; admission number is generated', async () => {
    const r = await api('post', '/students', T.adminA).send({
      firstName: 'Aarav',
      lastName: 'Sharma',
      gender: 'male',
      dateOfBirth: '2019-05-10',
      enrollment: { sectionId: String(ids.a.g1a), rollNo: 5 },
      guardians: [guardianInput('Rakesh Sharma', '+91 98765 43210', { email: 'rakesh@family.test' })],
    });
    expectStatus(r, 201);
    const s = r.body.data;
    assert.equal(s.admissionNo, 'ADM0001');
    assert.equal(s.campusId, ids.mainA, 'campus taken from the section');
    assert.equal(s.currentEnrollment.displayName, 'Grade 1 - A');
    assert.equal(s.currentEnrollment.rollNo, 5);
    assert.equal(s.guardians.length, 1);
    assert.equal(s.guardians[0].isPrimary, true, 'first guardian becomes primary');
    ids.aarav = s._id;
    ids.rakesh = s.guardians[0].guardianId;
  });

  test('same parent phone is detected; sibling links the existing parent', async () => {
    const dup = await api('post', '/students', T.adminA).send({
      firstName: 'Diya',
      gender: 'female',
      campusId: ids.mainA,
      guardians: [guardianInput('R. Sharma', '9876543210'.replace(/^/, '+91'))],
    });
    expectStatus(dup, 409);
    assert.equal(dup.body.error.code, 'DUPLICATE_GUARDIAN');
    assert.equal(dup.body.error.details.matches[0].id, ids.rakesh);

    const r = await api('post', '/students', T.adminA).send({
      firstName: 'Diya',
      lastName: 'Sharma',
      gender: 'female',
      enrollment: { sectionId: String(ids.a.g1b) },
      guardians: [{ guardianId: ids.rakesh, relation: 'father' }],
    });
    expectStatus(r, 201);
    ids.diya = r.body.data._id;
    const parent = await api('get', `/parents/${ids.rakesh}`, T.adminA);
    assert.deepEqual(parent.body.data.children.map((c) => c.name).sort(), ['Aarav Sharma', 'Diya Sharma']);
  });

  test('admission numbers and roll numbers are unique', async () => {
    const a = await api('post', '/students', T.adminA).send({ firstName: 'Kabir', gender: 'male', campusId: ids.mainA, admissionNo: 'adm0001' });
    assert.equal(a.body.error.code, 'ADMISSION_NO_TAKEN');
    const b = await api('post', '/students', T.adminA).send({ firstName: 'Kabir', gender: 'male', enrollment: { sectionId: String(ids.a.g1a), rollNo: 5 } });
    assert.equal(b.body.error.code, 'ROLL_NO_TAKEN');
    const c = await api('post', '/students', T.adminA).send({ firstName: 'Kabir', lastName: 'Rao', gender: 'male', admissionNo: '2026/015', enrollment: { sectionId: String(ids.a.g1a) } });
    expectStatus(c, 201);
    assert.equal(c.body.data.admissionNo, '2026/015');
    ids.kabir = c.body.data._id;
  });

  test('section capacity is enforced', async () => {
    for (const name of ['Cap1', 'Cap2']) {
      expectStatus(await api('post', '/students', T.adminA).send({ firstName: name, gender: 'female', enrollment: { sectionId: String(ids.a.g1small) } }), 201);
    }
    const full = await api('post', '/students', T.adminA).send({ firstName: 'Cap3', gender: 'female', enrollment: { sectionId: String(ids.a.g1small) } });
    assert.equal(full.body.error.code, 'SECTION_FULL');
    // Nothing half-created: no student named Cap3.
    const list = await api('get', '/students?search=Cap3', T.adminA);
    assert.equal(list.body.meta.total, 0);
  });

  test('validation errors', async () => {
    expectStatus(await api('post', '/students', T.adminA).send({ gender: 'male', campusId: ids.mainA }), 422);
    expectStatus(await api('post', '/students', T.adminA).send({ firstName: 'X', gender: 'male' }), 422); // no campus or section
    expectStatus(await api('post', '/students', T.adminA).send({ firstName: 'X', gender: 'male', campusId: ids.mainA, schoolId: String(S.b._id) }), 422);
    const mismatch = await api('post', '/students', T.adminA).send({ firstName: 'X', gender: 'male', campusId: ids.eastA, enrollment: { sectionId: String(ids.a.g1a) } });
    assert.equal(mismatch.body.error.code, 'ENROLLMENT_CAMPUS_MISMATCH');
  });

  test('list: search by name, admission number and parent phone; filters', async () => {
    const byName = await api('get', '/students?search=aarav%20sh', T.adminA);
    assert.deepEqual(byName.body.data.map((s) => s.fullName), ['Aarav Sharma']);
    assert.equal(byName.body.data[0].primaryGuardian.name, 'Rakesh Sharma');
    assert.equal(byName.body.data[0].enrollment.displayName, 'Grade 1 - A');

    const byPhone = await api('get', '/students?search=98765', T.adminA);
    assert.deepEqual(byPhone.body.data.map((s) => s.firstName).sort(), ['Aarav', 'Diya']);

    const bySection = await api('get', `/students?sectionId=${ids.a.g1a}`, T.adminA);
    assert.deepEqual(bySection.body.data.map((s) => s.firstName).sort(), ['Aarav', 'Kabir']);

    const summary = await api('get', '/students/summary', T.adminA);
    assert.equal(summary.body.data.active, 5);
  });

  test('accountant can read but not create students', async () => {
    expectStatus(await api('get', '/students', T.accountantA), 200);
    expectStatus(await api('post', '/students', T.accountantA).send({ firstName: 'No', gender: 'male', campusId: ids.mainA }), 403);
  });

  test('teachers only see students of sections they teach', async () => {
    const mine = await api('get', '/students', T.teacherA);
    assert.deepEqual(mine.body.data.map((s) => s.firstName).sort(), ['Aarav', 'Kabir']);
    expectStatus(await api('get', `/students/${ids.aarav}`, T.teacherA), 200);
    expectStatus(await api('get', `/students/${ids.diya}`, T.teacherA), 404);
    assert.equal((await api('get', '/students', T.teacher2A)).body.meta.total, 0);

    const roster = await api('get', `/students/sections/${ids.a.g1a}/roster`, T.teacherA);
    expectStatus(roster, 200);
    assert.equal(roster.body.data.count, 2);
    assert.equal((await api('get', `/students/sections/${ids.a.g1b}/roster`, T.teacherA)).body.error.code, 'SECTION_ACCESS_DENIED');

    // Teachers see parents of their own students only.
    const parents = await api('get', '/parents', T.teacherA);
    assert.deepEqual(parents.body.data.map((p) => p.name), ['Rakesh Sharma']);
    expectStatus(await api('get', `/parents/${ids.rakesh}`, T.teacher2A), 404);
  });

  test('campus-restricted staff only see their campus', async () => {
    assert.equal((await api('get', '/students', T.eastAdminA)).body.meta.total, 0);
    expectStatus(await api('get', `/students/${ids.aarav}`, T.eastAdminA), 404);
    const r = await api('post', '/students', T.eastAdminA).send({ firstName: 'Main', gender: 'male', campusId: ids.mainA });
    assert.equal(r.body.error.code, 'CAMPUS_ACCESS_DENIED');
    const ok = await api('post', '/students', T.eastAdminA).send({ firstName: 'Easty', gender: 'male', enrollment: { sectionId: String(ids.a.g1east) } });
    expectStatus(ok, 201);
    ids.easty = ok.body.data._id;
    assert.deepEqual((await api('get', '/students', T.eastAdminA)).body.data.map((s) => s.firstName), ['Easty']);
  });

  test('other schools cannot see or modify students', async () => {
    expectStatus(await api('get', `/students/${ids.aarav}`, T.ownerB), 404);
    expectStatus(await api('patch', `/students/${ids.aarav}`, T.ownerB).send({ firstName: 'Hacked' }), 404);
    expectStatus(await api('get', `/parents/${ids.rakesh}`, T.ownerB), 404);
    assert.equal((await api('get', '/students', T.ownerB)).body.meta.total, 0);
    const link = await api('post', `/students/${ids.aarav}/guardians`, T.ownerB).send({ guardianId: ids.rakesh, relation: 'father' });
    expectStatus(link, 404);
  });

  test('campus follows the current section', async () => {
    const r = await api('patch', `/students/${ids.aarav}`, T.adminA).send({ campusId: ids.eastA });
    assert.equal(r.body.error.code, 'CAMPUS_FOLLOWS_ENROLLMENT');
    const enrollmentId = (await api('get', `/students/${ids.kabir}`, T.adminA)).body.data.currentEnrollment._id;
    const moved = await api('patch', `/students/enrollments/${enrollmentId}`, T.adminA).send({ sectionId: String(ids.a.g1east) });
    expectStatus(moved, 200);
    assert.equal((await api('get', `/students/${ids.kabir}`, T.adminA)).body.data.campusId, ids.eastA);
    const wrongSession = await api('patch', `/students/enrollments/${enrollmentId}`, T.adminA).send({ sectionId: String(ids.a.g2next) });
    assert.equal(wrongSession.body.error.code, 'SESSION_MISMATCH');
    await api('patch', `/students/enrollments/${enrollmentId}`, T.adminA).send({ sectionId: String(ids.a.g1a) });
  });

  test('enrolling twice in a session is refused', async () => {
    const r = await api('post', `/students/${ids.aarav}/enrollments`, T.adminA).send({ sectionId: String(ids.a.g1b) });
    assert.equal(r.body.error.code, 'ALREADY_ENROLLED');
  });

  test('roll numbers can be assigned by name', async () => {
    const r = await api('post', '/students/roll-numbers', T.adminA).send({ sectionId: String(ids.a.g1a) });
    expectStatus(r, 200);
    assert.deepEqual(r.body.data.items.map((i) => [i.rollNo, i.name]), [[1, 'Aarav Sharma'], [2, 'Kabir Rao']]);
  });

  test('withdrawing a student ends the enrollment and frees the seat', async () => {
    const cap1 = (await api('get', '/students?search=Cap1', T.adminA)).body.data[0];
    const r = await api('patch', `/students/${cap1._id}`, T.adminA).send({ status: 'withdrawn', leavingReason: 'Relocated' });
    expectStatus(r, 200);
    assert.equal(r.body.data.enrollments[0].status, 'left');
    assert.equal(r.body.data.currentEnrollment, null);
    expectStatus(await api('post', '/students', T.adminA).send({ firstName: 'Cap3', gender: 'female', enrollment: { sectionId: String(ids.a.g1small) } }), 201);
  });

  test('promotion to the next session', async () => {
    const bad = await api('post', '/students/promote', T.adminA).send({ fromSectionId: String(ids.a.g2next), toSectionId: String(ids.a.g1a), studentIds: [ids.aarav] });
    assert.equal(bad.body.error.code, 'INVALID_PROMOTION');

    const r = await api('post', '/students/promote', T.adminA).send({ fromSectionId: String(ids.a.g1a), toSectionId: String(ids.a.g2next), studentIds: [ids.aarav, ids.diya] });
    expectStatus(r, 200);
    assert.equal(r.body.data.promoted, 1);
    assert.deepEqual(r.body.data.skipped, [{ studentId: ids.diya, reason: 'NOT_IN_SOURCE_SECTION' }]);
    const old = await Enrollment.findOne({ schoolId: S.a._id, studentId: ids.aarav, sessionId: ids.a.s1 }).lean();
    assert.equal(old.status, 'promoted');
    const again = await api('post', '/students/promote', T.adminA).send({ fromSectionId: String(ids.a.g1a), toSectionId: String(ids.a.g2next), studentIds: [ids.aarav] });
    assert.equal(again.body.data.promoted, 0);
  });

  test('sections, classes and sessions with enrollments cannot be deleted', async () => {
    assert.equal((await api('delete', `/academics/sections/${ids.a.g1b}`, T.adminA)).body.error.code, 'SECTION_IN_USE');
    assert.equal((await api('delete', `/academics/sessions/${ids.a.s2}`, T.adminA)).body.error.code, 'SESSION_IN_USE');
    assert.equal((await api('delete', `/campuses/${ids.eastA}`, T.adminA)).body.error.code, 'CAMPUS_IN_USE');
  });
});

describe('student plan limit', () => {
  test('maxStudents counts active students only', async () => {
    const mk = (firstName, extra = {}) => api('post', '/students', T.ownerLim).send({ firstName, gender: 'male', campusId: ids.mainLim, ...extra });
    expectStatus(await mk('One'), 201);
    const two = await mk('Two');
    expectStatus(two, 201);
    const three = await mk('Three');
    assert.equal(three.body.error.code, 'PLAN_LIMIT_REACHED');
    expectStatus(await mk('Inactive', { status: 'inactive' }), 201);

    expectStatus(await api('patch', `/students/${two.body.data._id}`, T.ownerLim).send({ status: 'transferred' }), 200);
    expectStatus(await mk('Three'), 201);
    const back = await api('patch', `/students/${two.body.data._id}`, T.ownerLim).send({ status: 'active' });
    assert.equal(back.body.error.code, 'PLAN_LIMIT_REACHED');
    const usage = await api('get', '/subscription', T.ownerLim);
    assert.equal(usage.body.data.usage.maxStudents, 2);
  });
});

describe('parents', () => {
  test('create, duplicate detection, update and search', async () => {
    const r = await api('post', '/parents', T.adminA).send({ name: 'Meena Rao', phone: '+91 90000 11111', email: 'meena@family.test' });
    expectStatus(r, 201);
    ids.meena = r.body.data._id;
    assert.equal((await api('post', '/parents', T.adminA).send({ name: 'M Rao', phone: '+919000011111' })).body.error.code, 'DUPLICATE_GUARDIAN');
    expectStatus(await api('post', '/parents', T.adminA).send({ name: 'Other Meena', phone: '+919000011111', allowDuplicate: true }), 201);
    const u = await api('patch', `/parents/${ids.meena}`, T.adminA).send({ occupation: 'Engineer' });
    assert.equal(u.body.data.occupation, 'Engineer');
    const s = await api('get', '/parents?search=90000', T.adminA);
    assert.equal(s.body.meta.total, 2);
    expectStatus(await api('post', '/parents', T.teacherA).send({ name: 'Nope', phone: '+919999999999' }), 403);
  });

  test('linking, primary contact and unlinking', async () => {
    const link = await api('post', `/students/${ids.kabir}/guardians`, T.adminA).send({ guardianId: ids.meena, relation: 'mother' });
    expectStatus(link, 201);
    assert.equal(link.body.data[0].isPrimary, true);
    const second = await api('post', `/students/${ids.kabir}/guardians`, T.adminA).send({ guardian: { name: 'Vikram Rao', phone: '+91 91111 22222' }, relation: 'father', isPrimary: true });
    expectStatus(second, 201);
    const primary = second.body.data.filter((g) => g.isPrimary);
    assert.deepEqual(primary.map((g) => g.name), ['Vikram Rao']);
    ids.vikram = primary[0].guardianId;

    assert.equal((await api('post', `/students/${ids.kabir}/guardians`, T.adminA).send({ guardianId: ids.meena, relation: 'mother' })).body.error.code, 'ALREADY_LINKED');
    assert.equal((await api('patch', `/students/${ids.kabir}/guardians/${ids.vikram}`, T.adminA).send({ isPrimary: false })).body.error.code, 'PRIMARY_REQUIRED');

    const un = await api('delete', `/students/${ids.kabir}/guardians/${ids.vikram}`, T.adminA);
    expectStatus(un, 200);
    assert.equal(un.body.data[0].name, 'Meena Rao');
    assert.equal(un.body.data[0].isPrimary, true, 'remaining parent becomes primary');

    assert.equal((await api('delete', `/parents/${ids.meena}`, T.adminA)).body.error.code, 'GUARDIAN_IN_USE');
    expectStatus(await api('delete', `/parents/${ids.vikram}`, T.adminA), 200);
  });
});

describe('portal access', () => {
  test('parent portal: new user gets a setup email and sees only their children', async () => {
    const before = devOutbox.length;
    const r = await api('post', `/parents/${ids.rakesh}/portal-access`, T.adminA).send({});
    expectStatus(r, 200);
    assert.equal(r.body.data.isNewUser, true);
    assert.equal(r.body.data.parent.portal.enabled, true);
    assert.equal(devOutbox.length, before + 1);
    assert.equal(devOutbox.at(-1).to, 'rakesh@family.test');

    // Give the new account a known password and sign in.
    const user = await User.findOne({ email: 'rakesh@family.test' }).select('+passwordHash');
    await user.setPassword(PASSWORD);
    await user.save();
    T.rakesh = await tokenFor('rakesh@family.test');

    const kids = await api('get', '/portal/children', T.rakesh);
    expectStatus(kids, 200);
    assert.deepEqual(kids.body.data.children.map((c) => c.name).sort(), ['Aarav Sharma', 'Diya Sharma']);
    expectStatus(await api('get', '/students', T.rakesh), 403);
    expectStatus(await api('get', `/students/${ids.aarav}`, T.rakesh), 403);
    expectStatus(await api('get', '/portal/student', T.rakesh), 403);

    const membership = await Membership.findOne({ schoolId: S.a._id, userId: user._id }).lean();
    const fam = await familyStudentIds({ schoolId: S.a._id, membershipId: membership._id, roles: membership.roles });
    assert.deepEqual(fam.sort(), [ids.aarav, ids.diya].sort());
  });

  test('a login can only represent one family record', async () => {
    const r = await api('post', `/parents/${ids.meena}/portal-access`, T.adminA).send({ email: 'rakesh@family.test' });
    assert.equal(r.body.error.code, 'PORTAL_ACCOUNT_IN_USE');
    assert.equal((await api('post', `/parents/${ids.rakesh}/portal-access`, T.adminA).send({})).body.error.code, 'PORTAL_ALREADY_ENABLED');
  });

  test('a teacher who is also a parent keeps one membership with both roles', async () => {
    const r = await api('post', `/parents/${ids.meena}/portal-access`, T.adminA).send({ email: 'teacher2@ppl-a.test' });
    expectStatus(r, 200);
    assert.equal(r.body.data.isNewUser, false);
    const m = await Membership.findOne({ _id: M.teacher2A, schoolId: S.a._id }).lean();
    assert.deepEqual([...m.roles].sort(), ['parent', 'teacher']);
    // Staff member removal is refused while they hold a parent login.
    assert.equal((await api('delete', `/members/${M.teacher2A}`, T.adminA)).body.error.code, 'FAMILY_MEMBERSHIP');
    // Revoking keeps the teacher membership.
    expectStatus(await api('delete', `/parents/${ids.meena}/portal-access`, T.adminA), 200);
    assert.deepEqual((await Membership.findOne({ _id: M.teacher2A, schoolId: S.a._id }).lean()).roles, ['teacher']);
  });

  test('student portal shows the student their own record', async () => {
    assert.equal((await api('post', `/students/${ids.diya}/portal-access`, T.adminA).send({})).body.error.code, 'EMAIL_REQUIRED');
    await createUser('diya@student.test');
    const r = await api('post', `/students/${ids.diya}/portal-access`, T.adminA).send({ email: 'diya@student.test' });
    expectStatus(r, 200);
    assert.equal(r.body.data.student.portal.enabled, true);
    T.diya = await tokenFor('diya@student.test');
    const me = await api('get', '/portal/student', T.diya);
    expectStatus(me, 200);
    assert.equal(me.body.data.student.name, 'Diya Sharma');
    assert.equal(me.body.data.student.currentEnrollment.displayName, 'Grade 1 - B');
    expectStatus(await api('get', '/portal/children', T.diya), 403);

    expectStatus(await api('delete', `/students/${ids.diya}/portal-access`, T.adminA), 200);
    const diyaUser = await User.findOne({ email: 'diya@student.test' });
    assert.equal(await Membership.countDocuments({ schoolId: S.a._id, userId: diyaUser._id }), 0, 'membership removed with its only role');
  });

  test('principal cannot grant logins (needs users.create)', async () => {
    expectStatus(await api('post', `/students/${ids.kabir}/portal-access`, T.principalA).send({ email: 'kabir@student.test' }), 403);
  });
});

describe('deleting students', () => {
  test('delete removes enrollments and links and frees the admission number', async () => {
    const r = await api('post', '/students', T.adminA).send({ firstName: 'Temp', gender: 'male', admissionNo: 'TMP1', enrollment: { sectionId: String(ids.a.g1b) }, guardians: [{ guardianId: ids.meena, relation: 'mother' }] });
    expectStatus(r, 201);
    expectStatus(await api('delete', `/students/${r.body.data._id}`, T.adminA), 200);
    expectStatus(await api('get', `/students/${r.body.data._id}`, T.adminA), 404);
    assert.equal(await Enrollment.countDocuments({ schoolId: S.a._id, studentId: r.body.data._id }), 0);
    expectStatus(await api('post', '/students', T.adminA).send({ firstName: 'Temp2', gender: 'male', admissionNo: 'TMP1', campusId: ids.mainA }), 201);
    expectStatus(await api('delete', `/students/${ids.aarav}`, T.accountantA), 403);
  });
});

describe('admissions', () => {
  const application = () => ({
    sessionId: String(ids.a.s1),
    classId: String(ids.a.g1),
    campusId: ids.mainA,
    applicant: { firstName: 'Ishaan', lastName: 'Verma', gender: 'male', dateOfBirth: '2019-01-20' },
    guardian: { name: 'Sunita Verma', phone: '+91 95555 66666', relation: 'mother', email: 'sunita@family.test' },
    source: 'website',
  });

  test('workflow: enquiry → applied → approved → enrolled', async () => {
    const r = await api('post', '/admissions', T.adminA).send(application());
    expectStatus(r, 201);
    assert.equal(r.body.data.applicationNo, 'APP00001');
    assert.equal(r.body.data.status, 'enquiry');
    assert.equal(r.body.data.guardian.phoneNormalized, undefined);
    const id = r.body.data._id;
    ids.app1 = id;

    const notApproved = await api('post', `/admissions/${id}/enroll`, T.adminA).send({});
    assert.equal(notApproved.body.error.code, 'ADMISSION_NOT_APPROVED');
    const bad = await api('post', `/admissions/${id}/status`, T.adminA).send({ status: 'approved' });
    assert.equal(bad.body.error.code, 'INVALID_STATUS_TRANSITION');
    expectStatus(await api('post', `/admissions/${id}/status`, T.adminA).send({ status: 'enrolled' }), 422);

    expectStatus(await api('post', `/admissions/${id}/status`, T.adminA).send({ status: 'applied', note: 'Form received' }), 200);
    const approved = await api('post', `/admissions/${id}/status`, T.principalA).send({ status: 'approved' });
    expectStatus(approved, 200);
    assert.deepEqual(approved.body.data.history.map((h) => h.status), ['enquiry', 'applied', 'approved']);

    const mismatch = await api('post', `/admissions/${id}/enroll`, T.adminA).send({ sectionId: String(ids.a.g2next) });
    assert.equal(mismatch.body.error.code, 'SECTION_MISMATCH');

    const e = await api('post', `/admissions/${id}/enroll`, T.adminA).send({ sectionId: String(ids.a.g1b) });
    expectStatus(e, 201);
    assert.equal(e.body.data.admission.status, 'enrolled');
    assert.equal(e.body.data.student.currentEnrollment.displayName, 'Grade 1 - B');
    assert.equal(e.body.data.student.guardians[0].name, 'Sunita Verma');
    assert.equal(e.body.data.student.admissionId, id);

    assert.equal((await api('post', `/admissions/${id}/enroll`, T.adminA).send({})).body.error.code, 'ADMISSION_ENROLLED');
    assert.equal((await api('delete', `/admissions/${id}`, T.adminA)).body.error.code, 'ADMISSION_ENROLLED');
  });

  test('sibling application reuses the existing parent', async () => {
    const r = await api('post', '/admissions', T.adminA).send({ ...application(), status: 'applied', applicant: { firstName: 'Anaya', gender: 'female' } });
    const id = r.body.data._id;
    await api('post', `/admissions/${id}/status`, T.adminA).send({ status: 'approved' });
    const dup = await api('post', `/admissions/${id}/enroll`, T.adminA).send({});
    assert.equal(dup.body.error.code, 'DUPLICATE_GUARDIAN');
    const guardianId = dup.body.error.details.matches[0].id;
    const ok = await api('post', `/admissions/${id}/enroll`, T.adminA).send({ guardianId });
    expectStatus(ok, 201);
    assert.equal(ok.body.data.student.campusId, ids.mainA);
    const parent = await api('get', `/parents/${guardianId}`, T.adminA);
    assert.equal(parent.body.data.children.length, 2);
  });

  test('list, search, summary and follow-ups', async () => {
    const r = await api('post', '/admissions', T.adminA).send({ ...application(), applicant: { firstName: 'Zoya', gender: 'female' }, guardian: { name: 'Farah', phone: '+91 97777 00000' }, followUpDate: '2026-01-01' });
    expectStatus(r, 201);
    const due = await api('get', '/admissions?followUpDue=true', T.adminA);
    assert.deepEqual(due.body.data.map((a) => a.applicantName), ['Zoya']);
    const byPhone = await api('get', '/admissions?search=97777', T.adminA);
    assert.equal(byPhone.body.meta.total, 1);
    const sum = await api('get', `/admissions/summary?sessionId=${ids.a.s1}`, T.adminA);
    assert.deepEqual(sum.body.data.byStatus, { enrolled: 2, enquiry: 1 });
    expectStatus(await api('patch', `/admissions/${r.body.data._id}`, T.adminA).send({ guardian: { email: 'farah@family.test' } }), 200);
    expectStatus(await api('delete', `/admissions/${r.body.data._id}`, T.adminA), 200);
    expectStatus(await api('get', '/admissions', T.teacherA), 403);
  });

  test('admissions require the module in the plan', async () => {
    const r = await api('get', '/admissions', T.ownerNoadm);
    assert.equal(r.body.error.code, 'MODULE_NOT_ENABLED');
  });
});

describe('staff', () => {
  test('add staff with an employee record', async () => {
    const r = await api('post', '/staff', T.adminA).send({
      name: 'Neha Kapoor',
      email: 'neha@ppl-a.test',
      roles: ['teacher'],
      profile: { department: 'Science', designation: 'PGT Physics', joiningDate: '2024-06-01', employmentType: 'full_time' },
    });
    expectStatus(r, 201);
    assert.equal(r.body.data.isNewUser, true);
    assert.equal(r.body.data.staff.profile.employeeCode, 'EMP0001');
    ids.neha = r.body.data.staff.id;

    const dup = await api('post', '/staff', T.adminA).send({ name: 'Dup Code', email: 'dup@ppl-a.test', roles: ['staff'], profile: { employeeCode: 'EMP0001' } });
    assert.equal(dup.body.error.code, 'EMPLOYEE_CODE_TAKEN');
    assert.equal(await User.countDocuments({ email: 'dup@ppl-a.test' }), 0, 'no user left behind');
  });

  test('list, filter, detail with teaching, and profile updates', async () => {
    const list = await api('get', '/staff?department=science', T.principalA);
    expectStatus(list, 200);
    assert.deepEqual(list.body.data.map((s) => s.user.name), ['Neha Kapoor']);
    const all = await api('get', '/staff', T.adminA);
    assert.ok(all.body.data.some((s) => s.id === M.teacherA && s.profile === null));
    assert.ok(!all.body.data.some((s) => s.user.email === 'rakesh@family.test'), 'parents are not staff');

    const detail = await api('get', `/staff/${M.teacherA}`, T.adminA);
    assert.equal(detail.body.data.teaching.subjects.length, 1);

    const put = await api('put', `/staff/${M.teacherA}/profile`, T.adminA).send({ department: 'Mathematics', designation: 'PRT' });
    expectStatus(put, 200);
    assert.equal(put.body.data.profile.employeeCode, 'EMP0002');
    const exited = await api('put', `/staff/${M.teacherA}/profile`, T.adminA).send({ employmentStatus: 'exited' });
    assert.ok(exited.body.data.profile.exitDate);
    const opts = await api('get', '/staff/options', T.adminA);
    assert.deepEqual(opts.body.data.departments, ['Mathematics', 'Science']);
  });

  test('permissions and visibility', async () => {
    expectStatus(await api('get', '/staff', T.teacherA), 403);
    expectStatus(await api('post', '/staff', T.principalA).send({ name: 'No Way', email: 'noway@ppl-a.test', roles: ['staff'] }), 403);
    expectStatus(await api('put', `/staff/${M.teacherA}/profile`, T.principalA).send({ department: 'X' }), 403);
    expectStatus(await api('get', `/staff/${M.teacherA}`, T.ownerB), 404);
    // East admin sees unrestricted staff but not staff limited to another campus.
    const mainOnly = await api('post', '/staff', T.adminA).send({ name: 'Main Clerk', email: 'clerk@ppl-a.test', roles: ['staff'], campusIds: [ids.mainA] });
    expectStatus(mainOnly, 201);
    expectStatus(await api('get', `/staff/${mainOnly.body.data.staff.id}`, T.eastAdminA), 404);
  });

  test('removing a member removes their employee record', async () => {
    expectStatus(await api('delete', `/members/${ids.neha}`, T.adminA), 200);
    assert.equal(await StaffProfile.countDocuments({ schoolId: S.a._id, membershipId: ids.neha }), 0);
  });
});
