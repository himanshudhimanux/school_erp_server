import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, teardownDb, createUser, createSchool, createPlan, addMember, createApp, PASSWORD, Campus, Membership } from './helpers.js';

const { devOutbox } = await import('../src/services/mail.service.js');
const { Role } = await import('../src/modules/roles/role.model.js');

let app;
const S = {};
const T = {}; // tokens

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email, password = PASSWORD) => (await request(app).post('/api/v1/auth/login').send({ email, password })).body.data.accessToken;
const lastMailToken = (to) => [...devOutbox].reverse().find((m) => m.to === to)?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
const api = (method, path, token) => request(app)[method](`/api/v1${path}`).set(bearer(token));

before(async () => {
  await setupDb();
  app = createApp();
  const limited = await createPlan('limited', { limits: { maxCampuses: 2, maxUsers: 8 } });
  S.a = await createSchool('setup-a', { plan: limited });
  S.b = await createSchool('setup-b');

  const users = {
    ownerA: ['owner@setup-a.test', S.a, ['school_owner']],
    adminA: ['admin@setup-a.test', S.a, ['school_admin']],
    teacherA: ['teacher@setup-a.test', S.a, ['teacher']],
    ownerB: ['owner@setup-b.test', S.b, ['school_owner']],
  };
  for (const [key, [email, school, roles]] of Object.entries(users)) {
    const u = await createUser(email);
    await addMember(school, u, roles);
    T[key] = await tokenFor(email);
  }
});
after(teardownDb);

