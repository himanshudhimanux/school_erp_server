import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* ---------- fake Brevo API, started before the app reads its environment ---------- */
const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const reply = (status, json) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method !== 'POST' || req.url !== '/v3/smtp/email') return reply(404, {});
    if (req.headers['api-key'] !== 'xkeysib-test') return reply(401, { code: 'unauthorized', message: 'Key not found' });
    const msg = JSON.parse(body);
    if (msg.to[0].email === 'invalid@bounce.test') return reply(400, { code: 'invalid_parameter', message: 'email is not valid in to' });
    if (msg.to[0].email === 'busy@outage.test') return reply(503, { code: 'internal_error', message: 'Try again' });
    received.push(msg);
    return reply(201, { messageId: `<msg-${received.length}@smtp-relay.mailin.fr>` });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/school_erp_test';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.LOG_LEVEL = 'silent';
process.env.BREVO_API_KEY = 'xkeysib-test';
process.env.BREVO_API_URL = `http://127.0.0.1:${mock.address().port}/v3`;
process.env.MAIL_FROM = 'School ERP <schoolerp.alerts@gmail.com>';

const { sendMail, sendPasswordResetEmail, parseSender, devOutbox } = await import('../src/services/mail.service.js');

after(() => mock.close());

describe('email through Brevo', () => {
  test('sender parsing: "Name <address>" or a bare address', () => {
    assert.deepEqual(parseSender('School ERP <a@gmail.com>'), { name: 'School ERP', email: 'a@gmail.com' });
    assert.deepEqual(parseSender('"Green Valley School" <office@gv.in>'), { name: 'Green Valley School', email: 'office@gv.in' });
    assert.deepEqual(parseSender('a@gmail.com'), { email: 'a@gmail.com' });
  });

  test('sends with the API key and a plain mailbox as sender, and returns the Brevo message id', async () => {
    const r = await sendMail({ to: 'parent@school.test', subject: 'Hello', text: 'Body text' });
    assert.deepEqual(r, { delivered: true, messageId: '<msg-1@smtp-relay.mailin.fr>' });
    assert.deepEqual(received[0], { sender: { name: 'School ERP', email: 'schoolerp.alerts@gmail.com' }, to: [{ email: 'parent@school.test' }], subject: 'Hello', textContent: 'Body text' });
    assert.equal(devOutbox.length, 0, 'nothing goes to the dev outbox when Brevo is configured');
  });

  test('account emails carry the link', async () => {
    const r = await sendPasswordResetEmail({ name: 'Asha', email: 'asha@school.test' }, 'tok/en');
    assert.equal(r.delivered, true);
    const last = received.at(-1);
    assert.equal(last.subject, 'Reset your password');
    assert.match(last.textContent, /\/reset-password\?token=tok%2Fen/);
  });

  test('a rejected message is a permanent error; an outage can be retried', async () => {
    await assert.rejects(sendMail({ to: 'invalid@bounce.test', subject: 'x', text: 'y' }), (err) => err.code === 'BREVO_INVALID_PARAMETER' && err.permanent === true);
    await assert.rejects(sendMail({ to: 'busy@outage.test', subject: 'x', text: 'y' }), (err) => err.code === 'BREVO_INTERNAL_ERROR' && err.permanent === false);
  });

  test('welcome emails: existing accounts get an access email; a refused email is reported, not thrown', async () => {
    const { welcomeToSchool, welcomeMessage } = await import('../src/modules/memberships/welcome.service.js');
    const ok = await welcomeToSchool({ name: 'Ravi', email: 'ravi@school.test' }, 'Green Valley', { isNew: false, role: 'teacher' });
    assert.deepEqual(ok, { emailDelivered: true, emailError: null, setupEmailDelivered: null });
    assert.equal(received.at(-1).subject, 'You now have access to Green Valley');
    assert.match(received.at(-1).textContent, /as a staff member/);
    assert.match(welcomeMessage({ isNew: false, ...ok }), /emailed that they now have access/);

    const refused = await welcomeToSchool({ name: 'Bad', email: 'invalid@bounce.test' }, 'Green Valley', { isNew: false, role: 'school_owner' });
    assert.equal(refused.emailDelivered, false);
    assert.match(refused.emailError, /^BREVO_INVALID_PARAMETER: /);
    assert.match(welcomeMessage({ isNew: false, ...refused }), /could not be sent \(BREVO_INVALID_PARAMETER/);
  });

  test('an unreachable provider is a temporary error', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    try {
      await assert.rejects(sendMail({ to: 'a@b.test', subject: 'x', text: 'y' }), (err) => err.code === 'PROVIDER_UNREACHABLE' && !err.permanent);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
