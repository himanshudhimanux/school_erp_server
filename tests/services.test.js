import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, teardownDb, createUser, createSchool, createPlan, addMember, createApp, PASSWORD, Campus } from './helpers.js';

const { supportsTransactions } = await import('../src/config/db.js');
const { AcademicSession } = await import('../src/modules/academics/academics.models.js');
const { Student } = await import('../src/modules/students/student.model.js');
const { Guardian, StudentGuardian } = await import('../src/modules/parents/guardian.model.js');
const { BookIssue } = await import('../src/modules/library/library.models.js');
const { LedgerEntry } = await import('../src/modules/fees/fee.models.js');
const { todayIn, addDays, formatDateOnly } = await import('../src/utils/dates.js');

// Connect first: some tests are skipped or run depending on transaction support.
await setupDb();
const txOk = supportsTransactions();

let app;
const S = {};
const T = {};
const M = {};
const ids = {};
const today = todayIn('UTC');
const ymd = (d) => formatDateOnly(d);
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
const api = (method, path, token) => request(app)[method](`/api/v1${path}`).set(bearer(token));
const expectStatus = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));

before(async () => {
  app = createApp();
  S.a = await createSchool('svc-a', { timezone: 'UTC', settings: { attendance: { weeklyOffDays: [] } } });
  S.b = await createSchool('svc-b');
  const schoolId = S.a._id;
  const campusId = (await Campus.findOne({ schoolId }))._id;
  await AcademicSession.create({ schoolId, name: 'Current', startDate: addDays(today, -200), endDate: addDays(today, 200), status: 'active', isCurrent: true });
  for (const [key, email, school, roles] of [
    ['admin', 'admin@svc-a.test', S.a, ['school_admin']],
    ['accountant', 'accounts@svc-a.test', S.a, ['accountant']],
    ['teacher', 'teacher@svc-a.test', S.a, ['teacher']],
    ['librarian', 'librarian@svc-a.test', S.a, ['staff']],
    ['parent', 'parent@svc-a.test', S.a, ['parent']],
    ['ownerB', 'owner@svc-b.test', S.b, ['school_owner']],
  ]) {
    const u = await createUser(email, { name: key });
    M[key] = String((await addMember(school, u, roles))._id);
    T[key] = await tokenFor(email);
  }
  const mk = async (firstName, gender) => String((await Student.create({ schoolId, admissionNo: `SV-${firstName}`, firstName, gender, campusId, admissionDate: today }))._id);
  ids.s1 = await mk('Ravi', 'male');
  ids.s2 = await mk('Sita', 'female');
  ids.s3 = await mk('Amit', 'male');
  const g = await Guardian.create({ schoolId, name: 'Parent Ravi', phone: '+919833333333', phoneNormalized: '+919833333333', membershipId: M.parent });
  await StudentGuardian.create({ schoolId, studentId: ids.s1, guardianId: g._id, relation: 'father', isPrimary: true });
});
after(teardownDb);

