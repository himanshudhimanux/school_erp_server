import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { setupDb, teardownDb, createUser, createSchool, createPlan, addMember, createApp, PASSWORD, Campus } from './helpers.js';

const { supportsTransactions } = await import('../src/config/db.js');
const { AcademicSession, SchoolClass, Section } = await import('../src/modules/academics/academics.models.js');
const { Student, Enrollment } = await import('../src/modules/students/student.model.js');
const { Guardian, StudentGuardian } = await import('../src/modules/parents/guardian.model.js');
const { FeeInvoice, Payment, LedgerEntry } = await import('../src/modules/fees/fee.models.js');
const { Notification } = await import('../src/modules/notifications/notification.model.js');
const { transport } = await import('../src/modules/fees/gateway.service.js');
const { todayIn, addDays, formatDateOnly } = await import('../src/utils/dates.js');

// Fee operations require MongoDB transactions. Run with a replica set, e.g.
//   MONGODB_URI_TEST="mongodb://127.0.0.1:27018/school_erp_test?replicaSet=rs0" npm test
await setupDb();
const skip = supportsTransactions() ? false : 'requires a MongoDB replica set (transactions)';

let app;
const S = {};
const T = {};
const ids = {};
const today = todayIn('UTC');
const ymd = (d) => formatDateOnly(d);
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
const api = (method, path, token) => request(app)[method](`/api/v1${path}`).set(bearer(token));
const expectStatus = (r, status) => assert.equal(r.status, status, JSON.stringify(r.body));
const invoicesOf = (studentId) => FeeInvoice.find({ schoolId: S.a._id, studentId }).sort({ dueDate: 1 }).lean();
const balance = (i) => i.total - i.paidAmount;
const KEY_SECRET = 'test_key_secret_1234567890';
const WEBHOOK_SECRET = 'whsec_test_123456';
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

before(async () => {
  if (skip) return;
  app = createApp();
  S.a = await createSchool('fee-a', { timezone: 'UTC' });
  S.b = await createSchool('fee-b');
  S.nofee = await createSchool('fee-none', { plan: await createPlan('attendance-only', { modules: ['attendance'] }) });
  const schoolId = S.a._id;
  const campusId = (await Campus.findOne({ schoolId, isMain: true }))._id;
  const session = await AcademicSession.create({ schoolId, name: 'Current', startDate: addDays(today, -200), endDate: addDays(today, 150), status: 'active', isCurrent: true });
  const [g1, g2] = await SchoolClass.create([
    { schoolId, name: 'Grade 1', code: 'G1', order: 1 },
    { schoolId, name: 'Grade 2', code: 'G2', order: 2 },
  ]);
  const secA = await Section.create({ schoolId, sessionId: session._id, classId: g1._id, campusId, name: 'A' });
  const sec2 = await Section.create({ schoolId, sessionId: session._id, classId: g2._id, campusId, name: 'A' });
  Object.assign(ids, { session: String(session._id), g1: String(g1._id), g2: String(g2._id), secA: String(secA._id), campusId });

  const people = {
    accountant: ['accounts@fee-a.test', S.a, ['accountant']],
    admin: ['admin@fee-a.test', S.a, ['school_admin']],
    principal: ['principal@fee-a.test', S.a, ['principal']],
    teacher: ['teacher@fee-a.test', S.a, ['teacher']],
    parent: ['parent@fee-a.test', S.a, ['parent']],
    ownerB: ['owner@fee-b.test', S.b, ['school_owner']],
    ownerNofee: ['owner@fee-none.test', S.nofee, ['school_owner']],
  };
  for (const [key, [email, school, roles]] of Object.entries(people)) {
    const u = await createUser(email);
    ids[`m_${key}`] = (await addMember(school, u, roles))._id;
    T[key] = await tokenFor(email);
  }

  const mk = async (firstName, section, classId) => {
    const s = await Student.create({ schoolId, admissionNo: `F-${firstName.toUpperCase()}`, firstName, lastName: 'Kumar', gender: 'female', campusId, admissionDate: today });
    await Enrollment.create({ schoolId, studentId: s._id, sessionId: session._id, classId, sectionId: section, campusId });
    return String(s._id);
  };
  ids.s1 = await mk('Anu', secA._id, g1._id);
  ids.s2 = await mk('Binu', secA._id, g1._id);
  ids.s3 = await mk('Chinnu', secA._id, g1._id);
  ids.s4 = await mk('Dinu', secA._id, g1._id);
  ids.s5 = await mk('Eenu', sec2._id, g2._id);
  const g = async (name, extra) => (await Guardian.create({ schoolId, name, phone: '+919811111111', phoneNormalized: '+919811111111', ...extra }))._id;
  await StudentGuardian.create([
    { schoolId, studentId: ids.s1, guardianId: await g('Parent Anu', { email: 'parent@fee-a.test', membershipId: ids.m_parent }), relation: 'mother', isPrimary: true },
    { schoolId, studentId: ids.s2, guardianId: await g('Parent Binu', { email: 'binu@family.test' }), relation: 'father', isPrimary: true },
    { schoolId, studentId: ids.s3, guardianId: await g('Parent Chinnu', {}), relation: 'father', isPrimary: true },
  ]);
});
after(teardownDb);

