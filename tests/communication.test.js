import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/* ---------- fake Twilio + Google OAuth + FCM, started before the app reads its environment ---------- */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const sent = { sms: [], push: [], oauth: 0 };
let smsCounter = 0;
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => resolve(b));
});
const mock = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const reply = (status, json) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  if (req.url === '/2010-04-01/Accounts/ACtest/Messages.json') {
    const auth = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
    if (auth !== 'ACtest:twilio-secret') return reply(401, { code: 20003, message: 'Authenticate' });
    const p = Object.fromEntries(new URLSearchParams(body));
    if (p.To.endsWith('+911111111111')) return reply(400, { code: 21211, message: "The 'To' number is not valid" });
    if (p.To.endsWith('+912222222222')) return reply(503, { message: 'Service unavailable' });
    smsCounter += 1;
    sent.sms.push(p);
    return reply(201, { sid: `SM${smsCounter}`, status: 'queued' });
  }
  if (req.url === '/token') {
    const assertion = new URLSearchParams(body).get('assertion');
    try {
      jwt.verify(assertion, publicKey, { algorithms: ['RS256'] });
    } catch {
      return reply(400, { error: 'invalid_grant' });
    }
    sent.oauth += 1;
    return reply(200, { access_token: 'google-token', expires_in: 3600 });
  }
  if (req.url === '/v1/projects/demo-project/messages:send') {
    if (req.headers.authorization !== 'Bearer google-token') return reply(401, { error: { status: 'UNAUTHENTICATED' } });
    const { message } = JSON.parse(body);
    if (message.token.startsWith('dead')) return reply(404, { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } });
    sent.push.push(message);
    return reply(200, { name: `projects/demo-project/messages/${sent.push.length}` });
  }
  return reply(404, {});
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'twilio-secret';
process.env.TWILIO_SMS_FROM = '+15005550006';
process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
process.env.TWILIO_API_URL = MOCK;
process.env.PUBLIC_API_URL = 'https://api.school.test';
process.env.FCM_API_URL = MOCK;
process.env.FCM_SERVICE_ACCOUNT = Buffer.from(JSON.stringify({ project_id: 'demo-project', client_email: 'push@demo-project.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${MOCK}/token` })).toString('base64');

const { setupDb, teardownDb, createUser, createSchool, addMember, createApp, PASSWORD, Campus } = await import('./helpers.js');
const { AcademicSession, SchoolClass, Section } = await import('../src/modules/academics/academics.models.js');
const { Student, Enrollment } = await import('../src/modules/students/student.model.js');
const { Guardian, StudentGuardian } = await import('../src/modules/parents/guardian.model.js');
const { Notification } = await import('../src/modules/notifications/notification.model.js');
const { DeviceToken } = await import('../src/modules/notifications/device.model.js');
const { Announcement } = await import('../src/modules/communication/announcement.model.js');
const { runScheduledAnnouncements } = await import('../src/modules/communication/communication.service.js');
const { processDeliveryQueue, settleBackgroundWork } = await import('../src/modules/notifications/notification.service.js');
const { toE164 } = await import('../src/services/twilio.service.js');
const { todayIn, addDays, formatDateOnly } = await import('../src/utils/dates.js');

let app;
const S = {};
const T = {};
const M = {};
const U = {};
const ids = {};
const today = todayIn('UTC');
const TODAY = formatDateOnly(today);
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
const api = (method, path, token) => request(app)[method](`/api/v1${path}`).set(bearer(token));
const expectStatus = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));
const settle = async () => {
  await settleBackgroundWork();
  await processDeliveryQueue();
};
const twilioSign = (url, params) => createHmac('sha1', 'twilio-secret').update(url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('')).digest('base64');

before(async () => {
  await setupDb();
  app = createApp();
  S.a = await createSchool('com-a', { timezone: 'UTC', settings: { attendance: { weeklyOffDays: [] } } });
  S.b = await createSchool('com-b');
  const schoolId = S.a._id;
  const main = await Campus.findOne({ schoolId, isMain: true });
  const north = await Campus.create({ schoolId, name: 'North Campus', code: 'NORTH' });
  Object.assign(ids, { main: String(main._id), north: String(north._id) });

  const session = await AcademicSession.create({ schoolId, name: 'Current', startDate: addDays(today, -100), endDate: addDays(today, 200), status: 'active', isCurrent: true });
  const [g1, g2] = await SchoolClass.create([
    { schoolId, name: 'Grade 1', code: 'G1', order: 1 },
    { schoolId, name: 'Grade 2', code: 'G2', order: 2 },
  ]);
  const people = {
    admin: ['admin@com-a.test', S.a, ['school_admin']],
    accountant: ['accounts@com-a.test', S.a, ['accountant']],
    teacher: ['teacher@com-a.test', S.a, ['teacher', 'parent']], // also a parent of Bala
    northPrincipal: ['north@com-a.test', S.a, ['principal'], { campusIds: [north._id] }],
    parent: ['parent@com-a.test', S.a, ['parent']],
    parent2: ['parent2@com-a.test', S.a, ['parent']],
    student: ['student@com-a.test', S.a, ['student']],
    ownerB: ['owner@com-b.test', S.b, ['school_owner']],
  };
  for (const [key, [email, school, roles, extra]] of Object.entries(people)) {
    U[key] = await createUser(email, { name: key, phone: key === 'admin' ? '9876500001' : null });
    M[key] = String((await addMember(school, U[key], roles, extra))._id);
    T[key] = await tokenFor(email);
  }

  const secA = await Section.create({ schoolId, sessionId: session._id, classId: g1._id, campusId: main._id, name: 'A', classTeacherId: M.teacher });
  const secB = await Section.create({ schoolId, sessionId: session._id, classId: g2._id, campusId: main._id, name: 'A' });
  const secN = await Section.create({ schoolId, sessionId: session._id, classId: g1._id, campusId: north._id, name: 'N' });
  Object.assign(ids, { g1: String(g1._id), g2: String(g2._id), secA: String(secA._id), secB: String(secB._id), secN: String(secN._id) });

  const mk = async (firstName, section, extra = {}) => {
    const s = await Student.create({ schoolId, admissionNo: `C-${firstName.toUpperCase().replace(/\W/g, '')}`, firstName, lastName: 'K', gender: 'female', campusId: section.campusId, admissionDate: today, ...extra });
    await Enrollment.create({ schoolId, studentId: s._id, sessionId: session._id, classId: section.classId, sectionId: section._id, campusId: section.campusId, rollNo: Math.floor(Math.random() * 9000) + 1 });
    return String(s._id);
  };
  ids.asha = await mk('Asha', secA, { membershipId: M.student });
  ids.bala = await mk('Bala', secA);
  ids.chitra = await mk('Chitra', secB);
  ids.neel = await mk('Neel', secN);
  ids.formula = await mk('=HYPERLINK("x")', secB);

  const g = async (name, phone, extra) => (await Guardian.create({ schoolId, name, phone, phoneNormalized: phone, ...extra }))._id;
  const parentG = await g('Parent One', '9876543210', { email: 'parent@com-a.test', membershipId: M.parent });
  const teacherG = await g('Teacher Parent', '9876543211', { membershipId: M.teacher });
  const parent2G = await g('Parent Two', '+911111111111', { membershipId: M.parent2 });
  const northG = await g('North Parent', '+912222222222', {});
  await StudentGuardian.create([
    { schoolId, studentId: ids.asha, guardianId: parentG, relation: 'mother', isPrimary: true },
    { schoolId, studentId: ids.chitra, guardianId: parentG, relation: 'mother', isPrimary: true }, // sibling in Grade 2
    { schoolId, studentId: ids.bala, guardianId: teacherG, relation: 'father', isPrimary: true },
    { schoolId, studentId: ids.formula, guardianId: parent2G, relation: 'father', isPrimary: true },
    { schoolId, studentId: ids.neel, guardianId: northG, relation: 'father', isPrimary: true },
  ]);
});
after(async () => {
  await settleBackgroundWork();
  await teardownDb();
  mock.close();
});

describe('phone numbers', () => {
  test('local numbers get the default country code', () => {
    assert.equal(toE164('98765 43210'), '+919876543210');
    assert.equal(toE164('09876543210'), '+919876543210');
    assert.equal(toE164('+1 (415) 555-0100'), '+14155550100');
    assert.equal(toE164('12'), null);
  });
});

describe('channels and templates', () => {
  test('channel overview reflects configured providers; only admins choose alert channels', async () => {
    const r = await api('get', '/communication/channels', T.teacher);
    expectStatus(r, 200);
    const by = Object.fromEntries(r.body.data.channels.map((c) => [c.channel, c]));
    assert.deepEqual([by.in_app.available, by.email.available, by.sms.available, by.whatsapp.available, by.push.available], [true, false, true, true, true]);
    assert.equal(by.sms.deliveryReceipts, true);
    assert.deepEqual(r.body.data.alertChannels, ['in_app', 'email', 'push']);
    expectStatus(await api('patch', '/communication/channels', T.teacher).send({ alertChannels: ['sms'] }), 403);
    const u = await api('patch', '/communication/channels', T.admin).send({ alertChannels: ['sms', 'push'] });
    expectStatus(u, 200);
    assert.deepEqual(u.body.data.alertChannels, ['in_app', 'sms', 'push']);
    expectStatus(await api('get', '/communication/channels', T.parent), 403);
  });

  test('templates: unknown placeholders are rejected, overrides can be reset', async () => {
    const list = await api('get', '/communication/templates', T.admin);
    assert.equal(list.body.data.length, 6);
    const absent = list.body.data.find((t) => t.key === 'attendance.absent');
    assert.equal(absent.customized, false);
    assert.match(absent.preview.body, /Aarav Sharma/);
    const bad = await api('put', '/communication/templates/attendance.absent', T.admin).send({ title: 'Absent', body: 'Hi {{parent}}, {{student}} is absent' });
    assert.equal(bad.body.error.code, 'UNKNOWN_PLACEHOLDER');
    expectStatus(await api('put', '/communication/templates/attendance.absent', T.teacher).send({ title: 'x', body: 'y' }), 403);
    const ok = await api('put', '/communication/templates/attendance.absent', T.admin).send({ title: '{{student}} absent', body: 'ABSENT: {{student}} of {{class}} on {{date}}. {{school}}' });
    expectStatus(ok, 200);
    assert.equal(ok.body.data.customized, true);
    const reset = await api('delete', '/communication/templates/exam.results', T.admin);
    assert.equal(reset.body.data.customized, false);
    expectStatus(await api('put', '/communication/templates/nope', T.admin).send({ title: 'x', body: 'y' }), 422);
  });
});

describe('delivery', () => {
  test('push devices: register, move between users, remove', async () => {
    const reg = (t, token) => api('post', '/devices', t).send({ token, platform: 'android' });
    expectStatus(await reg(T.parent, 'good-token-0123456789-parent'), 200);
    expectStatus(await reg(T.parent, 'dead-token-0123456789-parent'), 200);
    expectStatus(await reg(T.teacher, 'shared-token-0123456789'), 200);
    expectStatus(await reg(T.admin, 'shared-token-0123456789'), 200);
    const shared = await DeviceToken.findOne({ token: 'shared-token-0123456789' }).lean();
    assert.equal(String(shared.userId), String(U.admin._id));
    const del = await request(app).delete('/api/v1/devices').set(bearer(T.teacher)).send({ token: 'shared-token-0123456789' });
    assert.equal(del.body.data.removed, 0); // not the teacher's any more
    expectStatus(await request(app).post('/api/v1/devices').send({ token: 'x'.repeat(30) }), 401);
  });

  test('absent alert goes out by SMS and push with the school template', async () => {
    const r = await api('put', `/attendance/sections/${ids.secA}`, T.admin).send({ date: TODAY, defaultStatus: 'present', entries: [{ studentId: ids.asha, status: 'absent' }] });
    expectStatus(r, 200);
    await settle();
    const rows = await Notification.find({ schoolId: S.a._id, 'data.studentId': ids.asha, type: 'attendance.absent' }).lean();
    const by = Object.fromEntries(rows.map((n) => [n.channel, n]));
    assert.deepEqual(Object.keys(by).sort(), ['in_app', 'push', 'sms']);
    assert.equal(by.sms.status, 'sent');
    assert.match(by.sms.providerMessageId, /^SM\d+$/);
    const msg = sent.sms.find((m) => m.To === '+919876543210');
    assert.match(msg.Body, /^ABSENT: Asha K of Grade 1 - A on /);
    assert.equal(msg.StatusCallback, 'https://api.school.test/api/v1/webhooks/twilio/status');
    assert.equal(by.push.status, 'sent');
    assert.equal(sent.push.length, 1);
    assert.equal(sent.push[0].token, 'good-token-0123456789-parent');
    assert.equal(sent.push[0].data.type, 'attendance.absent');
    // The dead token was removed when FCM reported it unregistered.
    assert.equal(await DeviceToken.countDocuments({ token: 'dead-token-0123456789-parent' }), 0);
    ids.smsNotification = String(by.sms._id);
    ids.smsSid = by.sms.providerMessageId;
  });

  test('Twilio receipts are signature-checked and only move status forward', async () => {
    const url = 'https://api.school.test/api/v1/webhooks/twilio/status';
    const post = (params, sig) => request(app).post('/api/v1/webhooks/twilio/status').type('form').set('X-Twilio-Signature', sig).send(params);
    const delivered = { MessageSid: ids.smsSid, MessageStatus: 'delivered', AccountSid: 'ACtest' };
    expectStatus(await post(delivered, 'bad-signature'), 403);
    expectStatus(await post(delivered, twilioSign(url, delivered)), 200);
    const late = { MessageSid: ids.smsSid, MessageStatus: 'sent' };
    expectStatus(await post(late, twilioSign(url, late)), 200);
    const n = await Notification.findOne({ schoolId: S.a._id, _id: ids.smsNotification }).lean();
    assert.equal(n.status, 'delivered');
    assert.ok(n.deliveredAt);
  });

  test('rejected numbers fail at once; provider outages retry with backoff; failures can be retried', async () => {
    // Absent alerts for Parent Two (number Twilio rejects).
    await api('put', `/attendance/sections/${ids.secB}`, T.admin).send({ date: TODAY, defaultStatus: 'present', entries: [{ studentId: ids.formula, status: 'absent' }] });
    // ... and for North Parent (provider returns 503).
    await api('put', `/attendance/sections/${ids.secN}`, T.admin).send({ date: TODAY, defaultStatus: 'present', entries: [{ studentId: ids.neel, status: 'absent' }] });
    await settle();
    const rejected = await Notification.findOne({ schoolId: S.a._id, 'data.studentId': ids.formula, channel: 'sms' }).lean();
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error, /^TWILIO_21211/);
    assert.equal(rejected.attempts, 1);
    const outage = await Notification.findOne({ schoolId: S.a._id, 'data.studentId': ids.neel, channel: 'sms' }).lean();
    assert.equal(outage.status, 'queued');
    assert.equal(outage.attempts, 1);
    assert.ok(outage.nextAttemptAt > new Date());

    const history = await api('get', '/communication/notifications?status=retrying', T.admin);
    assert.ok(history.body.data.some((n) => String(n._id) === String(outage._id)));
    expectStatus(await api('post', `/communication/notifications/${rejected._id}/retry`, T.teacher), 403);
    const retry = await api('post', `/communication/notifications/${rejected._id}/retry`, T.admin);
    expectStatus(retry, 200);
    assert.equal(retry.body.data.status, 'failed'); // Twilio still rejects it
    assert.equal((await api('post', `/communication/notifications/${ids.smsNotification}/retry`, T.admin)).body.error.code, 'NOT_RETRYABLE');
    expectStatus(await api('post', `/communication/notifications/${rejected._id}/retry`, T.ownerB), 404);
  });

  test('notification history: filters, status totals, campus limits, staff only', async () => {
    const all = await api('get', '/communication/notifications?channel=sms', T.admin);
    expectStatus(all, 200);
    assert.equal(all.body.meta.total, 3);
    assert.ok(all.body.meta.byStatus.failed >= 1);
    const north = await api('get', '/communication/notifications?channel=sms', T.northPrincipal);
    assert.deepEqual(north.body.data.map((n) => String(n.data.studentId)), [ids.neel]);
    expectStatus(await api('get', '/communication/notifications', T.teacher), 403);
    expectStatus(await api('get', '/communication/notifications', T.parent), 403);
    assert.equal((await api('get', '/communication/notifications', T.ownerB)).body.meta.total, 0);
  });
});

