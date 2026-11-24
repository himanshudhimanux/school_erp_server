import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* ---------- fake Resend API, started before the app reads its environment ---------- */
const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const reply = (status, json) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method !== 'POST' || req.url !== '/emails') return reply(404, {});
    if (req.headers.authorization !== 'Bearer re_test_key') return reply(401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' });
    const msg = JSON.parse(body);
    if (msg.to[0] === 'invalid@bounce.test') return reply(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field' });
    if (msg.to[0] === 'busy@outage.test') return reply(503, { statusCode: 503, name: 'internal_server_error', message: 'Try again' });
    received.push({ msg, idempotencyKey: req.headers['idempotency-key'] });
    return reply(200, { id: `email-${received.length}` });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/school_erp_test';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.LOG_LEVEL = 'silent';
process.env.RESEND_API_KEY = 're_test_key';
process.env.RESEND_API_URL = `http://127.0.0.1:${mock.address().port}`;
process.env.MAIL_FROM = 'School ERP <no-reply@erp.school.test>';

const { sendMail, sendPasswordResetEmail, devOutbox } = await import('../src/services/mail.service.js');

after(() => mock.close());

describe('email through Resend', () => {
  test('sends with the API key, sender and idempotency key, and returns the Resend id', async () => {
    const r = await sendMail({ to: 'parent@school.test', subject: 'Hello', text: 'Body text', idempotencyKey: 'notification-abc' });
    assert.deepEqual(r, { delivered: true, messageId: 'email-1' });
    assert.deepEqual(received[0].msg, { from: 'School ERP <no-reply@erp.school.test>', to: ['parent@school.test'], subject: 'Hello', text: 'Body text' });
    assert.equal(received[0].idempotencyKey, 'notification-abc');
    assert.equal(devOutbox.length, 0, 'nothing goes to the dev outbox when Resend is configured');
  });

  test('account emails carry the link', async () => {
    const r = await sendPasswordResetEmail({ name: 'Asha', email: 'asha@school.test' }, 'tok/en');
    assert.equal(r.delivered, true);
    const last = received.at(-1);
    assert.equal(last.msg.subject, 'Reset your password');
    assert.match(last.msg.text, /\/reset-password\?token=tok%2Fen/);
    assert.equal(last.idempotencyKey, undefined);
  });

  test('a rejected message is a permanent error; an outage can be retried', async () => {
    await assert.rejects(sendMail({ to: 'invalid@bounce.test', subject: 'x', text: 'y' }), (err) => err.code === 'RESEND_VALIDATION_ERROR' && err.permanent === true);
    await assert.rejects(sendMail({ to: 'busy@outage.test', subject: 'x', text: 'y' }), (err) => err.code === 'RESEND_INTERNAL_SERVER_ERROR' && err.permanent === false);
  });

  test('an unreachable provider is a temporary error', async () => {
    const { env } = await import('../src/config/env.js');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    try {
      await assert.rejects(sendMail({ to: 'a@b.test', subject: 'x', text: 'y' }), (err) => err.code === 'PROVIDER_UNREACHABLE' && !err.permanent);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(env.emailConfigured, true);
  });
});
