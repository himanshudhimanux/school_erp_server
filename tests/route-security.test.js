import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import request from 'supertest';
import { createApp } from './helpers.js';

/**
 * Every route must carry an explicit authorization check (requirePermission,
 * requireAnyPermission or requirePlatformAdmin), at route or router level. The only exceptions
 * are listed here with the reason they are safe; a new unguarded route fails this test.
 */
const EXCEPTIONS = {
  'auth/auth.routes.js': 'Sign-in, password reset and the caller’s own sessions (rate limited; no school data)',
  'fees/webhook.routes.js': 'Razorpay webhook: authenticated by the school’s webhook signature',
  'notifications/notification.routes.js#twilioWebhookRoutes': 'Twilio receipts: authenticated by X-Twilio-Signature',
  'notifications/notification.routes.js#deviceRoutes': 'Caller registers or removes their own push token',
  'portal/portal.routes.js GET /children': 'Family self-service: the caller’s own linked children only',
  'portal/portal.routes.js GET /student': 'Family self-service: resolved from the caller’s own membership',
  'portal/portal.routes.js GET /notifications': 'The caller’s own inbox',
  'portal/portal.routes.js POST /notifications/read-all': 'The caller’s own inbox',
  'portal/portal.routes.js POST /notifications/:id/read': 'The caller’s own inbox (filtered by membership)',
};

const modulesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/modules');
const routeFiles = fs.readdirSync(modulesDir).flatMap((d) => fs.readdirSync(path.join(modulesDir, d)).filter((f) => f.endsWith('.routes.js')).map((f) => `${d}/${f}`));

async function unguardedRoutes() {
  const out = [];
  for (const file of routeFiles) {
    const mod = await import(pathToFileURL(path.join(modulesDir, file)).href);
    for (const [exportName, router] of Object.entries(mod)) {
      if (!router?.stack) continue;
      let routerGuarded = false;
      for (const layer of router.stack) {
        if (!layer.route) {
          if (layer.handle?.authCheck) routerGuarded = true;
          continue;
        }
        if (routerGuarded || layer.route.stack.some((l) => l.handle.authCheck)) continue;
        for (const method of Object.keys(layer.route.methods)) {
          const keys = [file, `${file}#${exportName}`, `${file} ${method.toUpperCase()} ${layer.route.path}`];
          out.push({ id: keys[2], excepted: keys.some((k) => EXCEPTIONS[k]) });
        }
      }
    }
  }
  return out;
}

describe('route security', () => {
  test('every route has an authorization check or a documented exception', async () => {
    const routes = await unguardedRoutes();
    const missing = routes.filter((r) => !r.excepted).map((r) => r.id);
    assert.deepEqual(missing, [], `Routes without an authorization check:\n${missing.join('\n')}`);
  });

  test('school routes reject anonymous requests', async () => {
    const app = createApp();
    for (const p of ['/students', '/fees/invoices', '/communication/notices', '/reports/overview', '/portal/children', '/platform/analytics', '/devices']) {
      const r = await request(app).get(`/api/v1${p}`);
      assert.equal(r.status, 401, `${p} → ${r.status}`);
    }
  });

  test('security headers are set and the server is not advertised', async () => {
    const r = await request(createApp()).get('/api/v1/health');
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers['strict-transport-security']);
    assert.ok(r.headers['content-security-policy']);
  });

  test('operator injection in the login body is neutralised', async () => {
    const r = await request(createApp()).post('/api/v1/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(r.status, 422);
  });
});

describe('production configuration checks', async () => {
  const { productionIssues } = await import('../src/config/env.js');
  const base = { isProd: true, JWT_ACCESS_SECRET: 'q8Zr2vLp0XwN5sTbYc7KmH1dGf4jA9uE', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), cookieSecure: true, corsOrigins: ['https://erp.example.com'], APP_URL: 'https://erp.example.com', TRUST_PROXY: 1, requireTransactions: true, smtpConfigured: true };

  test('a correct production setup passes', () => {
    assert.deepEqual(productionIssues(base), { errors: [], warnings: [] });
  });
  test('missing encryption key, placeholder secret and insecure cookies stop the server', () => {
    const { errors } = productionIssues({ ...base, DATA_ENCRYPTION_KEY: undefined, JWT_ACCESS_SECRET: 'change-me-to-a-long-random-secret-at-least-32-chars', cookieSecure: false });
    assert.equal(errors.length, 3);
  });
  test('proxy, transactions and localhost CORS produce warnings', () => {
    const { errors, warnings } = productionIssues({ ...base, TRUST_PROXY: 0, requireTransactions: false, corsOrigins: ['http://localhost:5173'] });
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 3);
  });
  test('development is never blocked', () => {
    assert.deepEqual(productionIssues({ ...base, isProd: false, DATA_ENCRYPTION_KEY: undefined }), { errors: [], warnings: [] });
  });
});
