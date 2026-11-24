import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupDb, teardownDb, createUser, createSchool, addMember, createApp, PASSWORD, Membership, School } from './helpers.js';

const { devOutbox } = await import('../src/services/mail.service.js');

let app;
const S = {}; // schools
const U = {}; // users

const login = (email, extra = {}) => request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD, ...extra });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const cookieFrom = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('erp_rt='))?.split(';')[0];
const lastMailToken = (to) => {
  const mail = [...devOutbox].reverse().find((m) => m.to === to);
  return mail?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
};

before(async () => {
  await setupDb();
  app = createApp();
  S.a = await createSchool('alpha');
  S.b = await createSchool('beta');
  U.ownerA = await createUser('owner@alpha.test');
  U.teacherA = await createUser('teacher@alpha.test');
  U.ownerB = await createUser('owner@beta.test');
  U.shared = await createUser('shared@both.test');
  U.platform = await createUser('root@platform.test', { platformRole: 'super_admin' });
  await addMember(S.a, U.ownerA, ['school_owner']);
  await addMember(S.a, U.teacherA, ['teacher']);
  await addMember(S.b, U.ownerB, ['school_owner']);
  await addMember(S.a, U.shared, ['teacher']);
  await addMember(S.b, U.shared, ['school_admin']);
});
after(teardownDb);

describe('login', () => {
  test('single-school user gets tenant context automatically (web: refresh token only in cookie)', async () => {
    const res = await login('owner@alpha.test');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.accessToken);
    assert.equal(res.body.data.refreshToken, undefined, 'web clients must not receive the refresh token in JSON');
    assert.ok(cookieFrom(res));
    assert.match(res.headers['set-cookie'].join(';'), /HttpOnly/i);
    assert.equal(res.body.data.tenant.school.code, 'alpha');
    assert.ok(res.body.data.tenant.permissions.includes('fees.collect'));
    assert.equal(res.body.data.user.passwordHash, undefined);
  });

  test('mobile client receives refresh token in body', async () => {
    const res = await login('teacher@alpha.test', { client: 'mobile' });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.refreshToken);
  });

  test('wrong password and unknown email return the same error', async () => {
    const a = await request(app).post('/api/v1/auth/login').send({ email: 'owner@alpha.test', password: 'Wrong12345' });
    const b = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@x.test', password: 'Wrong12345' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(a.body, b.body);
  });

  test('operator injection in login body is rejected', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(res.status, 422);
  });

  test('account locks after repeated failures', async () => {
    await createUser('lockme@alpha.test');
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/v1/auth/login').send({ email: 'lockme@alpha.test', password: 'Wrong12345' });
    }
    const res = await login('lockme@alpha.test');
    assert.equal(res.status, 423);
    assert.equal(res.body.error.code, 'ACCOUNT_LOCKED');
  });
});