describe('fee setup', { skip }, () => {
  test('categories', async () => {
    for (const [name, code] of [['Tuition Fee', 'TUITION'], ['Admission Fee', 'ADMISSION'], ['Exam Fee', 'EXAM'], ['Old Fee', 'OLD']]) {
      const r = await api('post', '/fees/categories', T.accountant).send({ name, code });
      expectStatus(r, 201);
      ids[code] = r.body.data._id;
    }
    assert.equal((await api('post', '/fees/categories', T.accountant).send({ name: 'Dup', code: 'tuition' })).body.error.code, 'CODE_TAKEN');
    assert.equal((await api('get', '/fees/categories', T.teacher)).body.error.code, 'PERMISSION_DENIED');
    expectStatus(await api('patch', `/fees/categories/${ids.OLD}`, T.accountant).send({ status: 'inactive' }), 200);
  });

  test('structure with installments and a late fee rule', async () => {
    const body = {
      sessionId: ids.session,
      name: 'Grade 1 Fees',
      classIds: [ids.g1],
      installments: [
        { name: 'Term 1', dueDate: ymd(addDays(today, -10)), items: [{ categoryId: ids.TUITION, amount: 500000 }, { categoryId: ids.ADMISSION, amount: 200000 }] },
        { name: 'Term 2', dueDate: ymd(addDays(today, 5)), items: [{ categoryId: ids.TUITION, amount: 500000 }] },
        { name: 'Term 3', dueDate: ymd(addDays(today, 40)), items: [{ categoryId: ids.TUITION, amount: 500000 }] },
      ],
      lateFee: { type: 'per_day', amount: 1000, graceDays: 2, maxAmount: 10000 },
    };
    expectStatus(await api('post', '/fees/structures', T.accountant).send({ ...body, installments: [{ ...body.installments[0], items: [{ categoryId: ids.TUITION, amount: 100.5 }] }] }), 422);
    assert.equal((await api('post', '/fees/structures', T.accountant).send({ ...body, installments: [{ ...body.installments[0], dueDate: ymd(addDays(today, 400)) }] })).body.error.code, 'OUTSIDE_SESSION');
    assert.equal((await api('post', '/fees/structures', T.accountant).send({ ...body, installments: [{ ...body.installments[0], items: [{ categoryId: ids.OLD, amount: 100 }] }] })).body.error.code, 'CATEGORY_INACTIVE');
    const r = await api('post', '/fees/structures', T.accountant).send(body);
    expectStatus(r, 201);
    assert.equal(r.body.data.totalAmount, 1700000);
    assert.equal(r.body.data.installments[0].total, 700000);
    ids.structure = r.body.data._id;
  });

  test('discount', async () => {
    expectStatus(await api('post', '/fees/discounts', T.accountant).send({ name: 'Too much', type: 'percent', value: 150 }), 422);
    const r = await api('post', '/fees/discounts', T.accountant).send({ name: 'Sibling 10%', type: 'percent', value: 10, categoryIds: [ids.TUITION] });
    expectStatus(r, 201);
    ids.discount = r.body.data._id;
  });
});

