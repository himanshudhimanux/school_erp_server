import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { setupDb, teardownDb, createUser, createSchool, addMember, createApp, PASSWORD, Campus, Membership } from './helpers.js';

const { devOutbox } = await import('../src/services/mail.service.js');
const { authenticate } = await import('../src/middleware/authenticate.js');
const { requireTenant } = await import('../src/middleware/tenant.js');
const { requirePermission } = await import('../src/middleware/authorize.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

let app;
let probe; // tiny app exposing a plan-gated route, to test entitlement enforcement
let rootToken;

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const login = async (email, password = PASSWORD) => (await request(app).post('/api/v1/auth/login').send({ email, password })).body.data;
const lastMailToken = (to) => [...devOutbox].reverse().find((m) => m.to === to)?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
const P = (path) => `/api/v1/platform${path}`;

before(async () => {
  await setupDb();
  app = createApp();
  probe = express();
  probe.get('/fees', authenticate, requireTenant, requirePermission('fees.read'), (_req, res) => res.json({ ok: true }));
  probe.get('/campuses', authenticate, requireTenant, requirePermission('campuses.read'), (_req, res) => res.json({ ok: true }));
  probe.use(errorHandler);

  await createUser('root@platform.test', { platformRole: 'super_admin' });
  rootToken = (await login('root@platform.test')).accessToken;
});
after(teardownDb);

describe('platform access', () => {
  test('school users cannot reach platform routes', async () => {
    const s = await createSchool('pa-school');
    const u = await createUser('owner@pa.test');
    await addMember(s, u, ['school_owner']);
    const t = (await login('owner@pa.test')).accessToken;
    const r = await request(app).get(P('/schools')).set(bearer(t));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PLATFORM_ADMIN_REQUIRED');
    assert.equal((await request(app).get(P('/schools'))).status, 401);
  });
});

describe('plans', () => {
  let planId;

  test('create, list, update plan; code is immutable', async () => {
    const r = await request(app)
      .post(P('/plans'))
      .set(bearer(rootToken))
      .send({ name: 'Starter', code: 'starter', priceMonthly: 99900, modules: ['attendance', 'fees'], limits: { maxCampuses: 1, maxUsers: 3 }, trialDays: 7 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    planId = r.body.data._id;
    assert.equal(r.body.data.limits.maxStudents, null);

    const dup = await request(app).post(P('/plans')).set(bearer(rootToken)).send({ name: 'Dup plan', code: 'starter' });
    assert.equal(dup.status, 409);

    const bad = await request(app).post(P('/plans')).set(bearer(rootToken)).send({ name: 'Bad', code: 'bad', modules: ['transport'] });
    assert.equal(bad.status, 422, 'unknown module (e.g. transport) is rejected');

    const up = await request(app).patch(P(`/plans/${planId}`)).set(bearer(rootToken)).send({ limits: { maxUsers: 5 } });
    assert.equal(up.status, 200);
    assert.equal(up.body.data.limits.maxUsers, 5);
    assert.equal(up.body.data.limits.maxCampuses, 1, 'partial limits update keeps other limits');
    assert.equal(up.body.data.trialDays, 7, 'partial update does not reset defaults');

    const codeChange = await request(app).patch(P(`/plans/${planId}`)).set(bearer(rootToken)).send({ code: 'other' });
    assert.equal(codeChange.status, 422);

    const list = await request(app).get(P('/plans')).set(bearer(rootToken));
    assert.ok(list.body.data.some((p) => p.code === 'starter'));
  });
});

describe('school onboarding and lifecycle', () => {
  let planBasic;
  let planPro;
  let schoolId;

  before(async () => {
    planBasic = (await request(app).post(P('/plans')).set(bearer(rootToken)).send({ name: 'Basic', code: 'basic', modules: ['attendance'], trialDays: 14, limits: { maxCampuses: 2 } })).body.data;
    planPro = (await request(app).post(P('/plans')).set(bearer(rootToken)).send({ name: 'Pro', code: 'pro', modules: ['attendance', 'fees', 'exams'] })).body.data;
  });

  test('onboards school + main campus + new owner + trial subscription; owner sets password and logs in', async () => {
    const r = await request(app)
      .post(P('/schools'))
      .set(bearer(rootToken))
      .send({
        school: { name: 'Sunrise Academy', code: 'sunrise', type: 'school', timezone: 'Asia/Kolkata', address: { city: 'Jaipur' } },
        owner: { name: 'Asha Owner', email: 'asha@sunrise.test' },
        planId: planBasic._id,
      });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    schoolId = r.body.data.school._id;
    assert.equal(r.body.data.ownerIsNew, true);
    assert.equal(r.body.data.setupEmailDelivered, false);
    assert.equal(r.body.data.subscription.status, 'trialing');
    assert.equal(r.body.data.campus.isMain, true);
    assert.equal(r.body.data.campus.code, 'MAIN');

    // Owner cannot log in until the password is set.
    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: 'asha@sunrise.test', password: PASSWORD })).status, 401);
    const token = lastMailToken('asha@sunrise.test');
    assert.ok(token);
    assert.equal((await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'Sunrise123' })).status, 200);

    const data = await login('asha@sunrise.test', 'Sunrise123');
    assert.equal(data.tenant.school.code, 'sunrise');
    assert.equal(data.tenant.isOwner, true);
    assert.equal(data.tenant.subscription.planCode, 'basic');
    assert.ok(data.tenant.modules.includes('attendance'));
    assert.ok(!data.tenant.modules.includes('fees'));
    assert.ok(data.tenant.permissions.includes('attendance.mark'));
    assert.ok(!data.tenant.permissions.includes('fees.collect'), 'effective permissions are limited by plan');
  });

  test('duplicate school code and inactive plan are rejected', async () => {
    const dup = await request(app)
      .post(P('/schools'))
      .set(bearer(rootToken))
      .send({ school: { name: 'Again', code: 'sunrise' }, owner: { name: 'X Y', email: 'x@y.test' }, planId: planBasic._id });
    assert.equal(dup.status, 409);

    const inactive = (await request(app).post(P('/plans')).set(bearer(rootToken)).send({ name: 'Old', code: 'old', isActive: false })).body.data;
    const r = await request(app)
      .post(P('/schools'))
      .set(bearer(rootToken))
      .send({ school: { name: 'New One', code: 'newone' }, owner: { name: 'X Y', email: 'x@y.test' }, planId: inactive._id });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_PLAN');
  });

  test('existing user can be onboarded as owner of a second school', async () => {
    const r = await request(app)
      .post(P('/schools'))
      .set(bearer(rootToken))
      .send({ school: { name: 'Sunrise Junior', code: 'sunrise-jr', type: 'preschool' }, owner: { name: 'ignored', email: 'asha@sunrise.test' }, planId: planPro._id, trial: false });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.ownerIsNew, false);
    assert.equal(r.body.data.owner.name, 'Asha Owner', 'existing user is not renamed');
    assert.equal(r.body.data.subscription.status, 'active');
    // Existing accounts are told they have access (no set-password link); here email is not configured.
    assert.deepEqual([r.body.data.emailDelivered, r.body.data.emailError, r.body.data.setupEmailDelivered], [false, 'EMAIL_NOT_CONFIGURED', null]);
    assert.match(r.body.message, /Email delivery is not configured/);
    const mail = devOutbox.filter((m) => m.to === 'asha@sunrise.test').at(-1);
    assert.equal(mail.subject, 'You now have access to Sunrise Junior');
    assert.match(mail.text, /as an owner/);
    assert.doesNotMatch(mail.text, /token=/);
    const data = await login('asha@sunrise.test', 'Sunrise123');
    assert.equal(data.schools.length, 2);
  });

  test('list and detail', async () => {
    const list = await request(app).get(P('/schools?search=sunrise')).set(bearer(rootToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.meta.total, 2);
    assert.ok(list.body.data.every((s) => s.subscription.planCode));
    const detail = await request(app).get(P(`/schools/${schoolId}`)).set(bearer(rootToken));
    assert.equal(detail.body.data.usage.maxCampuses, 1);
    assert.equal(detail.body.data.usage.maxUsers, 1);
    assert.equal(detail.body.data.owners[0].user.email, 'asha@sunrise.test');
  });

  test('plan change updates entitlements immediately', async () => {
    const owner = await login('asha@sunrise.test', 'Sunrise123');
    const sel = await request(app).post('/api/v1/auth/select-school').set(bearer(owner.accessToken)).send({ schoolId });
    const t = sel.body.data.accessToken;

    const before = await request(probe).get('/fees').set(bearer(t));
    assert.equal(before.status, 403);
    assert.equal(before.body.error.code, 'MODULE_NOT_ENABLED');

    const r = await request(app).put(P(`/schools/${schoolId}/subscription`)).set(bearer(rootToken)).send({ planId: planPro._id, billingCycle: 'yearly' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.planCode, 'pro');
    assert.equal((await request(probe).get('/fees').set(bearer(t))).status, 200);
  });

  test('per-school module override and expiry', async () => {
    const owner = await login('asha@sunrise.test', 'Sunrise123');
    const t = (await request(app).post('/api/v1/auth/select-school').set(bearer(owner.accessToken)).send({ schoolId })).body.data.accessToken;

    await request(app).patch(P(`/schools/${schoolId}/subscription`)).set(bearer(rootToken)).send({ modules: ['attendance'] });
    assert.equal((await request(probe).get('/fees').set(bearer(t))).body.error.code, 'MODULE_NOT_ENABLED');

    await request(app).patch(P(`/schools/${schoolId}/subscription`)).set(bearer(rootToken)).send({ modules: ['attendance', 'fees'], currentPeriodEnd: '2020-01-01' });
    const expired = await request(probe).get('/fees').set(bearer(t));
    assert.equal(expired.status, 403);
    assert.equal(expired.body.error.code, 'SUBSCRIPTION_INACTIVE');
    assert.equal(expired.body.error.details.subscriptionStatus, 'expired');
    assert.equal((await request(probe).get('/campuses').set(bearer(t))).status, 200, 'core modules stay available');

    const sub = await request(app).get('/api/v1/subscription').set(bearer(t));
    assert.equal(sub.status, 200);
    assert.equal(sub.body.data.status, 'expired');
    assert.equal(sub.body.data.usable, false);

    await request(app).patch(P(`/schools/${schoolId}/subscription`)).set(bearer(rootToken)).send({ currentPeriodEnd: '2099-01-01' });
    assert.equal((await request(probe).get('/fees').set(bearer(t))).status, 200);
  });

  test('suspend and reactivate a school', async () => {
    const owner = await login('asha@sunrise.test', 'Sunrise123');
    const t = (await request(app).post('/api/v1/auth/select-school').set(bearer(owner.accessToken)).send({ schoolId })).body.data.accessToken;
    await request(app).patch(P(`/schools/${schoolId}/status`)).set(bearer(rootToken)).send({ status: 'suspended', reason: 'Non-payment' });
    assert.equal((await request(app).get('/api/v1/school').set(bearer(t))).status, 403);
    const relogin = await login('asha@sunrise.test', 'Sunrise123');
    assert.equal(relogin.schools.length, 1, 'suspended school disappears from the switcher');
    await request(app).patch(P(`/schools/${schoolId}/status`)).set(bearer(rootToken)).send({ status: 'active' });
    assert.equal((await request(app).get('/api/v1/school').set(bearer(t))).status, 200);
  });

  test('platform can edit school and add a recovery owner', async () => {
    const up = await request(app).patch(P(`/schools/${schoolId}`)).set(bearer(rootToken)).send({ address: { state: 'Rajasthan' } });
    assert.equal(up.status, 200);
    assert.equal(up.body.data.address.city, 'Jaipur', 'nested partial update keeps other fields');
    assert.equal(up.body.data.address.state, 'Rajasthan');

    const r = await request(app).post(P(`/schools/${schoolId}/owners`)).set(bearer(rootToken)).send({ name: 'Backup Owner', email: 'backup@sunrise.test' });
    assert.equal(r.status, 201);
    const owners = await Membership.countDocuments({ schoolId, roles: 'school_owner' });
    assert.equal(owners, 2);
  });

  test('plan in use cannot be deleted; unused plan can', async () => {
    assert.equal((await request(app).delete(P(`/plans/${planPro._id}`)).set(bearer(rootToken))).status, 409);
    const tmp = (await request(app).post(P('/plans')).set(bearer(rootToken)).send({ name: 'Tmp', code: 'tmp' })).body.data;
    assert.equal((await request(app).delete(P(`/plans/${tmp._id}`)).set(bearer(rootToken))).status, 200);
  });

  test('platform audit log records platform actions', async () => {
    const r = await request(app).get(P(`/audit-logs?schoolId=${schoolId}`)).set(bearer(rootToken));
    const actions = r.body.data.map((a) => a.action);
    for (const a of ['platform.school_onboarded', 'platform.subscription_assigned', 'platform.school_status_changed', 'platform.owner_added']) {
      assert.ok(actions.includes(a), `missing ${a}`);
    }
    const platformOnly = await request(app).get(P('/audit-logs?platformOnly=true')).set(bearer(rootToken));
    assert.ok(platformOnly.body.data.every((a) => a.schoolId === null));
    assert.ok(platformOnly.body.data.some((a) => a.action === 'platform.plan_created'));
  });

  test('main campus exists for onboarded school', async () => {
    assert.ok(schoolId);
    assert.equal(await Campus.countDocuments({ schoolId, isMain: true }), 1);
  });
});