describe('multi-school membership and tenant isolation', () => {
  test('multi-school user must select a school; can only select own schools', async () => {
    const res = await login('shared@both.test');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.tenant, null);
    assert.equal(res.body.data.schools.length, 2);
    const token = res.body.data.accessToken;

    const noCtx = await request(app).get('/api/v1/context').set(bearer(token));
    assert.equal(noCtx.status, 403);
    assert.equal(noCtx.body.error.code, 'NO_SCHOOL_SELECTED');

    const selA = await request(app).post('/api/v1/auth/select-school').set(bearer(token)).send({ schoolId: String(S.a._id) });
    assert.equal(selA.status, 200);
    const ctxA = await request(app).get('/api/v1/context').set(bearer(selA.body.data.accessToken));
    assert.equal(ctxA.body.data.school.code, 'alpha');
    assert.deepEqual(ctxA.body.data.roles, ['teacher']);

    const selB = await request(app).post('/api/v1/auth/select-school').set(bearer(token)).send({ schoolId: String(S.b._id) });
    const ctxB = await request(app).get('/api/v1/context').set(bearer(selB.body.data.accessToken));
    assert.equal(ctxB.body.data.school.code, 'beta');
    assert.deepEqual(ctxB.body.data.roles, ['school_admin']);
  });

  test('cannot select a school without membership', async () => {
    const res = await login('owner@alpha.test');
    const sel = await request(app).post('/api/v1/auth/select-school').set(bearer(res.body.data.accessToken)).send({ schoolId: String(S.b._id) });
    assert.equal(sel.status, 403);
    assert.equal(sel.body.error.code, 'TENANT_ACCESS_DENIED');
  });

  test('login with a schoolId the user does not belong to is denied', async () => {
    const res = await login('owner@alpha.test', { schoolId: String(S.b._id) });
    assert.equal(res.status, 403);
  });

  test('client-supplied school id headers/query are ignored', async () => {
    const res = await login('owner@alpha.test');
    const token = res.body.data.accessToken;
    const r = await request(app)
      .get(`/api/v1/school?schoolId=${S.b._id}`)
      .set(bearer(token))
      .set('X-School-Id', String(S.b._id));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.code, 'alpha');
  });

  test('a validly-signed token pointing at another school is still denied (membership re-verified)', async () => {
    const res = await login('owner@alpha.test');
    const decoded = jwt.decode(res.body.data.accessToken);
    const forged = jwt.sign({ sid: decoded.sid, sch: String(S.b._id), typ: 'access' }, process.env.JWT_ACCESS_SECRET, {
      subject: decoded.sub,
      issuer: 'school-erp',
      audience: 'school-erp-api',
      expiresIn: '5m',
    });
    const r = await request(app).get('/api/v1/school').set(bearer(forged));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'TENANT_ACCESS_DENIED');
  });

  test('member list only contains the current school members', async () => {
    const res = await login('owner@alpha.test');
    const r = await request(app).get('/api/v1/members?limit=100').set(bearer(res.body.data.accessToken));
    assert.equal(r.status, 200);
    const emails = r.body.data.map((m) => m.user.email).sort();
    assert.deepEqual(emails, ['owner@alpha.test', 'shared@both.test', 'teacher@alpha.test']);
    assert.equal(r.body.meta.total, 3);
    const search = await request(app).get('/api/v1/members?search=owner').set(bearer(res.body.data.accessToken));
    assert.deepEqual(search.body.data.map((m) => m.user.email), ['owner@alpha.test']);
  });

  test('suspending a membership blocks access immediately', async () => {
    const u = await createUser('temp@alpha.test');
    await addMember(S.a, u, ['teacher']);
    const res = await login('temp@alpha.test');
    const token = res.body.data.accessToken;
    assert.equal((await request(app).get('/api/v1/context').set(bearer(token))).status, 200);
    await Membership.updateOne({ schoolId: S.a._id, userId: u._id }, { status: 'suspended' });
    assert.equal((await request(app).get('/api/v1/context').set(bearer(token))).status, 403);
  });

  test('suspending a school blocks its members', async () => {
    const s = await createSchool('gamma');
    const u = await createUser('owner@gamma.test');
    await addMember(s, u, ['school_owner']);
    const token = (await login('owner@gamma.test')).body.data.accessToken;
    await School.updateOne({ _id: s._id }, { status: 'suspended' });
    assert.equal((await request(app).get('/api/v1/context').set(bearer(token))).status, 403);
  });

  test('platform super admin has no implicit tenant access', async () => {
    const res = await login('root@platform.test');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.platformRole, 'super_admin');
    const r = await request(app).get('/api/v1/school').set(bearer(res.body.data.accessToken));
    assert.equal(r.status, 403);
  });
});