describe('school profile and settings', () => {
  test('admin updates profile and settings; nested partial updates keep other values', async () => {
    const r = await api('patch', '/school', T.adminA).send({ phone: '9999999999', address: { city: 'Delhi' }, timezone: 'Asia/Kolkata' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.address.city, 'Delhi');
    assert.equal(r.body.data.address.country, 'India');

    const s1 = await api('patch', '/school/settings', T.adminA).send({ branding: { primaryColor: '#16A34A' } });
    assert.equal(s1.status, 200);
    const s2 = await api('patch', '/school/settings', T.adminA).send({ dateFormat: 'YYYY-MM-DD' });
    assert.equal(s2.body.data.branding.primaryColor, '#16A34A');
    assert.equal(s2.body.data.dateFormat, 'YYYY-MM-DD');
    assert.equal(s2.body.data.academicYearStartMonth, 4);
  });

  test('school cannot change its own code or status; invalid values rejected', async () => {
    assert.equal((await api('patch', '/school', T.ownerA).send({ code: 'hijack' })).status, 422);
    assert.equal((await api('patch', '/school', T.ownerA).send({ status: 'active' })).status, 422);
    assert.equal((await api('patch', '/school', T.ownerA).send({ timezone: 'Mars/Base' })).status, 422);
    assert.equal((await api('patch', '/school/settings', T.ownerA).send({ branding: { primaryColor: 'red' } })).status, 422);
  });

  test('teacher cannot edit school', async () => {
    assert.equal((await api('patch', '/school', T.teacherA).send({ phone: '1' })).status, 403);
    assert.equal((await api('get', '/school', T.teacherA)).status, 200);
  });
});

describe('campuses', () => {
  let northId;

  test('create, list, enforce plan limit', async () => {
    const r = await api('post', '/campuses', T.adminA).send({ name: 'North Campus', code: 'north', address: { city: 'Noida' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.code, 'NORTH');
    assert.equal(r.body.data.isMain, false);
    northId = r.body.data._id;

        const limit = await api('post', '/campuses', T.adminA).send({ name: 'Third', code: 'third' });
    assert.equal(limit.status, 403);
    assert.equal(limit.body.error.code, 'PLAN_LIMIT_REACHED');

    const main = await Campus.findOne({ schoolId: S.a._id, isMain: true });
    const dup = await api('patch', `/campuses/${main._id}`, T.adminA).send({ code: 'NORTH' });
    assert.equal(dup.status, 409, 'campus codes are unique within a school');

    const list = await api('get', '/campuses', T.teacherA);
    assert.equal(list.status, 403, 'teacher has no campuses.read');
    const adminList = await api('get', '/campuses', T.adminA);
    assert.equal(adminList.body.meta.total, 2);
    assert.equal(adminList.body.data[0].isMain, true, 'main campus listed first');
  });

  test('same campus code allowed in another school; cross-tenant ids are not found', async () => {
    const r = await api('post', '/campuses', T.ownerB).send({ name: 'North B', code: 'NORTH' });
    assert.equal(r.status, 201);
    assert.equal((await api('get', `/campuses/${r.body.data._id}`, T.adminA)).status, 404);
    assert.equal((await api('patch', `/campuses/${r.body.data._id}`, T.adminA).send({ name: 'pwned' })).status, 404);
    assert.equal((await api('delete', `/campuses/${r.body.data._id}`, T.adminA)).status, 404);
  });

  test('main campus rules', async () => {
    const main = await Campus.findOne({ schoolId: S.a._id, isMain: true });
    assert.equal((await api('delete', `/campuses/${main._id}`, T.adminA)).body.error.code, 'MAIN_CAMPUS_REQUIRED');
    assert.equal((await api('patch', `/campuses/${main._id}`, T.adminA).send({ status: 'inactive' })).status, 400);
    assert.equal((await api('patch', `/campuses/${main._id}`, T.adminA).send({ isMain: false })).status, 400);

    const sw = await api('patch', `/campuses/${northId}`, T.adminA).send({ isMain: true });
    assert.equal(sw.status, 200);
    assert.equal(await Campus.countDocuments({ schoolId: S.a._id, isMain: true }), 1);
    await api('patch', `/campuses/${main._id}`, T.adminA).send({ isMain: true });
  });

  test('campus-restricted member sees only their campus and cannot create campuses', async () => {
    const u = await createUser('north.admin@setup-a.test');
    await addMember(S.a, u, ['school_admin'], { campusIds: [northId] });
    const t = await tokenFor('north.admin@setup-a.test');
    const list = await api('get', '/campuses', t);
    assert.deepEqual(list.body.data.map((c) => c.code), ['NORTH']);
    const main = await Campus.findOne({ schoolId: S.a._id, isMain: true });
    const denied = await api('get', `/campuses/${main._id}`, t);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'CAMPUS_ACCESS_DENIED');
    assert.equal((await api('post', '/campuses', t).send({ name: 'Extra campus', code: 'X1' })).status, 403);
  });

  test('cannot delete a campus that is some member’s only campus', async () => {
    const r = await api('delete', `/campuses/${northId}`, T.adminA);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CAMPUS_IN_USE');
  });
});

describe('custom roles', () => {
  let feeClerkId;

  test('list includes built-in roles; permission catalogue shows plan state', async () => {
    const r = await api('get', '/roles', T.adminA);
    assert.equal(r.status, 200);
    const owner = r.body.data.find((x) => x.key === 'school_owner');
    assert.equal(owner.isSystem, true);
    assert.equal(owner.memberCount, 1);
    const cat = await api('get', '/roles/permissions', T.adminA);
    const fees = cat.body.data.find((g) => g.module === 'fees');
    assert.equal(fees.enabled, true);
    assert.ok(fees.permissions.find((p) => p.key === 'fees.collect').grantableByYou);
  });

  test('create custom role, assign it, permissions apply immediately', async () => {
    const r = await api('post', '/roles', T.adminA).send({ name: 'Fee Clerk', key: 'fee_clerk', permissions: ['fees.read', 'fees.collect', 'students.read'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    feeClerkId = r.body.data._id;

    const u = await createUser('clerk@setup-a.test');
    await addMember(S.a, u, [], { customRoleIds: [feeClerkId] });
    const t = await tokenFor('clerk@setup-a.test');
    let ctx = await api('get', '/context', t);
    assert.deepEqual(ctx.body.data.permissions.sort(), ['fees.collect', 'fees.read', 'students.read']);
    assert.equal(ctx.body.data.customRoles[0].key, 'fee_clerk');

    await api('patch', `/roles/${feeClerkId}`, T.adminA).send({ permissions: ['fees.read'] });
    ctx = await api('get', '/context', t);
    assert.deepEqual(ctx.body.data.permissions, ['fees.read']);
  });

  test('reserved and duplicate keys rejected; unknown permissions rejected', async () => {
    assert.equal((await api('post', '/roles', T.adminA).send({ name: 'Owner 2', key: 'school_owner', permissions: ['fees.read'] })).status, 409);
    assert.equal((await api('post', '/roles', T.adminA).send({ name: 'Dup', key: 'fee_clerk', permissions: ['fees.read'] })).status, 409);
    assert.equal((await api('post', '/roles', T.adminA).send({ name: 'Bad', key: 'bad_role', permissions: ['transport.read'] })).status, 422);
  });

  test('privilege escalation is blocked', async () => {
    // A role manager who may manage roles/users but has no fee permissions.
    const mgr = await api('post', '/roles', T.ownerA).send({ name: 'Role Manager', key: 'role_manager', permissions: ['roles.read', 'roles.create', 'roles.update', 'users.read', 'users.update'] });
    const u = await createUser('rolemgr@setup-a.test');
    await addMember(S.a, u, [], { customRoleIds: [mgr.body.data._id] });
    const t = await tokenFor('rolemgr@setup-a.test');

    const esc = await api('post', '/roles', t).send({ name: 'Sneaky', key: 'sneaky', permissions: ['fees.refund'] });
    assert.equal(esc.status, 403);
    assert.equal(esc.body.error.code, 'PRIVILEGE_ESCALATION');

    const esc2 = await api('patch', `/roles/${feeClerkId}`, t).send({ permissions: ['fees.read', 'fees.refund'] });
    assert.equal(esc2.body.error.code, 'PRIVILEGE_ESCALATION');

    // Cannot touch a member who is more privileged.
    const adminMember = await Membership.findOne({ schoolId: S.a._id, roles: 'school_admin', campusIds: { $size: 0 } });
    const r = await api('patch', `/members/${adminMember._id}`, t).send({ status: 'suspended' });
    assert.equal(r.status, 403);
  });

  test('role in use cannot be deleted; roles from other schools cannot be assigned', async () => {
    assert.equal((await api('delete', `/roles/${feeClerkId}`, T.adminA)).body.error.code, 'ROLE_IN_USE');
    const other = await Role.create({ schoolId: S.b._id, name: 'B role', key: 'b_role', permissions: ['fees.read'] });
    const r = await api('post', '/members', T.adminA).send({ name: 'Mallory', email: 'mallory@x.test', customRoleIds: [String(other._id)] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_ROLE');
    assert.equal((await api('get', `/roles/${other._id}`, T.adminA)).status, 404);
  });
});

describe('member management', () => {
  let newMemberId;

  test('add a new staff member: setup email, set password, log in', async () => {
    const r = await api('post', '/members', T.adminA).send({ name: 'Neha Accountant', email: 'neha@setup-a.test', roles: ['accountant'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.isNewUser, true);
    newMemberId = r.body.data.member.id;
    const token = lastMailToken('neha@setup-a.test');
    assert.equal((await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'Neha12345' })).status, 200);
    const t = await tokenFor('neha@setup-a.test', 'Neha12345');
    const ctx = await api('get', '/context', t);
    assert.deepEqual(ctx.body.data.roles, ['accountant']);
  });

  test('adding an existing user of another school creates only a membership', async () => {
    const r = await api('post', '/members', T.adminA).send({ name: 'Renamed?', email: 'owner@setup-b.test', roles: ['teacher'] });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.isNewUser, false);
    assert.equal(r.body.data.member.user.name, 'owner', 'global user is not renamed by a school');
    const again = await api('post', '/members', T.adminA).send({ name: 'x y', email: 'owner@setup-b.test', roles: ['teacher'] });
    assert.equal(again.body.error.code, 'ALREADY_MEMBER');
  });

  test('plan seat limit', async () => {
    const r = await api('post', '/members', T.adminA).send({ name: 'One Too Many', email: 'extra@setup-a.test', roles: ['staff'] });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PLAN_LIMIT_REACHED');
  });

  test('parent/student roles cannot be assigned here; campus must belong to school', async () => {
    assert.equal((await api('patch', `/members/${newMemberId}`, T.adminA).send({ roles: ['parent'] })).status, 422);
    const bCampus = await Campus.findOne({ schoolId: S.b._id });
    const r = await api('patch', `/members/${newMemberId}`, T.adminA).send({ campusIds: [String(bCampus._id)] });
    assert.equal(r.body.error.code, 'INVALID_CAMPUS');
  });

  test('owner protections', async () => {
    const ownerMember = await Membership.findOne({ schoolId: S.a._id, roles: 'school_owner' });
    // Admin cannot touch the owner or create owners.
    assert.equal((await api('patch', `/members/${ownerMember._id}`, T.adminA).send({ status: 'suspended' })).body.error.code, 'OWNER_REQUIRED');
    assert.equal((await api('patch', `/members/${newMemberId}`, T.adminA).send({ roles: ['school_owner'] })).body.error.code, 'OWNER_REQUIRED');
    // Nobody can modify their own membership.
    assert.equal((await api('patch', `/members/${ownerMember._id}`, T.ownerA).send({ roles: ['teacher'] })).body.error.code, 'SELF_MODIFICATION');
    // Owner can promote someone to owner, then demote them (another owner remains).
    assert.equal((await api('patch', `/members/${newMemberId}`, T.ownerA).send({ roles: ['school_owner'] })).status, 200);
    assert.equal((await api('patch', `/members/${newMemberId}`, T.ownerA).send({ roles: ['accountant'] })).status, 200);
  });

  test('suspend, reactivate and remove a member', async () => {
    const t = await tokenFor('neha@setup-a.test', 'Neha12345');
    assert.equal((await api('patch', `/members/${newMemberId}`, T.adminA).send({ status: 'suspended' })).status, 200);
    assert.equal((await api('get', '/context', t)).status, 403);
    assert.equal((await api('patch', `/members/${newMemberId}`, T.adminA).send({ status: 'active' })).status, 200);
    assert.equal((await api('get', '/context', t)).status, 200);
    assert.equal((await api('delete', `/members/${newMemberId}`, T.adminA)).status, 200);
    assert.equal((await api('get', '/context', t)).status, 403);
  });

  test('members of other schools are invisible', async () => {
    const bOwner = await Membership.findOne({ schoolId: S.b._id, roles: 'school_owner' });
    assert.equal((await api('get', `/members/${bOwner._id}`, T.adminA)).status, 404);
    assert.equal((await api('patch', `/members/${bOwner._id}`, T.adminA).send({ status: 'suspended' })).status, 404);
  });

  test('tenant subscription view shows usage', async () => {
    const r = await api('get', '/subscription', T.ownerA);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.planCode, 'limited');
    assert.equal(r.body.data.limits.maxUsers, 8);
    assert.equal(r.body.data.usage.maxUsers, 7, 'custom-role-only members also take seats');
    assert.equal(typeof r.body.data.usage.maxUsers, 'number');
    assert.equal(r.body.data.usage.maxCampuses, 2);
    assert.ok(r.body.data.modules.find((m) => m.key === 'fees').enabled);
    assert.equal((await api('get', '/subscription', T.teacherA)).status, 403);
  });

  test('member changes are audited', async () => {
    const r = await api('get', '/audit-logs?entityType=Membership', T.ownerA);
    const actions = r.body.data.map((a) => a.action);
    for (const a of ['member.added', 'member.updated', 'member.removed']) assert.ok(actions.includes(a), `missing ${a}`);
  });
});