describe('platform analytics', () => {
  test('counts schools, people and agreed recurring revenue across every school', async () => {
    const { Student } = await import('../src/modules/students/student.model.js');
    const { Subscription } = await import('../src/modules/subscriptions/subscription.model.js');
    const s = await createSchool('pa-analytics', { plan: undefined });
    const campus = await Campus.findOne({ schoolId: s._id });
    await Student.create([1, 2, 3].map((n) => ({ schoolId: s._id, admissionNo: `AN-${n}`, firstName: `Kid${n}`, gender: 'male', campusId: campus._id, admissionDate: new Date() })));
    await Subscription.updateOne({ schoolId: s._id }, { status: 'active', priceAmount: 120000, billingCycle: 'yearly', currentPeriodEnd: new Date(Date.now() + 5 * 86400000) });

    const school = await request(app).get(P('/analytics')).set(bearer((await login('owner@pa.test')).accessToken));
    assert.equal(school.status, 403);

    const r = await request(app).get(P('/analytics')).set(bearer(rootToken));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.ok(d.schools.total >= 2);
    assert.equal(d.people.students, 3);
    assert.equal(d.revenue.monthlyRecurring, 10000); // 1,200.00 a year → 100.00 a month
    const row = d.topSchools.find((x) => x.code === 'pa-analytics');
    assert.deepEqual([row.students, row.subscriptionStatus, row.monthlyRevenue], [3, 'active', 10000]);
    assert.ok(d.attention.some((x) => x.code === 'pa-analytics' && /Renewal due in 5 day/.test(x.reason)));
    assert.equal(d.growth.length, 12);
  });
});