describe('assigning fees', { skip }, () => {
  test('assign with discount, then the rest of the section', async () => {
    const one = await api('post', '/fees/assignments', T.accountant).send({ structureId: ids.structure, studentIds: [ids.s4, ids.s5], discountIds: [ids.discount] });
    expectStatus(one, 200);
    assert.equal(one.body.data.assigned, 1);
    assert.deepEqual(one.body.data.skipped, [{ studentId: ids.s5, reason: 'CLASS_NOT_IN_STRUCTURE' }]);
    const [t1] = await invoicesOf(ids.s4);
    assert.deepEqual(t1.lines.map((l) => l.discount), [50000, 0]);
    assert.equal(t1.total, 650000);

    const all = await api('post', '/fees/assignments', T.accountant).send({ structureId: ids.structure, sectionId: ids.secA });
    assert.equal(all.body.data.assigned, 3);
    assert.equal(all.body.data.invoicesCreated, 9);
    assert.deepEqual(all.body.data.skipped, [{ studentId: ids.s4, reason: 'ALREADY_ASSIGNED' }]);
    const nos = (await FeeInvoice.find({ schoolId: S.a._id }).sort({ invoiceNo: 1 }).lean()).map((i) => i.invoiceNo);
    assert.equal(nos[0], 'INV000001');
    assert.equal(nos.at(-1), 'INV000012');
  });

  test('invoice list: search, overdue filter and totals', async () => {
    const r = await api('get', '/fees/invoices?search=binu', T.accountant);
    assert.equal(r.body.meta.total, 3);
    assert.equal(r.body.data[0].classSection, 'Grade 1 - A');
    const overdue = await api('get', '/fees/invoices?status=overdue', T.accountant);
    assert.equal(overdue.body.meta.total, 4);
    assert.ok(overdue.body.data.every((i) => i.displayStatus === 'overdue'));
    assert.equal(overdue.body.meta.amounts.balance, 700000 * 3 + 650000);
    const byParent = await api('get', '/fees/invoices?search=Parent%20Chinnu', T.accountant);
    assert.equal(byParent.body.meta.total, 3);
  });

  test('late fees accrue per day after the grace period, capped, once', async () => {
    const r = await api('post', '/fees/late-fees/apply', T.accountant);
    assert.equal(r.body.data.invoicesUpdated, 4);
    assert.equal((await api('post', '/fees/late-fees/apply', T.accountant)).body.data.invoicesUpdated, 0);
    const [t1] = await invoicesOf(ids.s1);
    assert.equal(t1.lateFee, 8000); // 10 days late - 2 grace = 8 days x 10.00
    assert.equal(t1.total, 708000);
  });
});