describe('announcements and notices', () => {
  test('teachers draft, only senders send; audience is validated', async () => {
    const draft = await api('post', '/communication/announcements', T.teacher).send({ title: 'Sports day', body: 'Sports day is on Friday.', audience: { scope: 'parents', classIds: [ids.g1] }, channels: ['sms'] });
    expectStatus(draft, 201);
    assert.deepEqual(draft.body.data.channels, ['in_app', 'sms']);
    assert.equal(draft.body.data.audience.classes[0].name, 'Grade 1');
    ids.sports = draft.body.data._id;
    expectStatus(await api('post', `/communication/announcements/${ids.sports}/send`, T.teacher).send({}), 403);
    const bad = await api('post', '/communication/announcements', T.admin).send({ title: 'x', body: 'y', audience: { scope: 'staff', classIds: [ids.g1] } });
    assert.equal(bad.body.error.code, 'INVALID_AUDIENCE');
    expectStatus(await api('post', '/communication/announcements', T.parent).send({ title: 'x', body: 'y', audience: { scope: 'everyone' } }), 403);
    expectStatus(await api('get', '/communication/announcements', T.parent), 403);
  });

  test('sending fans out once per person and records delivery', async () => {
    const r = await api('post', `/communication/announcements/${ids.sports}/send`, T.admin).send({});
    expectStatus(r, 200);
    // Grade 1 parents: Parent One (Asha), Teacher Parent (Bala), North Parent (Neel, north campus).
    assert.deepEqual([r.body.data.status, r.body.data.stats.recipients], ['sent', 3]);
    await settle();
    const rows = await Notification.find({ schoolId: S.a._id, 'data.announcementId': ids.sports }).lean();
    assert.equal(rows.filter((n) => n.channel === 'in_app').length, 2); // North Parent has no app login
    assert.equal(rows.filter((n) => n.channel === 'sms').length, 3);
    const detail = await api('get', `/communication/announcements/${ids.sports}`, T.admin);
    assert.equal(detail.body.data.delivery.in_app.total, 2);
    assert.equal(detail.body.data.delivery.sms.sent, 2);
    assert.equal(detail.body.data.delivery.sms.queued, 1); // provider outage, retrying
    assert.equal((await api('post', `/communication/announcements/${ids.sports}/send`, T.admin).send({})).body.error.code, 'ANNOUNCEMENT_NOT_DRAFT');
    assert.equal((await api('patch', `/communication/announcements/${ids.sports}`, T.admin).send({ title: 'Changed' })).body.error.code, 'ANNOUNCEMENT_NOT_EDITABLE');
    expectStatus(await api('delete', `/communication/announcements/${ids.sports}`, T.admin), 409);
    const inbox = await api('get', '/portal/notifications', T.parent);
    assert.ok(inbox.body.data.some((n) => n.title === 'Sports day'));
  });

  test('"everyone" reaches a staff member who is also a parent only once', async () => {
    const a = await api('post', '/communication/announcements', T.admin).send({ title: 'Holiday', body: 'School closed Monday.', audience: { scope: 'everyone' } });
    const r = await api('post', `/communication/announcements/${a.body.data._id}/send`, T.admin).send({});
    expectStatus(r, 200);
    const teacherRows = await Notification.countDocuments({ schoolId: S.a._id, 'data.announcementId': a.body.data._id, 'recipient.membershipId': M.teacher, channel: 'in_app' });
    assert.equal(teacherRows, 1);
    const studentRow = await Notification.countDocuments({ schoolId: S.a._id, 'data.announcementId': a.body.data._id, 'recipient.membershipId': M.student });
    assert.equal(studentRow, 1);
  });

  test('scheduling: future sends wait for the scheduler; unschedule and cancel', async () => {
    const a = await api('post', '/communication/announcements', T.admin).send({ title: 'PTM', body: 'Parent-teacher meeting.', audience: { scope: 'families', sectionIds: [ids.secB] } });
    const id = a.body.data._id;
    const s = await api('post', `/communication/announcements/${id}/send`, T.admin).send({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(s.body.data.status, 'scheduled');
    assert.equal(await runScheduledAnnouncements(S.a._id), 0);
    await Announcement.updateOne({ schoolId: S.a._id, _id: id }, { scheduledAt: new Date(Date.now() - 1000) });
    assert.equal(await runScheduledAnnouncements(S.a._id), 1);
    const after = await api('get', `/communication/announcements/${id}`, T.admin);
    // Grade 2 / A: Parent One (Chitra) and Parent Two (formula student); students without contact are skipped.
    assert.deepEqual([after.body.data.status, after.body.data.stats.recipients], ['sent', 2]);
    assert.equal(await runScheduledAnnouncements(S.a._id), 0);

    const b = await api('post', '/communication/announcements', T.admin).send({ title: 'Later', body: 'x', audience: { scope: 'staff' } });
    await api('post', `/communication/announcements/${b.body.data._id}/send`, T.admin).send({ scheduledAt: new Date(Date.now() + 7200_000).toISOString() });
    assert.equal((await api('post', `/communication/announcements/${b.body.data._id}/unschedule`, T.admin)).body.data.status, 'draft');
    assert.equal((await api('post', `/communication/announcements/${b.body.data._id}/cancel`, T.admin)).body.data.status, 'cancelled');
    expectStatus(await api('delete', `/communication/announcements/${b.body.data._id}`, T.admin), 200);
  });

  test('campus-restricted staff stay within their campus', async () => {
    const none = await api('post', '/communication/announcements', T.northPrincipal).send({ title: 'x', body: 'y', audience: { scope: 'parents' } });
    assert.equal(none.body.error.code, 'CAMPUS_REQUIRED');
    expectStatus(await api('post', '/communication/announcements', T.northPrincipal).send({ title: 'x', body: 'y', audience: { scope: 'parents' }, campusId: ids.main }), 403);
    const ok = await api('post', '/communication/announcements', T.northPrincipal).send({ title: 'North notice', body: 'North only', kind: 'notice', audience: { scope: 'parents' }, campusId: ids.north });
    expectStatus(ok, 201);
    const sent = await api('post', `/communication/announcements/${ok.body.data._id}/send`, T.northPrincipal).send({});
    assert.equal(sent.body.data.stats.recipients, 1);
    const list = await api('get', '/communication/announcements', T.northPrincipal);
    assert.deepEqual(list.body.data.map((a) => a.title), ['North notice']);
    expectStatus(await api('get', `/communication/announcements/${ids.sports}`, T.northPrincipal), 404);
  });

  test('notice board shows each person only the notices meant for them', async () => {
    const make = async (title, audience, extra = {}) => {
      const a = await api('post', '/communication/announcements', T.admin).send({ kind: 'notice', title, body: title, audience, ...extra });
      await api('post', `/communication/announcements/${a.body.data._id}/send`, T.admin).send({});
      return a.body.data._id;
    };
    await make('Grade 2 notice', { scope: 'parents', classIds: [ids.g2] });
    await make('Staff notice', { scope: 'staff' }, { pinned: true });
    const expired = await make('Old notice', { scope: 'everyone' });
    await make('Students notice', { scope: 'students', sectionIds: [ids.secA] });
    await Announcement.updateOne({ schoolId: S.a._id, _id: expired }, { expiresAt: new Date(Date.now() - 1000) });

    const titles = async (t) => (await api('get', '/communication/notices', t)).body.data.map((n) => n.title);
    assert.deepEqual((await titles(T.parent)).sort(), ['Grade 2 notice']); // Chitra is in Grade 2
    assert.deepEqual(await titles(T.parent2), ['Grade 2 notice']);
    assert.deepEqual((await titles(T.teacher))[0], 'Staff notice'); // pinned first; the teacher's child is in Grade 1
    assert.ok(!(await titles(T.teacher)).includes('Grade 2 notice'));
    assert.deepEqual(await titles(T.student), ['Students notice']);
    assert.ok(!(await titles(T.northPrincipal)).includes('North notice')); // parents-only notice
    assert.deepEqual(await titles(T.ownerB), []);
  });
});

describe('reports', () => {
  test('overview includes only the sections the caller may see', async () => {
    const admin = await api('get', '/reports/overview', T.admin);
    expectStatus(admin, 200);
    for (const k of ['students', 'staff', 'attendance', 'fees', 'exams', 'library', 'hostel', 'communication']) assert.ok(admin.body.data[k], `missing ${k}`);
    assert.equal(admin.body.data.students.active, 5);
    assert.deepEqual(admin.body.data.students.byClass.map((c) => [c.name, c.students]), [['Grade 1', 3], ['Grade 2', 2]]);
    assert.equal(admin.body.data.attendance.today.absent, 3);
    assert.equal(admin.body.data.fees.months.length, 12);
    assert.ok(admin.body.data.communication.byChannel.sms);

    const accountant = await api('get', '/reports/overview', T.accountant);
    expectStatus(accountant, 200);
    assert.ok(accountant.body.data.fees && accountant.body.data.students);
    assert.equal(accountant.body.data.attendance, undefined);
    assert.equal(accountant.body.data.exams, undefined);

    const north = await api('get', '/reports/overview', T.northPrincipal);
    assert.equal(north.body.data.students.active, 1);
    expectStatus(await api('get', '/reports/overview', T.teacher), 403);
    expectStatus(await api('get', '/reports/overview', T.parent), 403);
  });

  test('CSV exports: escaping, permissions, validation and tenant isolation', async () => {
    const cat = await api('get', '/reports/exports', T.accountant);
    const avail = Object.fromEntries(cat.body.data.map((e) => [e.key, e.available]));
    assert.deepEqual([avail.students, avail['fee-payments'], avail.attendance, avail.staff], [true, true, false, false]);

    const csv = await api('get', '/reports/exports/students', T.admin);
    expectStatus(csv, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /attachment; filename="students-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.ok(csv.text.startsWith('﻿Admission No,Name,'));
    const lines = csv.text.trim().split('\r\n');
    assert.equal(lines.length, 6);
    assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"") K"`)), 'formula must be neutralised');

    const att = await api('get', `/reports/exports/attendance?from=${TODAY}&to=${TODAY}&classId=${ids.g1}`, T.admin);
    expectStatus(att, 200);
    const attLines = att.text.trim().split('\r\n');
    assert.equal(attLines.length, 4); // header + Asha, Bala, Neel
    // Days marked, present, late, absent, leave, % — Asha was absent on the one marked day.
    assert.ok(attLines.find((l) => l.includes('Asha K')).endsWith(',1,0,0,1,0,0'));
    assert.ok(attLines.find((l) => l.includes('Bala K')).endsWith(',1,1,0,0,0,100'));
    expectStatus(await api('get', '/reports/exports/attendance', T.admin), 422);
    expectStatus(await api('get', `/reports/exports/attendance?from=${TODAY}&to=${TODAY}`, T.accountant), 403);
    expectStatus(await api('get', `/reports/exports/fee-payments?from=${TODAY}&to=${TODAY}`, T.accountant), 200);
    expectStatus(await api('get', '/reports/exports/students?bogus=1', T.admin), 422);

    const northCsv = await api('get', '/reports/exports/students', T.northPrincipal);
    assert.equal(northCsv.text.trim().split('\r\n').length, 2);
    const other = await api('get', '/reports/exports/students', T.ownerB);
    assert.equal(other.text.trim().split('\r\n').length, 1);
  });
});