describe('permissions', () => {
  test('teacher cannot list members or audit logs; owner can', async () => {
    const t = (await login('teacher@alpha.test')).body.data.accessToken;
    const o = (await login('owner@alpha.test')).body.data.accessToken;
    const tm = await request(app).get('/api/v1/members').set(bearer(t));
    assert.equal(tm.status, 403);
    assert.equal(tm.body.error.code, 'PERMISSION_DENIED');
    assert.equal((await request(app).get('/api/v1/audit-logs').set(bearer(t))).status, 403);
    assert.equal((await request(app).get('/api/v1/members').set(bearer(o))).status, 200);
    const audit = await request(app).get('/api/v1/audit-logs?action=auth.login').set(bearer(o));
    assert.equal(audit.status, 200);
    assert.ok(audit.body.data.length > 0);
    assert.ok(audit.body.data.every((a) => String(a.schoolId) === String(S.a._id)));
  });

  test('requests without/with bad tokens are rejected', async () => {
    assert.equal((await request(app).get('/api/v1/auth/me')).status, 401);
    const r = await request(app).get('/api/v1/auth/me').set(bearer('not.a.jwt'));
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'INVALID_TOKEN');
  });
});

describe('refresh token rotation', () => {
  test('web cookie refresh rotates; replaying an old token revokes the session', async () => {
    const res = await login('owner@alpha.test');
    const c1 = cookieFrom(res);

    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', c1).send({});
    assert.equal(r1.status, 200);
    const c2 = cookieFrom(r1);
    assert.ok(c2 && c2 !== c1);
    assert.equal(r1.body.data.tenant.school.code, 'alpha', 'refresh keeps the selected school');

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', c1).send({});
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'REFRESH_TOKEN_REUSED');

    // The legitimate (newer) token and access token of that session are dead too.
    assert.equal((await request(app).post('/api/v1/auth/refresh').set('Cookie', c2).send({})).status, 401);
    assert.equal((await request(app).get('/api/v1/auth/me').set(bearer(r1.body.data.accessToken))).status, 401);
  });

  test('mobile refresh via body', async () => {
    const res = await login('teacher@alpha.test', { client: 'mobile' });
    const r = await request(app).post('/api/v1/auth/refresh').send({ client: 'mobile', refreshToken: res.body.data.refreshToken });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.refreshToken);
    assert.notEqual(r.body.data.refreshToken, res.body.data.refreshToken);
  });

  test('concurrent refresh with the same token: exactly one succeeds', async () => {
    const res = await login('teacher@alpha.test', { client: 'mobile' });
    const body = { client: 'mobile', refreshToken: res.body.data.refreshToken };
    const results = await Promise.all([1, 2, 3].map(() => request(app).post('/api/v1/auth/refresh').send(body)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
  });

  test('missing/invalid refresh token', async () => {
    assert.equal((await request(app).post('/api/v1/auth/refresh').send({})).status, 401);
    const r = await request(app).post('/api/v1/auth/refresh').send({ client: 'mobile', refreshToken: 'x'.repeat(64) });
    assert.equal(r.body.error.code, 'INVALID_REFRESH_TOKEN');
  });
});

describe('sessions and logout', () => {
  test('logout revokes the session and its access token', async () => {
    const res = await login('owner@alpha.test');
    const token = res.body.data.accessToken;
    assert.equal((await request(app).post('/api/v1/auth/logout').set(bearer(token))).status, 200);
    assert.equal((await request(app).get('/api/v1/auth/me').set(bearer(token))).status, 401);
    assert.equal((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieFrom(res)).send({})).status, 401);
  });

  test('list and revoke own sessions; logout-all', async () => {
    const s1 = (await login('owner@beta.test')).body.data.accessToken;
    const s2 = (await login('owner@beta.test')).body.data.accessToken;
    const list = await request(app).get('/api/v1/auth/sessions').set(bearer(s1));
    assert.ok(list.body.data.length >= 2);
    const other = list.body.data.find((s) => !s.current);
    assert.equal((await request(app).delete(`/api/v1/auth/sessions/${other.id}`).set(bearer(s1))).status, 200);

    const s3 = (await login('owner@beta.test')).body.data.accessToken;
    const all = await request(app).post('/api/v1/auth/logout-all').set(bearer(s3));
    assert.equal(all.status, 200);
    for (const t of [s1, s2, s3]) assert.equal((await request(app).get('/api/v1/auth/me').set(bearer(t))).status, 401);
  });

  test("cannot revoke another user's session", async () => {
    const a = (await login('owner@alpha.test')).body.data.accessToken;
    const b = (await login('owner@beta.test')).body.data.accessToken;
    const bSid = jwt.decode(b).sid;
    assert.equal((await request(app).delete(`/api/v1/auth/sessions/${bSid}`).set(bearer(a))).status, 404);
    assert.equal((await request(app).get('/api/v1/auth/me').set(bearer(b))).status, 200);
  });
});