describe('collecting payments', { skip }, () => {
  test('cash payment is spread over the oldest invoices and posted to the ledger', async () => {
    const r = await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s1, amount: 808000, method: 'cash', idempotencyKey: 'pay-s1-0001' });
    expectStatus(r, 201);
    const receipt = r.body.data;
    assert.equal(receipt.receiptNo, 'RCT000001');
    assert.equal(receipt.amount, 808000);
    assert.deepEqual(receipt.items.map((i) => [i.amount, i.balanceAfter]), [[708000, 0], [100000, 400000]]);
    assert.equal(receipt.amountInWords, 'Eight Thousand Eighty Rupees Only');
    ids.pay1 = receipt.id;

    const [t1, t2] = await invoicesOf(ids.s1);
    assert.deepEqual([t1.status, t2.status], ['paid', 'partially_paid']);
    const entries = await LedgerEntry.find({ schoolId: S.a._id, voucherId: ids.pay1 }).lean();
    assert.equal(entries.reduce((t, e) => t + e.debit, 0), 808000);
    assert.equal(entries.reduce((t, e) => t + e.credit, 0), 808000);
    assert.ok(entries.some((e) => e.account === 'CASH' && e.debit === 808000));
    assert.ok(entries.some((e) => e.account === 'FEE_INCOME' && e.categoryId === null && e.credit === 8000), 'late fee income');

    const again = await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s1, amount: 808000, method: 'cash', idempotencyKey: 'pay-s1-0001' });
    expectStatus(again, 200);
    assert.equal(again.body.data.replayed, true);
    assert.equal(again.body.data.receiptNo, 'RCT000001');
    assert.equal(await Payment.countDocuments({ schoolId: S.a._id }), 1);
  });

  test('validation: overpayment, wrong invoice, missing reference, permissions', async () => {
    assert.equal((await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s1, amount: 99999999, method: 'cash' })).body.error.code, 'AMOUNT_EXCEEDS_BALANCE');
    const [, t2] = await invoicesOf(ids.s1);
    assert.equal((await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s1, allocations: [{ invoiceId: String(t2._id), amount: balance(t2) + 1 }], method: 'cash' })).body.error.code, 'AMOUNT_EXCEEDS_BALANCE');
    const [s2t1] = await invoicesOf(ids.s2);
    assert.equal((await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s1, allocations: [{ invoiceId: String(s2t1._id), amount: 100 }], method: 'cash' })).body.error.code, 'INVALID_INVOICE');
    expectStatus(await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s1, amount: 100, method: 'cheque' }), 422);
    expectStatus(await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s1, amount: 100, method: 'online' }), 422);
    expectStatus(await api('post', '/fees/payments', T.teacher).send({ studentId: ids.s1, amount: 100, method: 'cash' }), 403);
    expectStatus(await api('post', '/fees/payments', T.principal).send({ studentId: ids.s1, amount: 100, method: 'cash' }), 403);
  });

  test('two simultaneous collections cannot overpay an invoice', async () => {
    const [t1] = await invoicesOf(ids.s2);
    const body = { studentId: ids.s2, allocations: [{ invoiceId: String(t1._id), amount: balance(t1) }], method: 'upi', reference: 'UPI-1' };
    const results = await Promise.all([api('post', '/fees/payments', T.accountant).send(body), api('post', '/fees/payments', T.admin).send({ ...body, reference: 'UPI-2' })]);
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.body)));
    const [after] = await invoicesOf(ids.s2);
    assert.equal(after.paidAmount, after.total);
  });

  test('partial refund makes the invoice payable again', async () => {
    assert.equal((await api('post', `/fees/payments/${ids.pay1}/refund`, T.accountant).send({ amount: 900000, reason: 'Too much', method: 'cash' })).body.error.code, 'REFUND_EXCEEDS_PAYMENT');
    expectStatus(await api('post', `/fees/payments/${ids.pay1}/refund`, T.accountant).send({ amount: 100000, reason: 'Paid twice' }), 422);
    const r = await api('post', `/fees/payments/${ids.pay1}/refund`, T.accountant).send({ amount: 100000, reason: 'Term 2 paid by mistake', method: 'cash' });
    expectStatus(r, 200);
    assert.equal(r.body.data.refund.refundNo, 'RFD000001');
    assert.equal(r.body.data.receipt.status, 'partially_refunded');
    const [, t2] = await invoicesOf(ids.s1);
    assert.deepEqual([t2.paidAmount, t2.status], [0, 'unpaid']);
    const entries = await LedgerEntry.find({ schoolId: S.a._id, voucherType: 'refund' }).lean();
    assert.equal(entries.reduce((t, e) => t + e.debit, 0), entries.reduce((t, e) => t + e.credit, 0));
    assert.ok(entries.some((e) => e.account === 'CASH' && e.credit === 100000));
  });
});

