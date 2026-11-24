/**
 * HTTP load test against a running API, using the accounts created by scripts/seed-load.js.
 *
 *   node scripts/load-test.js [--url=http://127.0.0.1:5000] [--connections=50] [--duration=20]
 *
 * Start the API with a raised rate limit first (otherwise you measure the limiter):
 *   RATE_LIMIT_PER_MINUTE=1000000 JOBS_ENABLED=false npm start
 *
 * Runs each scenario in turn (read-heavy staff pages, a teacher re-submitting a register, the
 * parent portal) and then a mixed scenario with every request at once. Prints latency
 * percentiles, throughput and errors, and writes the full results to load-results/<timestamp>.json.
 */
import fs from 'node:fs';
import autocannon from 'autocannon';

const arg = (name, def) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || def;
const URL_BASE = arg('url', 'http://127.0.0.1:5000').replace(/\/$/, '');
const API = `${URL_BASE}/api/v1`;
const CONNECTIONS = Number(arg('connections', 50));
const DURATION = Number(arg('duration', 20));
const PASSWORD = 'Password@123';

async function login(email) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, client: 'mobile' }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`Login ${email} failed: ${body.error?.code} ${body.error?.message}. Run scripts/seed-load.js first.`);
  let token = body.data.accessToken;
  if (!body.data.tenant) {
    // Select the load-test school when the user belongs to several.
    const schools = body.data.schools || [];
    const school = schools.find((s) => s.code === 'loadtest') || schools[0];
    const sel = await fetch(`${API}/auth/select-school`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ schoolId: school.schoolId || school.id || school._id }) });
    token = (await sel.json()).data.accessToken;
  }
  return token;
}

const get = async (token, path) => {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${body.error?.code}`);
  return body.data;
};

function run(title, requests) {
  return new Promise((resolve, reject) => {
    const instance = autocannon({ url: URL_BASE, connections: CONNECTIONS, duration: DURATION, requests, timeout: 30 }, (err, result) => (err ? reject(err) : resolve({ title, result })));
    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

async function main() {
  let health = null;
  for (let i = 0; i < 30 && !health?.ok; i += 1) {
    health = await fetch(`${API}/health`).catch(() => null);
    if (!health?.ok) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!health?.ok) throw new Error(`API not reachable at ${API}`);
  const [admin, accounts, teacher, parent] = await Promise.all(['admin', 'accounts', 'teacher', 'parent'].map((r) => login(`${r}@loadtest.local`)));

  const structure = await get(admin, '/academics/structure');
  const sectionId = structure.classes[0].sections[0].id;
  const today = new Date().toISOString().slice(0, 10);
  const sheet = await get(teacher, `/attendance/sections/${sectionId}`);
  const children = await get(parent, '/portal/children');
  const studentId = children.children[0].studentId;
  const totalStudents = (await fetch(`${API}/students?limit=1`, { headers: { Authorization: `Bearer ${admin}` } }).then((r) => r.json())).meta.total;
  const markBody = JSON.stringify({ date: sheet.date?.slice?.(0, 10) || today, defaultStatus: 'present', entries: [] });

  const R = (token, path, extra = {}) => ({ method: 'GET', path: `/api/v1${path}`, headers: { Authorization: `Bearer ${token}` }, ...extra });
  const scenarios = [
    ['Staff: student list and search', [R(admin, '/students?limit=20'), R(admin, '/students?limit=20&page=37'), R(admin, '/students?search=Kabir&limit=20'), R(admin, '/students?search=9810000123&limit=20')]],
    ['Staff: dashboards', [R(admin, `/attendance/daily?date=${today}`), R(accounts, '/fees/dashboard'), R(admin, '/reports/overview')]],
    ['Accountant: fee lists', [R(accounts, '/fees/invoices?limit=20'), R(accounts, '/fees/invoices?status=unpaid&limit=20'), R(accounts, '/fees/defaulters?limit=20')]],
    ['Teacher: open and re-submit a register', [R(teacher, `/attendance/sections/${sectionId}`), R(teacher, `/attendance/sections/${sectionId}`, { method: 'PUT', body: markBody, headers: { Authorization: `Bearer ${teacher}`, 'Content-Type': 'application/json' } })]],
    ['Parent portal', [R(parent, '/portal/children'), R(parent, `/portal/fees?studentId=${studentId}`), R(parent, `/portal/attendance?studentId=${studentId}`), R(parent, '/communication/notices')]],
  ];
  scenarios.push(['Mixed: all of the above together', scenarios.flatMap(([, reqs]) => reqs)]);

  console.log(`Target ${API} · ${totalStudents} students in the load-test school · ${CONNECTIONS} connections · ${DURATION}s per scenario\n`);
  const rows = [];
  for (const [title, requests] of scenarios) {
    const { result } = await run(title, requests);
    const errors = result.errors + result.timeouts + result.non2xx;
    rows.push({ scenario: title, requests: result.requests.total, 'req/s': Math.round(result.requests.average), 'p50 ms': result.latency.p50, 'p90 ms': result.latency.p90, 'p99 ms': result.latency.p99, 'max ms': result.latency.max, errors, statusCodes: result.statusCodeStats });
    console.log(`${title.padEnd(42)} ${String(Math.round(result.requests.average)).padStart(6)} req/s  p50 ${String(result.latency.p50).padStart(5)} ms  p90 ${String(result.latency.p90).padStart(5)} ms  p99 ${String(result.latency.p99).padStart(5)} ms  errors ${errors}`);
  }
  fs.mkdirSync('load-results', { recursive: true });
  const file = `load-results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ target: API, students: totalStudents, connections: CONNECTIONS, durationSeconds: DURATION, node: process.version, at: new Date(), rows }, null, 2));
  console.log(`\nFull results: ${file}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