describe('library', () => {
  test('catalogue and settings', async () => {
    expectStatus(await api('patch', '/library/settings', T.admin).send({ loanDays: 7, finePerDay: 200, maxBooksStudent: 1 }), 200);
    const r = await api('post', '/library/books', T.admin).send({ title: 'Wings of Fire', author: 'A. P. J. Abdul Kalam', category: 'Biography', copies: 2 });
    expectStatus(r, 201);
    ids.book = r.body.data._id;
    ids.book2 = (await api('post', '/library/books', T.admin).send({ title: 'Panchatantra', copies: 1 })).body.data._id;
    const s = await api('get', '/library/books?search=wings', T.teacher);
    assert.equal(s.body.meta.total, 1);
    expectStatus(await api('post', '/library/books', T.teacher).send({ title: 'X', copies: 1 }), 403);
    expectStatus(await api('get', '/library/books', T.parent), 403);
  });

  test('issuing respects copies, limits and duplicates', async () => {
    const i1 = await api('post', '/library/issues', T.librarian).send({ bookId: ids.book, studentId: ids.s1 });
    expectStatus(i1, 201);
    assert.equal(i1.body.data.dueDate, `${ymd(addDays(today, 7))}T00:00:00.000Z`);
    ids.issue1 = i1.body.data._id;
    assert.equal((await api('post', '/library/issues', T.librarian).send({ bookId: ids.book2, studentId: ids.s1 })).body.error.code, 'BORROW_LIMIT');
    await api('patch', '/library/settings', T.admin).send({ maxBooksStudent: 3 });
    assert.equal((await api('post', '/library/issues', T.librarian).send({ bookId: ids.book, studentId: ids.s1 })).body.error.code, 'ALREADY_BORROWED');
    expectStatus(await api('post', '/library/issues', T.librarian).send({ bookId: ids.book, membershipId: M.teacher }), 201);
    assert.equal((await api('post', '/library/issues', T.librarian).send({ bookId: ids.book, studentId: ids.s2 })).body.error.code, 'NO_COPIES_AVAILABLE');
    expectStatus(await api('post', '/library/issues', T.teacher).send({ bookId: ids.book2, studentId: ids.s2 }), 403);
  });

  test('the last copy cannot be lent twice at once', async () => {
    const results = await Promise.all([ids.s2, ids.s3].map((sid) => api('post', '/library/issues', T.librarian).send({ bookId: ids.book2, studentId: sid })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const book = (await api('get', '/library/books?search=Panchatantra', T.admin)).body.data[0];
    assert.equal(book.availableCopies, 0);
  });

  test('late return records a fine; fines can be waived; copies come back', async () => {
    await BookIssue.updateOne({ schoolId: S.a._id, _id: ids.issue1 }, { dueDate: addDays(today, -3) });
    const overdue = await api('get', '/library/issues?status=overdue', T.admin);
    assert.equal(overdue.body.data[0].overdueDays, 3);
    const r = await api('post', `/library/issues/${ids.issue1}/return`, T.librarian).send({});
    expectStatus(r, 200);
    assert.deepEqual([r.body.data.fine, r.body.data.fineStatus], [600, 'pending']);
    assert.equal((await api('post', `/library/issues/${ids.issue1}/return`, T.librarian).send({})).body.error.code, 'LOAN_CLOSED');
    assert.equal((await api('post', `/library/issues/${ids.issue1}/charge-fine`, T.admin)).body.error.code, 'FINE_CATEGORY_REQUIRED');
    const w = await api('post', `/library/issues/${ids.issue1}/waive-fine`, T.admin).send({ reason: 'First time' });
    assert.equal(w.body.data.fineStatus, 'waived');
    const sum = await api('get', '/library/summary', T.admin);
    assert.deepEqual([sum.body.data.titles, sum.body.data.onLoan], [2, 2]);
  });

  test('lost books leave the collection; copy count cannot drop below loans', async () => {
    const loan = (await api('get', `/library/issues?status=issued&bookId=${ids.book2}`, T.admin)).body.data[0];
    const lost = await api('post', `/library/issues/${loan._id}/lost`, T.librarian).send({ charge: 25000 });
    assert.deepEqual([lost.body.data.status, lost.body.data.fine], ['lost', 25000]);
    const book2 = (await api('get', '/library/books?search=Panchatantra', T.admin)).body.data[0];
    assert.deepEqual([book2.totalCopies, book2.availableCopies], [0, 0]);
    assert.equal((await api('patch', `/library/books/${ids.book}`, T.admin).send({ copies: 0 })).body.error.code, 'COPIES_ON_LOAN');
    assert.equal((await api('delete', `/library/books/${ids.book}`, T.admin)).body.error.code, 'BOOK_ON_LOAN');
    const up = await api('patch', `/library/books/${ids.book}`, T.admin).send({ copies: 5 });
    assert.deepEqual([up.body.data.totalCopies, up.body.data.availableCopies], [5, 4]);
  });

  test('fines: waiving on return needs library.update; adding to fees bills exactly once', async () => {
    const { supportsTransactions } = await import('../src/config/db.js');
    // A late loan for Sita (s2), returned by the librarian.
    const loan = await api('post', '/library/issues', T.librarian).send({ bookId: ids.book, studentId: ids.s2 });
    expectStatus(loan, 201);
    await BookIssue.updateOne({ schoolId: S.a._id, _id: loan.body.data._id }, { dueDate: addDays(today, -2) });
    const denied = await api('post', `/library/issues/${loan.body.data._id}/return`, T.librarian).send({ waiveFine: true });
    expectStatus(denied, 403); // the librarian may return books but not waive fines
    const ret = await api('post', `/library/issues/${loan.body.data._id}/return`, T.librarian).send({});
    assert.deepEqual([ret.body.data.fine, ret.body.data.fineStatus], [400, 'pending']);

    const cat = await api('post', '/fees/categories', T.admin).send({ name: 'Library fine', code: 'LIBFINE' });
    expectStatus(cat, 201);
    expectStatus(await api('patch', '/library/settings', T.admin).send({ fineCategoryId: cat.body.data._id }), 200);
    const charge = () => api('post', `/library/issues/${loan.body.data._id}/charge-fine`, T.admin);

    if (!supportsTransactions()) {
      // Invoices need transactions: the failed attempt must leave the fine pending, not "charged".
      expectStatus(await charge(), 503);
      assert.equal((await BookIssue.findOne({ schoolId: S.a._id, _id: loan.body.data._id }).lean()).fineStatus, 'pending');
      return;
    }
    const results = await Promise.all([charge(), charge()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const { FeeInvoice } = await import('../src/modules/fees/fee.models.js');
    assert.equal(await FeeInvoice.countDocuments({ schoolId: S.a._id, studentId: ids.s2, title: /^Library fine/ }), 1, 'one invoice, not two');
    const issue = await BookIssue.findOne({ schoolId: S.a._id, _id: loan.body.data._id }).lean();
    assert.equal(issue.fineStatus, 'charged');
    assert.ok(issue.fineInvoiceId);
    // A charged fine can no longer be waived.
    assert.equal((await api('post', `/library/issues/${loan.body.data._id}/waive-fine`, T.admin).send({ reason: 'Too late' })).body.error.code, 'NO_PENDING_FINE');
  });

  test('parents see their child’s loans; records with loans are protected', async () => {
    await api('post', '/library/issues', T.librarian).send({ bookId: ids.book, studentId: ids.s1 });
    const mine = await api('get', '/portal/library', T.parent);
    expectStatus(mine, 200);
    assert.equal(mine.body.data.current[0].book.title, 'Wings of Fire');
    assert.equal((await api('delete', `/students/${ids.s1}`, T.admin)).body.error.code, 'STUDENT_IN_USE');
    expectStatus(await api('get', `/library/issues?studentId=${ids.s1}`, T.ownerB), 200);
    assert.equal((await api('get', `/library/issues?studentId=${ids.s1}`, T.ownerB)).body.meta.total, 0);
  });
});

describe('inventory', () => {
  test('stock never goes negative and every change is recorded', async () => {
    const r = await api('post', '/inventory/items', T.accountant).send({ name: 'A4 paper (ream)', code: 'a4-ream', unit: 'ream', reorderLevel: 5, openingQuantity: 10 });
    expectStatus(r, 201);
    ids.item = r.body.data._id;
    assert.equal((await api('post', '/inventory/items', T.accountant).send({ name: 'Dup', code: 'A4-REAM' })).body.error.code, 'CODE_TAKEN');
    const out = await api('post', `/inventory/items/${ids.item}/movements`, T.accountant).send({ type: 'out', quantity: 4, issuedTo: 'Grade 3 office' });
    expectStatus(out, 201);
    assert.equal(out.body.data.item.quantity, 6);
    assert.equal((await api('post', `/inventory/items/${ids.item}/movements`, T.accountant).send({ type: 'out', quantity: 7 })).body.error.code, 'INSUFFICIENT_STOCK');
    expectStatus(await api('post', `/inventory/items/${ids.item}/movements`, T.accountant).send({ type: 'adjust', countedQuantity: 5 }), 422);
    const adj = await api('post', `/inventory/items/${ids.item}/movements`, T.accountant).send({ type: 'adjust', countedQuantity: 5, note: 'Stock count' });
    assert.deepEqual([adj.body.data.item.quantity, adj.body.data.item.lowStock, adj.body.data.movement.change], [5, true, -1]);
    const low = await api('get', '/inventory/items?lowStock=true', T.admin);
    assert.equal(low.body.meta.lowStockCount, 1);
    const mv = await api('get', `/inventory/movements?itemId=${ids.item}`, T.admin);
    assert.deepEqual(mv.body.data.map((m) => m.balanceAfter), [5, 6, 10]);
    expectStatus(await api('post', `/inventory/items/${ids.item}/movements`, T.teacher).send({ type: 'out', quantity: 1 }), 403);
    assert.equal((await api('delete', `/inventory/items/${ids.item}`, T.admin)).body.error.code, 'ITEM_HAS_STOCK');
  });

  test('parallel issues cannot oversell', async () => {
    const res = await Promise.all([1, 2, 3].map(() => api('post', `/inventory/items/${ids.item}/movements`, T.accountant).send({ type: 'out', quantity: 2 })));
    assert.equal(res.filter((r) => r.status === 201).length, 2);
    const item = (await api('get', '/inventory/items', T.admin)).body.data.find((i) => i._id === ids.item);
    assert.equal(item.quantity, 1);
  });
});

describe('hostel', () => {
  test('rooms, capacity and allocation rules', async () => {
    const h = await api('post', '/hostels', T.admin).send({ name: 'Boys Hostel A', type: 'boys', wardenId: M.teacher });
    expectStatus(h, 201);
    const room = await api('post', `/hostels/${h.body.data._id}/rooms`, T.admin).send({ number: '101', capacity: 1 });
    ids.room = room.body.data._id;
    assert.equal((await api('post', `/hostels/${h.body.data._id}/rooms`, T.admin).send({ number: '101', capacity: 2 })).body.error.code, 'DUPLICATE');
    const a = await api('post', '/hostels/allocations', T.admin).send({ studentId: ids.s1, roomId: ids.room });
    expectStatus(a, 201);
    ids.alloc = a.body.data._id;
    assert.equal((await api('post', '/hostels/allocations', T.admin).send({ studentId: ids.s2, roomId: ids.room })).body.error.code, 'HOSTEL_GENDER_MISMATCH');
    assert.equal((await api('post', '/hostels/allocations', T.admin).send({ studentId: ids.s3, roomId: ids.room })).body.error.code, 'ROOM_FULL');
    const list = await api('get', '/hostels', T.admin);
    assert.deepEqual([list.body.data[0].occupied, list.body.data[0].capacity, list.body.data[0].warden.name], [1, 1, 'teacher']);
    const portal = await api('get', '/portal/hostel', T.parent);
    assert.equal(portal.body.data.allocation.room.number, '101');
  });

  test('vacating frees the bed; occupied rooms keep their capacity', async () => {
    assert.equal((await api('patch', `/hostels/rooms/${ids.room}`, T.admin).send({ capacity: 0 })).status, 422);
    const v = await api('post', `/hostels/allocations/${ids.alloc}/vacate`, T.admin).send({});
    assert.equal(v.body.data.status, 'ended');
    expectStatus(await api('post', '/hostels/allocations', T.admin).send({ studentId: ids.s3, roomId: ids.room }), 201);
    assert.equal((await api('post', '/hostels/allocations', T.admin).send({ studentId: ids.s3, roomId: ids.room })).body.error.code, 'ALREADY_ALLOCATED');
    assert.equal((await api('delete', `/hostels/rooms/${ids.room}`, T.admin)).body.error.code, 'ROOM_OCCUPIED');
  });
});

describe('hr and payroll', () => {
  test('staff leave with quotas, balances and approvals', async () => {
    const r = await api('post', '/hr/my/leaves', T.teacher).send({ type: 'casual', fromDate: ymd(addDays(today, 5)), toDate: ymd(addDays(today, 7)), reason: 'Family function' });
    expectStatus(r, 201);
    assert.equal(r.body.data.days, 3);
    ids.leave = r.body.data._id;
    assert.equal((await api('post', '/hr/my/leaves', T.teacher).send({ type: 'sick', fromDate: ymd(addDays(today, 6)), toDate: ymd(addDays(today, 6)), reason: 'Overlap' })).body.error.code, 'LEAVE_OVERLAP');
    assert.equal((await api('post', '/hr/my/leaves', T.teacher).send({ type: 'casual', fromDate: ymd(addDays(today, 20)), toDate: ymd(addDays(today, 35)), reason: 'Too long' })).body.error.code, 'INSUFFICIENT_LEAVE');
    const bal = await api('get', '/hr/my/leave-balance', T.teacher);
    assert.deepEqual(bal.body.data.types.find((t) => t.type === 'casual'), { type: 'casual', quota: 12, taken: 0, pending: 3, available: 9 });
    expectStatus(await api('get', '/hr/leaves', T.teacher), 403);
    const ok = await api('post', `/hr/leaves/${ids.leave}/review`, T.admin).send({ status: 'approved' });
    assert.equal(ok.body.data.status, 'approved');
    const own = (await api('post', '/hr/my/leaves', T.admin).send({ type: 'sick', fromDate: ymd(addDays(today, 10)), toDate: ymd(addDays(today, 10)), reason: 'Doctor' })).body.data._id;
    assert.equal((await api('post', `/hr/leaves/${own}/review`, T.admin).send({ status: 'approved' })).body.error.code, 'SELF_APPROVAL');
    expectStatus(await api('get', '/hr/my/leaves', T.parent), 403);
  });

  test('payroll: salaries, unpaid leave deduction, finalize, staff payslips', async () => {
    const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const month = ymd(next).slice(0, 7);
    ids.month = month;
    const days = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    // Two days of approved unpaid leave next month.
    const ul = await api('post', '/hr/my/leaves', T.teacher).send({ type: 'unpaid', fromDate: `${month}-10`, toDate: `${month}-11`, reason: 'Personal' });
    expectStatus(ul, 201);
    await api('post', `/hr/leaves/${ul.body.data._id}/review`, T.admin).send({ status: 'approved' });

    expectStatus(await api('put', `/hr/salaries/${M.teacher}`, T.accountant).send({ basic: 3000000, allowances: [{ name: 'HRA', amount: 500000 }], deductions: [{ name: 'PF', amount: 180000 }] }), 200);
    expectStatus(await api('put', `/hr/salaries/${M.librarian}`, T.accountant).send({ basic: 1500000 }), 200);
    expectStatus(await api('put', `/hr/salaries/${M.teacher}`, T.teacher).send({ basic: 1 }), 403);
    const salaries = await api('get', '/hr/salaries', T.accountant);
    assert.equal(salaries.body.data.find((s) => s.membershipId === M.teacher).monthlyNet, 3320000);

    const run = await api('post', '/hr/payroll', T.accountant).send({ month });
    expectStatus(run, 201);
    const slip = run.body.data.payslips.find((p) => p.membershipId === M.teacher);
    const lop = Math.round((3500000 * 2) / days);
    assert.deepEqual([slip.gross, slip.unpaidLeaveDays, slip.totalDeductions, slip.net], [3500000, 2, 180000 + lop, 3500000 - 180000 - lop]);
    assert.equal(run.body.data.totals.staff, 2);
    assert.equal((await api('post', '/hr/payroll', T.accountant).send({ month })).body.error.code, 'RUN_EXISTS');
    ids.run = run.body.data._id;

    assert.equal((await api('get', '/hr/my/payslips', T.teacher)).body.data.length, 0, 'drafts are not visible to staff');
    expectStatus(await api('post', `/hr/payroll/${ids.run}/finalize`, T.accountant), 200);
    assert.equal((await api('post', `/hr/payroll/${ids.run}/recalculate`, T.accountant)).body.error.code, 'RUN_NOT_DRAFT');
    const mine = await api('get', '/hr/my/payslips', T.teacher);
    assert.equal(mine.body.data[0].net, slip.net);
    expectStatus(await api('get', `/hr/my/payslips/${mine.body.data[0]._id}`, T.librarian), 404);
  });

  test('paying payroll posts the journal (needs transactions)', { skip: txOk ? false : 'requires a MongoDB replica set' }, async () => {
    const r = await api('post', `/hr/payroll/${ids.run}/pay`, T.accountant).send({ method: 'bank_transfer', reference: 'NEFT-1' });
    expectStatus(r, 200);
    assert.equal(r.body.data.status, 'paid');
    const entries = await LedgerEntry.find({ schoolId: S.a._id, voucherType: 'payroll' }).lean();
    assert.equal(entries.reduce((t, e) => t + e.debit, 0), r.body.data.totals.net);
    assert.equal(entries.reduce((t, e) => t + e.credit, 0), r.body.data.totals.net);
    assert.ok(entries.some((e) => e.account === 'SALARY_EXPENSE'));
  });

  test('without transactions, paying payroll is refused instead of writing half a record', { skip: txOk ? 'replica set available' : false }, async () => {
    assert.equal((await api('post', `/hr/payroll/${ids.run}/pay`, T.accountant).send({ method: 'cash' })).body.error.code, 'TRANSACTIONS_UNAVAILABLE');
  });

  test('these modules need to be in the school plan', async () => {
    const plan = await createPlan('fees-only-svc', { modules: ['fees'] });
    const school = await createSchool('svc-plan', { plan });
    await addMember(school, await createUser('owner@svc-plan.test'), ['school_owner']);
    const t = await tokenFor('owner@svc-plan.test');
    for (const p of ['/hr/payroll', '/library/books', '/inventory/items', '/hostels']) assert.equal((await api('get', p, t)).body.error.code, 'MODULE_NOT_ENABLED', p);
  });
});