describe('invoice adjustments', { skip }, () => {
  test('concession and late fee waiver', async () => {
    const [t1, t2] = await invoicesOf(ids.s3);
    assert.equal((await api('post', `/fees/invoices/${t2._id}/concession`, T.accountant).send({ amount: balance(t2) + 1, reason: 'Hardship' })).body.error.code, 'CONCESSION_TOO_HIGH');
    const c = await api('post', `/fees/invoices/${t2._id}/concession`, T.accountant).send({ amount: 50000, reason: 'Hardship' });
    expectStatus(c, 200);
    assert.equal(c.body.data.total, 450000);
    const w = await api('post', `/fees/invoices/${t1._id}/waive-late-fee`, T.accountant).send({ reason: 'Bank delay' });
    assert.equal(w.body.data.total, 700000);
    assert.equal(w.body.data.lateFeeWaived, true);
    assert.equal((await api('post', `/fees/invoices/${t1._id}/waive-late-fee`, T.accountant).send({ reason: 'Again' })).body.error.code, 'NO_LATE_FEE');
    assert.equal((await api('post', '/fees/late-fees/apply', T.accountant)).body.data.invoicesUpdated, 0, 'waived invoices stay waived');
  });

  test('cancel invoices and assignments; ad-hoc invoices', async () => {
    const [s1t1] = await invoicesOf(ids.s1);
    assert.equal((await api('post', `/fees/invoices/${s1t1._id}/cancel`, T.accountant).send({ reason: 'Wrong' })).body.error.code, 'INVOICE_HAS_PAYMENTS');
    const [, , s3t3] = await invoicesOf(ids.s3);
    expectStatus(await api('post', `/fees/invoices/${s3t3._id}/cancel`, T.accountant).send({ reason: 'Left early' }), 200);

    const assignments = await api('get', '/fees/assignments', T.accountant);
    const of = (sid) => assignments.body.data.find((a) => a.studentId === sid)._id;
    assert.equal((await api('post', `/fees/assignments/${of(ids.s1)}/cancel`, T.accountant).send({ reason: 'Test' })).body.error.code, 'ASSIGNMENT_HAS_PAYMENTS');
    const c = await api('post', `/fees/assignments/${of(ids.s4)}/cancel`, T.accountant).send({ reason: 'Fee waived fully' });
    assert.equal(c.body.data.invoicesCancelled, 3);

    const a = await api('post', '/fees/invoices', T.accountant).send({ studentId: ids.s2, title: 'Exam fee', dueDate: ymd(addDays(today, 3)), lines: [{ categoryId: ids.EXAM, amount: 30000 }] });
    expectStatus(a, 201);
    assert.equal(a.body.data.invoiceNo, 'INV000013');
    assert.equal(a.body.data.displayStatus, 'pending');
  });
});

describe('fee reports', { skip }, () => {
  test('dashboard', async () => {
    const r = await api('get', '/fees/dashboard', T.accountant);
    expectStatus(r, 200);
    const d = r.body.data;
    assert.equal(d.collection.today.amount, 808000 + 708000); // Binu's term 1 included the 80.00 late fee
    assert.equal(d.collection.month.refunds, 100000);
    assert.equal(d.collection.offline.count, 2);
    assert.equal(d.overdue.students, 1);
    assert.equal(d.recentPayments.length, 2);
  });

  test('defaulters', async () => {
    const r = await api('get', '/fees/defaulters', T.principal);
    expectStatus(r, 200);
    assert.deepEqual(r.body.data.map((x) => [x.name, x.overdueAmount]), [['Chinnu Kumar', 700000]]);
    assert.equal(r.body.data[0].primaryGuardian.name, 'Parent Chinnu');
    expectStatus(await api('get', '/fees/defaulters', T.teacher), 403);
  });

  test('collections, outstanding and ledger', async () => {
    const q = `from=${ymd(addDays(today, -1))}&to=${ymd(today)}`;
    const byMethod = await api('get', `/fees/reports/collections?${q}&groupBy=method`, T.accountant);
    assert.deepEqual(byMethod.body.data.rows.map((r) => [r.key, r.amount]).sort(), [['cash', 808000], ['upi', 708000]]);
    assert.deepEqual(byMethod.body.data.totals, { received: 1516000, payments: 2, refunded: 100000, net: 1416000 });
    const byCat = await api('get', `/fees/reports/collections?${q}&groupBy=category`, T.accountant);
    const net = byCat.body.data.rows.reduce((t, r) => t + r.net, 0);
    assert.equal(net, 1416000);
    assert.ok(byCat.body.data.rows.some((r) => r.key === 'late_fee'));
    const byClass = await api('get', `/fees/reports/collections?${q}&groupBy=class`, T.accountant);
    assert.equal(byClass.body.data.rows[0].label, 'Grade 1');
    const out = await api('get', '/fees/reports/outstanding', T.accountant);
    assert.equal(out.body.data.rows[0].name, 'Grade 1');
    const led = await api('get', `/fees/reports/ledger?${q}`, T.accountant);
    const tot = led.body.meta.byAccount.reduce((t, a) => ({ dr: t.dr + a.debit, cr: t.cr + a.credit }), { dr: 0, cr: 0 });
    assert.equal(tot.dr, tot.cr);
    await assert.rejects(LedgerEntry.updateOne({ schoolId: S.a._id }, { debit: 1 }), /append-only/);
  });
});

