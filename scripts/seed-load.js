/**
 * Load-test data: one large school ("loadtest") on top of whatever is already in the database.
 *
 *   node scripts/seed-load.js [--students=2400] [--days=20]
 *
 * Creates 12 classes x 4 sections, the students with one guardian each, staff and parent logins,
 * `days` working days of attendance (through the real attendance service), and — when the database
 * supports transactions — a fee structure, invoices for everyone and payments for most families.
 * Refuses to run with NODE_ENV=production. Re-running is a no-op once the school exists.
 *
 * Accounts (password Password@123): admin@loadtest.local, accounts@loadtest.local,
 * teacher@loadtest.local, parent@loadtest.local
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB, supportsTransactions } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { User } from '../src/modules/users/user.model.js';
import { School } from '../src/modules/schools/school.model.js';
import { Campus } from '../src/modules/campuses/campus.model.js';
import { Membership } from '../src/modules/memberships/membership.model.js';
import { Plan } from '../src/modules/subscriptions/plan.model.js';
import { assignPlan } from '../src/modules/subscriptions/subscription.service.js';
import { AcademicSession, SchoolClass, Section, Subject, ClassSubject, TeachingAssignment } from '../src/modules/academics/academics.models.js';
import { Student, Enrollment } from '../src/modules/students/student.model.js';
import { Guardian, StudentGuardian } from '../src/modules/parents/guardian.model.js';
import { FeeInvoice } from '../src/modules/fees/fee.models.js';
import { PLAN_MODULES } from '../src/constants/modules.js';
import { resolveMembership } from '../src/modules/memberships/membership.service.js';
import { markSection } from '../src/modules/attendance/attendance.service.js';
import { createCategory, createStructure } from '../src/modules/fees/setup.service.js';
import { assignFees } from '../src/modules/fees/invoice.service.js';
import { collectPayment } from '../src/modules/fees/payment.service.js';
import { settleBackgroundWork } from '../src/modules/notifications/notification.service.js';
import { todayIn, addDays, weekday } from '../src/utils/dates.js';

const arg = (name, def) => Number((process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1]) || def;
const STUDENTS = arg('students', 2400);
const DAYS = arg('days', 20);
const PASSWORD = 'Password@123';
const FIRST = ['Aarav', 'Diya', 'Vihaan', 'Ananya', 'Arjun', 'Saanvi', 'Reyansh', 'Myra', 'Kabir', 'Anika', 'Ishaan', 'Kiara', 'Advait', 'Pari', 'Dhruv', 'Navya'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Iyer', 'Reddy', 'Nair', 'Khan', 'Singh', 'Patel', 'Das', 'Mehta', 'Joshi'];

async function user(name, email) {
  let u = await User.findOne({ email });
  if (!u) {
    u = new User({ name, email, emailVerifiedAt: new Date() });
    await u.setPassword(PASSWORD);
    await u.save();
  }
  return u;
}

async function main() {
  if (env.isProd) throw new Error('Refusing to create load-test data with NODE_ENV=production');
  createApp();
  await connectDB();
  if (await School.exists({ code: 'loadtest' })) {
    console.log('School "loadtest" already exists; nothing to do. Drop it (or the database) to rebuild.');
    return;
  }
  const t0 = Date.now();
  const lap = (msg) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${msg}`);

  const plan = (await Plan.findOne({ code: 'premium' })) || (await Plan.create({ name: 'Load test', code: 'loadtest', modules: [...PLAN_MODULES] }));
  const school = await School.create({ name: 'Load Test Academy', code: 'loadtest', status: 'active', timezone: 'Asia/Kolkata', settings: { attendance: { weeklyOffDays: [0] } } });
  const schoolId = school._id;
  await assignPlan(schoolId, plan, { modules: [...PLAN_MODULES], limits: { maxStudents: null, maxUsers: null, maxCampuses: null }, billingCycle: 'yearly' });
  const campus = await Campus.create({ schoolId, name: 'Main Campus', code: 'MAIN', isMain: true });

  const members = {};
  for (const [key, name, roles] of [['admin', 'Load Admin', ['school_admin']], ['accounts', 'Load Accountant', ['accountant']], ['teacher', 'Load Teacher', ['teacher']], ['parent', 'Load Parent', ['parent']]]) {
    const u = await user(name, `${key}@loadtest.local`);
    members[key] = await Membership.create({ schoolId, userId: u._id, roles, status: 'active' });
  }
  lap('school, plan and logins');

  const today = todayIn(school.timezone);
  const session = await AcademicSession.create({ schoolId, name: 'Load session', startDate: addDays(today, -120), endDate: addDays(today, 240), status: 'active', isCurrent: true });
  const classes = await SchoolClass.insertMany(Array.from({ length: 12 }, (_, i) => ({ schoolId, name: `Grade ${i + 1}`, code: `G${i + 1}`, order: i + 1 })));
  const maths = await Subject.create({ schoolId, name: 'Mathematics', code: 'MATH' });
  await ClassSubject.insertMany(classes.map((c) => ({ schoolId, sessionId: session._id, classId: c._id, subjectId: maths._id })));
  const sections = [];
  for (const c of classes) sections.push(...(await Section.insertMany(['A', 'B', 'C', 'D'].map((name) => ({ schoolId, sessionId: session._id, classId: c._id, campusId: campus._id, name, capacity: 80 })))));
  await Section.updateOne({ schoolId, _id: sections[0]._id }, { classTeacherId: members.teacher._id });
  await TeachingAssignment.insertMany(sections.slice(0, 4).map((s) => ({ schoolId, sessionId: session._id, sectionId: s._id, subjectId: maths._id, teacherId: members.teacher._id })));
  lap(`12 classes, ${sections.length} sections`);

  const students = [];
  const enrollments = [];
  const guardians = [];
  const links = [];
  for (let i = 0; i < STUDENTS; i += 1) {
    const sec = sections[i % sections.length];
    const sid = new mongoose.Types.ObjectId();
    const gid = new mongoose.Types.ObjectId();
    const phone = `+9198${String(10000000 + i).padStart(8, '0')}`;
    students.push({ _id: sid, schoolId, admissionNo: `LT-${String(i + 1).padStart(5, '0')}`, firstName: FIRST[i % FIRST.length], lastName: LAST[(i * 7) % LAST.length], gender: i % 2 ? 'female' : 'male', campusId: campus._id, admissionDate: addDays(today, -100), status: 'active' });
    enrollments.push({ schoolId, studentId: sid, sessionId: session._id, classId: sec.classId, sectionId: sec._id, campusId: campus._id, rollNo: Math.floor(i / sections.length) + 1, status: 'active' });
    guardians.push({ _id: gid, schoolId, name: `Parent of ${FIRST[i % FIRST.length]}`, phone, phoneNormalized: phone, ...(i === 0 ? { membershipId: members.parent._id, email: 'parent@loadtest.local' } : {}) });
    links.push({ schoolId, studentId: sid, guardianId: gid, relation: i % 2 ? 'father' : 'mother', isPrimary: true });
  }
  for (const [Model, rows] of [[Student, students], [Enrollment, enrollments], [Guardian, guardians], [StudentGuardian, links]]) {
    for (let i = 0; i < rows.length; i += 1000) await Model.insertMany(rows.slice(i, i + 1000), { ordered: true });
  }
  lap(`${STUDENTS} students with guardians and enrollments`);

  // Attendance through the real service: the last DAYS working days (Mon–Sat), every section.
  const admin = await User.findOne({ email: 'admin@loadtest.local' });
  const tenant = await resolveMembership(admin._id, schoolId);
  const ctx = { actorId: admin._id, schoolId, ip: '127.0.0.1', userAgent: 'seed-load' };
  const days = [];
  for (let d = 0; days.length < DAYS; d += 1) if (weekday(addDays(today, -d)) !== 0) days.push(addDays(today, -d));
  const bySection = new Map();
  for (const e of enrollments) {
    if (!bySection.has(String(e.sectionId))) bySection.set(String(e.sectionId), []);
    bySection.get(String(e.sectionId)).push(String(e.studentId));
  }
  // Admin edits are allowed on past days; alerts only go out for today.
  for (const [n, day] of days.reverse().entries()) {
    for (const sec of sections) {
      const ids = bySection.get(String(sec._id)) || [];
      const entries = ids.filter((_, k) => (k + n) % 17 === 0).map((studentId) => ({ studentId, status: 'absent' })).concat(ids.filter((_, k) => (k + n) % 29 === 0).map((studentId) => ({ studentId, status: 'late' })));
      const unique = [...new Map(entries.map((e) => [e.studentId, e])).values()];
      await markSection(tenant, sec._id, { date: day, defaultStatus: 'present', entries: unique }, ctx);
    }
    if ((n + 1) % 5 === 0) lap(`attendance: ${n + 1}/${days.length} days`);
  }

  if (supportsTransactions()) {
    const accountsUser = await User.findOne({ email: 'accounts@loadtest.local' });
    const accTenant = await resolveMembership(accountsUser._id, schoolId);
    const actx = { ...ctx, actorId: accountsUser._id };
    const tuition = await createCategory(accTenant, { name: 'Tuition Fee', code: 'TUITION' }, actx);
    const structure = await createStructure(accTenant, {
      sessionId: session._id,
      name: 'Load fees',
      classIds: classes.map((c) => c._id),
      installments: [-60, -20, 30, 90].map((off, k) => ({ name: `Term ${k + 1}`, dueDate: addDays(today, off), items: [{ categoryId: tuition._id, amount: 1500000 }] })),
      lateFee: { type: 'none' },
    }, actx);
    for (const sec of sections) await assignFees(accTenant, { structureId: structure._id, sectionId: sec._id }, actx);
    lap(`${await FeeInvoice.countDocuments({ schoolId })} invoices`);
    // About 75% of families have paid term 1, half of them term 2 as well.
    const firstTerms = await FeeInvoice.find({ schoolId, dueDate: { $lte: today } }).sort({ dueDate: 1 }).lean();
    let payments = 0;
    for (const [k, inv] of firstTerms.entries()) {
      const pos = Number(String(inv.studentId).slice(-4)) || k; // spread payers across classes
      const isTerm1 = inv.dueDate.getTime() === firstTerms[0].dueDate.getTime();
      if (!(pos % 4 !== 0 && (isTerm1 || pos % 2 === 0))) continue;
      const method = ['cash', 'upi', 'bank_transfer'][pos % 3];
      await collectPayment(accTenant, { studentId: inv.studentId, allocations: [{ invoiceId: inv._id, amount: inv.total }], method, reference: method === 'cash' ? undefined : `LT${payments + 1}`, paidAt: inv.dueDate }, actx);
      payments += 1;
      if (payments % 500 === 0) lap(`payments: ${payments}`);
    }
    lap(`${payments} payments`);
  } else {
    lap('fees skipped: MongoDB is not a replica set');
  }
  await settleBackgroundWork();
  lap('done');
}

main()
  .then(() => disconnectDB())
  .catch(async (err) => {
    console.error(err);
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