describe('password and email flows', () => {
  test('forgot password does not reveal account existence', async () => {
    const a = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'owner@alpha.test' });
    const b = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@nowhere.test' });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
  });

  test('reset password: single use, revokes sessions, new password works', async () => {
    const u = await createUser('reset@alpha.test');
    await addMember(S.a, u, ['teacher']);
    const oldToken = (await login('reset@alpha.test')).body.data.accessToken;

    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'reset@alpha.test' });
    const token = lastMailToken('reset@alpha.test');
    assert.ok(token, 'reset email captured');

    const r = await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'NewPass123' });
    assert.equal(r.status, 200);
    assert.equal((await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'Other1234' })).status, 400);
    assert.equal((await request(app).get('/api/v1/auth/me').set(bearer(oldToken))).status, 401);
    assert.equal((await login('reset@alpha.test')).status, 401);
    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: 'reset@alpha.test', password: 'NewPass123' })).status, 200);
  });

  test('weak passwords are rejected', async () => {
    const r = await request(app).post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(40), password: 'short' });
    assert.equal(r.status, 422);
  });

  test('change password keeps current session, revokes others', async () => {
    await createUser('change@alpha.test');
    const keep = (await login('change@alpha.test')).body.data.accessToken;
    const other = (await login('change@alpha.test')).body.data.accessToken;
    const bad = await request(app).post('/api/v1/auth/change-password').set(bearer(keep)).send({ currentPassword: 'nope', newPassword: 'Changed123' });
    assert.equal(bad.status, 400);
    const r = await request(app).post('/api/v1/auth/change-password').set(bearer(keep)).send({ currentPassword: PASSWORD, newPassword: 'Changed123' });
    assert.equal(r.status, 200);
    assert.equal((await request(app).get('/api/v1/auth/me').set(bearer(keep))).status, 200);
    assert.equal((await request(app).get('/api/v1/auth/me').set(bearer(other))).status, 401);
  });

  test('email verification flow', async () => {
    await createUser('verify@alpha.test', { emailVerifiedAt: null });
    const token = (await login('verify@alpha.test')).body.data.accessToken;
    const me1 = await request(app).get('/api/v1/auth/me').set(bearer(token));
    assert.equal(me1.body.data.user.isEmailVerified, false);

    const send = await request(app).post('/api/v1/auth/resend-verification').set(bearer(token));
    assert.equal(send.status, 200);
    assert.equal(send.body.data.delivered, false, 'reports honestly that SMTP is not configured');
    const vt = lastMailToken('verify@alpha.test');
    assert.equal((await request(app).post('/api/v1/auth/verify-email').send({ token: vt })).status, 200);
    assert.equal((await request(app).post('/api/v1/auth/verify-email').send({ token: vt })).status, 400);

    const me2 = await request(app).get('/api/v1/auth/me').set(bearer(token));
    assert.equal(me2.body.data.user.isEmailVerified, true);
    assert.equal((await request(app).post('/api/v1/auth/resend-verification').set(bearer(token))).status, 400);
  });
});

describe('misc', () => {
  test('health and 404 envelopes', async () => {
    const h = await request(app).get('/api/v1/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.data.db, 'up');
    const nf = await request(app).get('/api/v2/nothing');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.success, false);
    assert.equal(nf.body.error.code, 'NOT_FOUND');
  });

  test('pagination limits are validated', async () => {
    const o = (await login('owner@alpha.test')).body.data.accessToken;
    const r = await request(app).get('/api/v1/members?limit=1000').set(bearer(o));
    assert.equal(r.status, 422);
  });
});