describe('fee reminders', { skip }, () => {
  test('off by default; rules send once per invoice and parent', async () => {
    assert.equal((await api('post', '/fees/reminders/run', T.accountant)).body.data.enabled, false);
    const s = await api('patch', '/fees/reminders/settings', T.accountant).send({ enabled: true, beforeDays: [5], afterDays: [10], onDueDate: true });
    expectStatus(s, 200);
    assert.equal(s.body.data.enabled, true);
    const r = await api('post', '/fees/reminders/run', T.accountant);
    // Term 2 (due in 5 days): s1, s2, s3 open. Term 1 (10 days late): s3 open.
    assert.equal(r.body.data.invoices, 4);
    assert.ok(r.body.data.notificationsQueued >= 4);
    assert.equal((await api('post', '/fees/reminders/run', T.accountant)).body.data.notificationsQueued, 0);
    const inbox = await api('get', '/portal/notifications', T.parent);
    assert.ok(inbox.body.data.some((n) => n.title === `Fee due on ${new Date(addDays(today, 5)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`));
    const unreachable = await Notification.findOne({ schoolId: S.a._id, type: 'fees.reminder', 'data.studentId': ids.s3, channel: 'none' }).lean();
    assert.equal(unreachable.error, 'NO_CONTACT_CHANNEL');
  });

  test('manual reminder once a day; overview shows real results', async () => {
    const [t1] = await invoicesOf(ids.s3);
    expectStatus(await api('post', `/fees/invoices/${t1._id}/remind`, T.accountant), 200);
    assert.equal((await api('post', `/fees/invoices/${t1._id}/remind`, T.accountant)).body.error.code, 'ALREADY_REMINDED_TODAY');
    const [paid] = await invoicesOf(ids.s1);
    assert.equal((await api('post', `/fees/invoices/${paid._id}/remind`, T.accountant)).body.error.code, 'INVOICE_NOT_OPEN');
    const o = await api('get', '/fees/reminders', T.accountant);
    expectStatus(o, 200);
    assert.ok(o.body.data.last30Days.byStatus.sent >= 1);
    assert.equal(o.body.data.channels.find((c) => c.channel === 'email').available, false);
    assert.ok(o.body.data.upcoming.length >= 1);
  });
});

describe('online payments', { skip }, () => {
  const calls = [];
  before(() => {
    transport.request = async ({ keyId, keySecret, path, body }) => {
      calls.push({ keyId, keySecret, path, body });
      if (path === '/orders') return { id: `order_${calls.length}abc`, amount: body.amount, currency: body.currency };
      if (path.endsWith('/refund')) return { id: `rfnd_${calls.length}` };
      throw new Error('unexpected call');
    };
  });

  test('not available until the school connects Razorpay', async () => {
    const fees = await api('get', '/portal/fees', T.parent);
    expectStatus(fees, 200);
    assert.equal(fees.body.data.onlinePayment.available, false);
    assert.equal(fees.body.data.student.name, 'Anu Kumar');
    const [, t2] = await invoicesOf(ids.s1);
    assert.equal((await api('post', '/portal/fees/orders', T.parent).send({ invoiceIds: [String(t2._id)] })).body.error.code, 'PAYMENTS_NOT_CONFIGURED');
  });

  test('connecting the gateway stores secrets encrypted', async () => {
    expectStatus(await api('put', '/fees/gateway', T.accountant).send({ keyId: 'rzp_test_abc123', keySecret: KEY_SECRET }), 403);
    const r = await api('put', '/fees/gateway', T.admin).send({ keyId: 'rzp_test_abc123', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });
    expectStatus(r, 200);
    assert.equal(r.body.data.configured, true);
    assert.equal(JSON.stringify(r.body.data).includes(KEY_SECRET), false);
    const { PaymentGateway } = await import('../src/modules/fees/fee.models.js');
    const stored = await PaymentGateway.findOne({ schoolId: S.a._id }).lean();
    assert.ok(stored.keySecretEnc.startsWith('v1:') && !stored.keySecretEnc.includes(KEY_SECRET));
  });

  test('parent pays online: order, signature check, idempotent recording, webhook', async () => {
    const [, t2, t3] = await invoicesOf(ids.s1);
    const o = await api('post', '/portal/fees/orders', T.parent).send({ invoiceIds: [String(t2._id), String(t3._id)] });
    expectStatus(o, 201);
    assert.equal(o.body.data.amount, balance(t2) + balance(t3));
    assert.equal(calls.at(-1).keySecret, KEY_SECRET);
    const orderId = o.body.data.orderId;

    const bad = await api('post', '/portal/fees/orders/verify', T.parent).send({ orderId, paymentId: 'pay_ABC123', signature: 'f'.repeat(64) });
    assert.equal(bad.body.error.code, 'INVALID_SIGNATURE');
    const o2 = await api('post', '/portal/fees/orders', T.parent).send({ invoiceIds: [String(t2._id), String(t3._id)] });
    const good = { orderId: o2.body.data.orderId, paymentId: 'pay_GOOD1', signature: sign(KEY_SECRET, `${o2.body.data.orderId}|pay_GOOD1`) };
    const v = await api('post', '/portal/fees/orders/verify', T.parent).send(good);
    expectStatus(v, 200);
    assert.equal(v.body.data.source, 'online');
    assert.deepEqual((await invoicesOf(ids.s1)).map((i) => i.status), ['paid', 'paid', 'paid']);
    const again = await api('post', '/portal/fees/orders/verify', T.parent).send(good);
    assert.equal(again.body.data.receiptNo, v.body.data.receiptNo);
    ids.onlinePayment = v.body.data.id;

    const event = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_GOOD1', order_id: good.orderId, amount: o2.body.data.amount } } } });
    const wh = await request(app).post(`/api/v1/webhooks/razorpay/${S.a._id}`).set('Content-Type', 'application/json').set('x-razorpay-signature', sign(WEBHOOK_SECRET, event)).send(event);
    expectStatus(wh, 200);
    assert.deepEqual(wh.body.data, { handled: true, created: false });
    assert.equal(await Payment.countDocuments({ schoolId: S.a._id, source: 'online' }), 1);
    const forged = await request(app).post(`/api/v1/webhooks/razorpay/${S.a._id}`).set('Content-Type', 'application/json').set('x-razorpay-signature', 'x'.repeat(64)).send(event);
    expectStatus(forged, 401);
  });

  test('webhook can arrive first; excess becomes advance when already paid', async () => {
    const t2 = (await invoicesOf(ids.s2)).find((i) => i.title.endsWith('Term 2'));
    const parentTok = T.parent;
    assert.equal((await api('post', '/portal/fees/orders', parentTok).send({ studentId: ids.s2, invoiceIds: [String(t2._id)] })).status, 404, 'not their child');
    // Staff-side order for s2 is not exposed, so create one through the service directly.
    const { createOrder } = await import('../src/modules/fees/gateway.service.js');
    const tenant = { schoolId: S.a._id };
    const order = await createOrder(tenant, ids.s2, [String(t2._id)], { actorId: null });
    // Meanwhile the parent pays part of it at the counter.
    expectStatus(await api('post', '/fees/payments', T.accountant).send({ studentId: ids.s2, allocations: [{ invoiceId: String(t2._id), amount: 100000 }], method: 'cash' }), 201);
    const event = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WH1', order_id: order.orderId, amount: order.amount } } } });
    const wh = await request(app).post(`/api/v1/webhooks/razorpay/${S.a._id}`).set('Content-Type', 'application/json').set('x-razorpay-signature', sign(WEBHOOK_SECRET, event)).send(event);
    assert.deepEqual(wh.body.data, { handled: true, created: true });
    const p = await Payment.findOne({ schoolId: S.a._id, 'gateway.paymentId': 'pay_WH1' }).lean();
    assert.equal(p.unallocatedAmount, 100000);
    const entries = await LedgerEntry.find({ schoolId: S.a._id, voucherId: p._id }).lean();
    assert.ok(entries.some((e) => e.account === 'ADVANCE' && e.credit === 100000));
    ids.advancePayment = String(p._id);
  });

  test('online refunds go through the gateway; advance is refunded first', async () => {
    const r = await api('post', `/fees/payments/${ids.advancePayment}/refund`, T.accountant).send({ amount: 100000, reason: 'Paid twice' });
    expectStatus(r, 200);
    assert.equal(r.body.data.refund.method, 'online');
    assert.match(r.body.data.refund.gatewayRefundId, /^rfnd_/);
    assert.deepEqual(r.body.data.refund.allocations, []);
    assert.equal((await invoicesOf(ids.s2)).find((i) => i.title.endsWith('Term 2')).status, 'paid', 'invoice untouched when refunding advance');
  });

  test('family receipts only', async () => {
    expectStatus(await api('get', `/portal/fees/payments/${ids.onlinePayment}/receipt`, T.parent), 200);
    expectStatus(await api('get', `/portal/fees/payments/${ids.advancePayment}/receipt`, T.parent), 404);
  });
});

describe('fee isolation and guards', { skip }, () => {
  test('other schools and modules', async () => {
    const [inv] = await invoicesOf(ids.s1);
    expectStatus(await api('get', `/fees/invoices/${inv._id}`, T.ownerB), 404);
    expectStatus(await api('get', `/fees/students/${ids.s1}`, T.ownerB), 404);
    expectStatus(await api('get', `/fees/payments/${ids.pay1}/receipt`, T.ownerB), 404);
    assert.equal((await api('get', '/fees/dashboard', T.ownerNofee)).body.error.code, 'MODULE_NOT_ENABLED');
  });

  test('records with fees cannot be deleted', async () => {
    assert.equal((await api('delete', `/students/${ids.s1}`, T.admin)).body.error.code, 'STUDENT_IN_USE');
    assert.equal((await api('delete', `/fees/structures/${ids.structure}`, T.accountant)).body.error.code, 'STRUCTURE_IN_USE');
    assert.equal((await api('delete', `/fees/categories/${ids.TUITION}`, T.accountant)).body.error.code, 'CATEGORY_IN_USE');
    assert.equal((await api('delete', `/fees/discounts/${ids.discount}`, T.accountant)).body.error.code, 'DISCOUNT_IN_USE');
  });

  test('the hourly scheduler runs every school idempotently', async () => {
    const { runScheduledJobs } = await import('../src/jobs/scheduler.js');
    const before = await Notification.countDocuments({ schoolId: S.a._id, type: 'fees.reminder' });
    await runScheduledJobs();
    await runScheduledJobs();
    assert.equal(await Notification.countDocuments({ schoolId: S.a._id, type: 'fees.reminder' }), before, 'nothing new to send today');
  });

  test('student fee account for staff', async () => {
    const r = await api('get', `/fees/students/${ids.s3}`, T.accountant);
    expectStatus(r, 200);
    assert.equal(r.body.data.summary.overdue, 700000);
    assert.equal(r.body.data.invoices.find((i) => i.status === 'cancelled').cancelReason, 'Left early');
  });
});
