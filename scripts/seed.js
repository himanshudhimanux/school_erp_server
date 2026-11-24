/**
 * Development seed: a platform super admin, two demo schools with owners/staff, and one user
 * who belongs to BOTH schools (useful for testing the school switcher and tenant isolation).
 *
 *   npm run seed            create missing records (idempotent)
 *   npm run seed -- --reset drop the database first
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { User } from '../src/modules/users/user.model.js';
import { School } from '../src/modules/schools/school.model.js';
import { Membership } from '../src/modules/memberships/membership.model.js';
import { Campus } from '../src/modules/campuses/campus.model.js';
import { Plan } from '../src/modules/subscriptions/plan.model.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { assignPlan } from '../src/modules/subscriptions/subscription.service.js';
import { AcademicSession, SchoolClass, Subject, Section, ClassSubject, TeachingAssignment } from '../src/modules/academics/academics.models.js';
import { CalendarEvent } from '../src/modules/calendar/calendarEvent.model.js';
import { parseDateOnly } from '../src/utils/dates.js';
import { Student, Enrollment } from '../src/modules/students/student.model.js';
import { Guardian, StudentGuardian } from '../src/modules/parents/guardian.model.js';
import { StaffProfile } from '../src/modules/staff/staffProfile.model.js';
import { Admission } from '../src/modules/admissions/admission.model.js';
import { Counter } from '../src/modules/counters/counter.model.js';
import { AttendanceSheet, AttendanceRecord, LeaveRequest } from '../src/modules/attendance/attendance.models.js';
import { BellSchedule, TimetableEntry } from '../src/modules/timetable/timetable.models.js';
import { nonWorkingDates } from '../src/modules/calendar/calendar.service.js';
import { todayIn, addDays, weekday, formatDateOnly } from '../src/utils/dates.js';
import { supportsTransactions } from '../src/config/db.js';
import { resolveMembership } from '../src/modules/memberships/membership.service.js';
import { FeeCategory, FeeInvoice, Payment } from '../src/modules/fees/fee.models.js';
import { createCategory, createStructure, createDiscount } from '../src/modules/fees/setup.service.js';
import { assignFees, applyLateFees } from '../src/modules/fees/invoice.service.js';
import { collectPayment } from '../src/modules/fees/payment.service.js';
import { GradingScale, ExamPaper } from '../src/modules/exams/exam.models.js';
import { createScale, createExam, setClassPapers } from '../src/modules/exams/exam.service.js';
import { saveMarks, publishResults } from '../src/modules/exams/marks.service.js';
import { settleBackgroundWork } from '../src/modules/notifications/notification.service.js';
import { Book } from '../src/modules/library/library.models.js';
import { createBook, issueBook } from '../src/modules/library/library.service.js';
import { createItem } from '../src/modules/inventory/inventory.service.js';
import { saveHostel, createRoom, allocate } from '../src/modules/hostel/hostel.service.js';
import { saveSalary, applyLeave } from '../src/modules/hr/hr.service.js';
import { Announcement } from '../src/modules/communication/announcement.model.js';
import { createAnnouncement, sendAnnouncement } from '../src/modules/communication/communication.service.js';

if (env.isProd && !process.argv.includes('--allow-production')) {
  console.error('Refusing to seed in production.');
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD || 'Password@123';

async function upsertUser({ name, email, platformRole = null }) {
  let user = await User.findOne({ email });
  if (!user) {
    user = new User({ name, email, platformRole, emailVerifiedAt: new Date() });
    await user.setPassword(PASSWORD);
    await user.save();
  }
  return user;
}

const PLANS = [
  { name: 'Starter', code: 'starter', sortOrder: 1, priceMonthly: 149900, priceYearly: 1499000, trialDays: 14, modules: ['attendance', 'fees', 'communication'], limits: { maxStudents: 300, maxCampuses: 1, maxUsers: 15 } },
  { name: 'Standard', code: 'standard', sortOrder: 2, priceMonthly: 349900, priceYearly: 3499000, trialDays: 14, modules: ['admissions', 'attendance', 'timetable', 'fees', 'exams', 'homework', 'communication', 'library'], limits: { maxStudents: 1500, maxCampuses: 3, maxUsers: 75 } },
  { name: 'Premium', code: 'premium', sortOrder: 3, priceMonthly: 799900, priceYearly: 7999000, trialDays: 14, modules: ['admissions', 'attendance', 'timetable', 'fees', 'exams', 'homework', 'communication', 'reports', 'library', 'hr', 'inventory', 'hostel'], limits: { maxStudents: null, maxCampuses: null, maxUsers: null } },
];

async function upsertPlan(plan) {
  return (await Plan.findOne({ code: plan.code })) || Plan.create(plan);
}

async function upsertSchool({ name, code, type }, createdBy, plan, { trial = false } = {}) {
  const school = (await School.findOne({ code })) || (await School.create({ name, code, type, status: 'active', createdBy }));
  if (!(await Campus.exists({ schoolId: school._id }))) {
    await Campus.create({ schoolId: school._id, name: 'Main Campus', code: 'MAIN', isMain: true, createdBy });
  }
  if (!(await Subscription.exists({ schoolId: school._id }))) await assignPlan(school._id, plan, { trial, actorId: createdBy });
  return school;
}

/** Demo academic setup for one school (skipped if the school already has a session). */
async function seedAcademics(school, teacherEmail) {
  const schoolId = school._id;
  if (await AcademicSession.exists({ schoolId })) return;
  const campus = await Campus.findOne({ schoolId, isMain: true });
  const teacherUser = await User.findOne({ email: teacherEmail });
  const teacher = teacherUser && (await Membership.findOne({ schoolId, userId: teacherUser._id }));

  const session = await AcademicSession.create({ schoolId, name: '2026-27', startDate: parseDateOnly('2026-04-01'), endDate: parseDateOnly('2027-03-31'), status: 'active', isCurrent: true });
  const classes = await SchoolClass.insertMany(
    ['Nursery', 'LKG', 'UKG', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5'].map((name, order) => ({ schoolId, name, order, code: name.replace('Grade ', 'G').toUpperCase().slice(0, 10) })),
  );
  const subjects = await Subject.insertMany(
    [['English', 'ENG'], ['Hindi', 'HIN'], ['Mathematics', 'MATH'], ['Environmental Studies', 'EVS'], ['Computer Science', 'COMP'], ['Art & Craft', 'ART', 'activity']].map(([name, code, type = 'theory']) => ({ schoolId, name, code, type })),
  );
  const bySubject = Object.fromEntries(subjects.map((x) => [x.code, x._id]));
  const curriculum = (cls) => (cls.order < 3 ? ['ENG', 'HIN', 'MATH', 'ART'] : ['ENG', 'HIN', 'MATH', 'EVS', 'COMP', 'ART']);

  for (const cls of classes) {
    const sections = await Section.insertMany(['A', 'B'].map((name) => ({ schoolId, sessionId: session._id, classId: cls._id, campusId: campus._id, name, capacity: 35 })));
    await ClassSubject.insertMany(curriculum(cls).map((code, order) => ({ schoolId, sessionId: session._id, classId: cls._id, subjectId: bySubject[code], order })));
    if (teacher && cls.name === 'Grade 1') {
      await Section.updateOne({ schoolId, _id: sections[0]._id }, { classTeacherId: teacher._id });
      await TeachingAssignment.insertMany(sections.map((sec) => ({ schoolId, sessionId: session._id, sectionId: sec._id, subjectId: bySubject.MATH, teacherId: teacher._id })));
    }
  }

  await CalendarEvent.create([
    { schoolId, sessionId: session._id, title: 'Independence Day', type: 'holiday', startDate: parseDateOnly('2026-08-15'), endDate: parseDateOnly('2026-08-15') },
    { schoolId, sessionId: session._id, title: 'Diwali Break', type: 'vacation', startDate: parseDateOnly('2026-11-07'), endDate: parseDateOnly('2026-11-11') },
    { schoolId, sessionId: session._id, title: 'Winter Vacation', type: 'vacation', startDate: parseDateOnly('2026-12-25'), endDate: parseDateOnly('2027-01-03') },
    { schoolId, sessionId: session._id, title: 'Annual Day', type: 'event', startDate: parseDateOnly('2026-12-19'), endDate: parseDateOnly('2026-12-19') },
  ]);
}

const FIRST = ['Aarav', 'Diya', 'Vihaan', 'Ananya', 'Arjun', 'Saanvi', 'Reyansh', 'Myra', 'Kabir', 'Anika', 'Ishaan', 'Kiara', 'Advait', 'Pari', 'Dhruv', 'Navya', 'Shaurya', 'Aadhya', 'Rudra', 'Meera', 'Atharv', 'Riya', 'Krish', 'Tara'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Iyer', 'Reddy', 'Nair', 'Khan', 'Singh', 'Patel', 'Das', 'Mehta', 'Joshi'];

/**
 * Demo students, parents, staff records and admissions (skipped if the school has students).
 * parent@greenwood.local is the parent of two children; student@greenwood.local is a Grade 5 student.
 */
async function seedPeople(school, { parentEmail, studentEmail }) {
  const schoolId = school._id;
  if (await Student.exists({ schoolId })) return;
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true });
  if (!session) return;
  const campus = await Campus.findOne({ schoolId, isMain: true });
  const classes = await SchoolClass.find({ schoolId }).sort('order');
  const sections = await Section.find({ schoolId, sessionId: session._id }).sort('name');

  let n = 0;
  const students = [];
  for (const cls of classes) {
    for (const sec of sections.filter((x) => String(x.classId) === String(cls._id))) {
      const perSection = cls.name === 'Grade 1' ? 4 : 2;
      for (let i = 0; i < perSection; i += 1) {
        const first = FIRST[n % FIRST.length];
        const last = LAST[(n * 7) % LAST.length];
        n += 1;
        const student = await Student.create({
          schoolId,
          admissionNo: `ADM${String(n).padStart(4, '0')}`,
          firstName: first,
          lastName: last,
          gender: n % 2 ? 'male' : 'female',
          dateOfBirth: parseDateOnly(`${2021 - cls.order}-0${(n % 9) + 1}-1${n % 9}`),
          campusId: campus._id,
          admissionDate: parseDateOnly('2026-04-01'),
        });
        await Enrollment.create({ schoolId, studentId: student._id, sessionId: session._id, classId: cls._id, sectionId: sec._id, campusId: campus._id });
        students.push({ student, cls, sec });
      }
    }
  }
  // Roll numbers by name within each section.
  for (const sec of sections) {
    const rows = students.filter((x) => String(x.sec._id) === String(sec._id)).sort((a, b) => a.student.firstName.localeCompare(b.student.firstName));
    for (const [i, row] of rows.entries()) await Enrollment.updateOne({ schoolId, studentId: row.student._id, sessionId: session._id }, { rollNo: i + 1 });
  }

  // One guardian per student; the parent account has two children (Grade 1-A and Grade 3-A).
  const parentUser = await User.findOne({ email: parentEmail });
  const parentMembership = parentUser && (await Membership.findOne({ schoolId, userId: parentUser._id }));
  const kidsOfParent = [students.find((x) => x.cls.name === 'Grade 1'), students.find((x) => x.cls.name === 'Grade 3')].filter(Boolean);
  let familyGuardian = null;
  for (const [i, { student }] of students.entries()) {
    const isFamily = kidsOfParent.some((k) => k.student._id.equals(student._id));
    if (isFamily && familyGuardian) {
      await StudentGuardian.create({ schoolId, studentId: student._id, guardianId: familyGuardian._id, relation: 'mother', isPrimary: true });
      continue;
    }
    const phone = `+91 98${String(10000000 + i).slice(-8)}`;
    const guardian = await Guardian.create({
      schoolId,
      name: isFamily ? 'Greenwood Parent' : `${i % 2 ? 'Mr.' : 'Mrs.'} ${student.lastName}`,
      phone,
      phoneNormalized: phone.replace(/[\s()-]/g, ''),
      email: isFamily ? parentEmail : undefined,
      membershipId: isFamily ? parentMembership?._id ?? null : null,
    });
    if (isFamily) familyGuardian = guardian;
    await StudentGuardian.create({ schoolId, studentId: student._id, guardianId: guardian._id, relation: isFamily ? 'mother' : i % 2 ? 'father' : 'mother', isPrimary: true });
  }

  // Student login for a Grade 5 student.
  const studentUser = await User.findOne({ email: studentEmail });
  const studentMembership = studentUser && (await Membership.findOne({ schoolId, userId: studentUser._id }));
  const g5 = students.find((x) => x.cls.name === 'Grade 5');
  if (g5 && studentMembership) await Student.updateOne({ schoolId, _id: g5.student._id }, { membershipId: studentMembership._id, email: studentEmail });

  // Employee records for staff.
  const staff = await Membership.find({ schoolId, roles: { $in: ['school_owner', 'school_admin', 'accountant', 'teacher'] } }).populate('userId', 'name');
  const DEPT = { school_owner: ['Management', 'Director'], school_admin: ['Administration', 'Administrator'], accountant: ['Accounts', 'Accountant'], teacher: ['Primary', 'PRT'] };
  let e = 0;
  for (const m of staff) {
    const [department, designation] = DEPT[m.roles.find((r) => DEPT[r])];
    e += 1;
    await StaffProfile.create({ schoolId, membershipId: m._id, employeeCode: `EMP${String(e).padStart(4, '0')}`, department, designation, joiningDate: parseDateOnly('2024-06-01') });
  }

  // Admission applications at different stages.
  const nursery = classes.find((c) => c.name === 'Nursery');
  const apps = [
    ['Zara', 'Kapoor', 'female', 'enquiry', 'Rohit Kapoor', '+91 97000 00001'],
    ['Veer', 'Malhotra', 'male', 'applied', 'Pooja Malhotra', '+91 97000 00002'],
    ['Ira', 'Bose', 'female', 'approved', 'Anand Bose', '+91 97000 00003'],
  ];
  for (const [i, [firstName, lastName, gender, status, gName, gPhone]] of apps.entries()) {
    await Admission.create({
      schoolId,
      applicationNo: `APP${String(i + 1).padStart(5, '0')}`,
      sessionId: session._id,
      classId: nursery._id,
      campusId: campus._id,
      applicant: { firstName, lastName, gender, dateOfBirth: parseDateOnly('2023-02-15') },
      guardian: { name: gName, phone: gPhone, phoneNormalized: gPhone.replace(/\s/g, ''), relation: 'father' },
      source: 'walk_in',
      status,
      history: [{ status }],
    });
  }

  await Counter.insertMany([
    { schoolId, key: 'admission_no', seq: n },
    { schoolId, key: 'employee_code', seq: e },
    { schoolId, key: 'application_no', seq: apps.length },
  ]);
}

/**
 * Demo bell schedule, Grade 1 timetables, attendance for the last working days (no alerts:
 * it is historical data) and one pending leave request. Skipped if a schedule exists.
 */
async function seedAttendanceAndTimetable(school, parentEmail) {
  const schoolId = school._id;
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true });
  if (!session || (await BellSchedule.exists({ schoolId }))) return;

  const periods = [
    ['08:00', '08:40'], ['08:40', '09:20'], ['09:20', '10:00'], ['10:00', '10:20', 'Break'],
    ['10:20', '11:00'], ['11:00', '11:40'], ['11:40', '12:20'], ['12:20', '13:00'],
  ].map(([startTime, endTime, label], i) => ({ number: i + 1, startTime, endTime, label: label || `Period ${i + 1}`, isBreak: Boolean(label) }));
  await BellSchedule.create({ schoolId, sessionId: session._id, name: 'Regular Day', workingDays: [1, 2, 3, 4, 5, 6], periods });

  // Grade 1 timetables: the curriculum rotated across the week; the demo teacher takes Maths.
  const grade1 = await SchoolClass.findOne({ schoolId, name: 'Grade 1' });
  const sections = await Section.find({ schoolId, sessionId: session._id, classId: grade1._id }).sort('name');
  const subjects = await ClassSubject.find({ schoolId, sessionId: session._id, classId: grade1._id }).sort('order');
  const teaching = periods.filter((p) => !p.isBreak).map((p) => p.number);
  for (const [si, sec] of sections.entries()) {
    const assignments = await TeachingAssignment.find({ schoolId, sectionId: sec._id }).lean();
    const entries = [];
    for (const day of [1, 2, 3, 4, 5, 6]) {
      for (const [pi, periodNumber] of teaching.slice(0, day === 6 ? 4 : 7).entries()) {
        // Offset by section so a shared teacher is never in two places at once.
        const subject = subjects[(day + pi + si * 3) % subjects.length];
        const a = assignments.find((x) => String(x.subjectId) === String(subject.subjectId));
        const clash = a && entries.some((e) => e.day === day && e.periodNumber === periodNumber && String(e.teacherId) === String(a.teacherId));
        entries.push({ schoolId, sessionId: session._id, sectionId: sec._id, classId: grade1._id, campusId: sec.campusId, day, periodNumber, subjectId: subject.subjectId, teacherId: a && !clash ? a.teacherId : null });
      }
    }
    const taken = await TimetableEntry.find({ schoolId, sessionId: session._id, teacherId: { $ne: null } }).lean();
    for (const e of entries) if (e.teacherId && taken.some((t) => String(t.teacherId) === String(e.teacherId) && t.day === e.day && t.periodNumber === e.periodNumber)) e.teacherId = null;
    await TimetableEntry.insertMany(entries);
  }

  // Attendance for the last 6 working days before today, every section.
  const today = todayIn(school.timezone || 'Asia/Kolkata');
  const holidays = new Set(await nonWorkingDates(schoolId, { from: addDays(today, -20), to: today }));
  const days = [];
  for (let d = addDays(today, -1); days.length < 6 && d >= session.startDate; d = addDays(d, -1)) {
    if (weekday(d) !== 0 && !holidays.has(formatDateOnly(d))) days.push(d);
  }
  const allSections = await Section.find({ schoolId, sessionId: session._id });
  const admin = await User.findOne({ email: 'admin@greenwood.local' });
  let k = 0;
  for (const day of days) {
    for (const sec of allSections) {
      const enrolled = await Enrollment.find({ schoolId, sectionId: sec._id, status: 'active' }).lean();
      if (!enrolled.length) continue;
      const sheet = await AttendanceSheet.create({ schoolId, sessionId: session._id, sectionId: sec._id, classId: sec.classId, campusId: sec.campusId, date: day, markedBy: admin._id, markedAt: day });
      const counts = { total: 0, present: 0, absent: 0, late: 0, leave: 0 };
      const records = enrolled.map((e) => {
        k += 1;
        const status = k % 17 === 0 ? 'absent' : k % 23 === 0 ? 'late' : k % 41 === 0 ? 'leave' : 'present';
        counts[status] += 1;
        counts.total += 1;
        return { schoolId, sheetId: sheet._id, sessionId: session._id, sectionId: sec._id, classId: sec.classId, campusId: sec.campusId, studentId: e.studentId, date: day, status, markedBy: admin._id };
      });
      await AttendanceRecord.insertMany(records);
      await AttendanceSheet.updateOne({ _id: sheet._id, schoolId }, { counts });
    }
  }

  // A pending leave request from the demo parent.
  const parentUser = await User.findOne({ email: parentEmail });
  const guardian = parentUser && (await Guardian.findOne({ schoolId, email: parentEmail }));
  const link = guardian && (await StudentGuardian.findOne({ schoolId, guardianId: guardian._id }));
  if (link) {
    await LeaveRequest.create({ schoolId, studentId: link.studentId, fromDate: addDays(today, 1), toDate: addDays(today, 2), reason: 'Family wedding', requestedBy: parentUser._id, requestedVia: 'portal' });
  }
}

/**
 * Demo fees through the real fee services (same rules, receipts and ledger as the app).
 * Needs a replica set: without transactions this returns a reason instead.
 */
async function seedFees(school, accountantEmail) {
  if (!supportsTransactions()) return 'skipped: MongoDB is not a replica set (see README, "MongoDB transactions")';
  const schoolId = school._id;
  if (await FeeCategory.exists({ schoolId })) return 'already present';
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true });
  if (!session) return 'skipped: no current session';
  const accountant = await User.findOne({ email: accountantEmail });
  const tenant = await resolveMembership(accountant._id, schoolId);
  const ctx = { actorId: accountant._id, schoolId, ip: '127.0.0.1', userAgent: 'seed' };

  const cat = {};
  for (const [name, code] of [['Tuition Fee', 'TUITION'], ['Annual Charges', 'ANNUAL'], ['Exam Fee', 'EXAM']]) cat[code] = (await createCategory(tenant, { name, code }, ctx))._id;
  const classes = await SchoolClass.find({ schoolId }).sort('order');
  const q = (name, date, extra = []) => ({ name, dueDate: parseDateOnly(date), items: [{ categoryId: cat.TUITION, amount: 1200000 }, ...extra] });
  const structure = await createStructure(
    tenant,
    {
      sessionId: session._id,
      name: 'School Fees 2026-27',
      classIds: classes.map((c) => c._id),
      installments: [
        q('Quarter 1', '2026-04-10', [{ categoryId: cat.ANNUAL, amount: 500000 }]),
        q('Quarter 2', '2026-07-10'),
        q('Quarter 3', '2026-10-10', [{ categoryId: cat.EXAM, amount: 150000 }]),
        q('Quarter 4', '2027-01-10', [{ categoryId: cat.EXAM, amount: 150000 }]),
      ],
      lateFee: { type: 'per_day', amount: 1000, graceDays: 5, maxAmount: 50000 },
    },
    ctx,
  );
  const sibling = await createDiscount(tenant, { name: 'Sibling discount', type: 'percent', value: 10, categoryIds: [cat.TUITION] }, ctx);

  // Students of the demo parent get the sibling discount; everyone else the plain structure.
  const parent = await Guardian.findOne({ schoolId, email: 'parent@greenwood.local' });
  const siblings = parent ? (await StudentGuardian.find({ schoolId, guardianId: parent._id })).map((l) => String(l.studentId)) : [];
  if (siblings.length) await assignFees(tenant, { structureId: structure._id, studentIds: siblings, discountIds: [sibling._id] }, ctx);
  for (const sec of await Section.find({ schoolId, sessionId: session._id })) await assignFees(tenant, { structureId: structure._id, sectionId: sec._id }, ctx);

  // Payments: most families paid quarters 1-2 and many paid quarter 3; a few are behind.
  const today = todayIn(school.timezone || 'Asia/Kolkata');
  const students = await Student.find({ schoolId }).sort('admissionNo');
  const methods = ['cash', 'upi', 'bank_transfer', 'cash', 'card'];
  let n = 0;
  for (const s of students) {
    n += 1;
    const invoices = await FeeInvoice.find({ schoolId, studentId: s._id, status: { $ne: 'cancelled' } }).sort({ dueDate: 1 });
    const paidQuarters = n % 7 === 0 ? 1 : n % 3 === 0 ? 2 : 3;
    for (const inv of invoices.slice(0, paidQuarters)) {
      if (inv.dueDate > today) break;
      const method = methods[n % methods.length];
      const paidAt = addDays(inv.dueDate, -(n % 4));
      await collectPayment(tenant, { studentId: s._id, allocations: [{ invoiceId: inv._id, amount: inv.total - inv.paidAmount }], method, reference: method === 'cash' ? undefined : `REF${1000 + n}`, paidAt }, ctx);
    }
  }
  const late = await applyLateFees(schoolId, today);
  await School.updateOne({ _id: schoolId }, { $set: { 'settings.fees.reminders.enabled': true } });
  return `${await FeeInvoice.countDocuments({ schoolId })} invoices, ${await Payment.countDocuments({ schoolId })} payments, late fees on ${late.invoicesUpdated} invoices, reminders on`;
}

/** Demo exams through the exam services: a published unit test with marks, an upcoming term exam. */
async function seedExams(school, adminEmail) {
  const schoolId = school._id;
  if (await GradingScale.exists({ schoolId })) return 'already present';
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true });
  if (!session) return 'skipped: no current session';
  const admin = await User.findOne({ email: adminEmail });
  const tenant = await resolveMembership(admin._id, schoolId);
  const ctx = { actorId: admin._id, schoolId, ip: '127.0.0.1', userAgent: 'seed' };

  await createScale(
    tenant,
    {
      name: 'CBSE 9-point',
      bands: [['A1', 91, 10], ['A2', 81, 9], ['B1', 71, 8], ['B2', 61, 7], ['C1', 51, 6], ['C2', 41, 5], ['D', 33, 4], ['E', 0, 0]].map(([grade, minPercent, gradePoint]) => ({ grade, minPercent, gradePoint })),
    },
    ctx,
  );
  const classes = await SchoolClass.find({ schoolId }).sort('order');
  const classIds = classes.map((c) => c._id);
  const unit = await createExam(tenant, { sessionId: session._id, name: 'Unit Test 1', type: 'unit_test', classIds, startDate: parseDateOnly('2026-07-20'), endDate: parseDateOnly('2026-07-25'), weightage: 20 }, ctx);
  const half = await createExam(tenant, { sessionId: session._id, name: 'Half Yearly', type: 'term', classIds, startDate: parseDateOnly('2026-12-07'), endDate: parseDateOnly('2026-12-14'), weightage: 30 }, ctx);

  let k = 0;
  for (const cls of classes) {
    const subjects = await ClassSubject.find({ schoolId, sessionId: session._id, classId: cls._id }).sort('order');
    const papers = (start, max, pass) => subjects.map((s, i) => ({ subjectId: s.subjectId, date: addDays(parseDateOnly(start), Math.min(i, 5)), startTime: '09:00', endTime: '10:30', maxMarks: max, passMarks: pass }));
    await setClassPapers(tenant, unit._id, { classId: cls._id, papers: papers('2026-07-20', 25, 8) }, ctx);
    await setClassPapers(tenant, half._id, { classId: cls._id, papers: papers('2026-12-07', 80, 27) }, ctx);
    const unitPapers = await ExamPaper.find({ schoolId, examId: unit._id, classId: cls._id });
    for (const sec of await Section.find({ schoolId, sessionId: session._id, classId: cls._id })) {
      const enrolled = await Enrollment.find({ schoolId, sectionId: sec._id, status: 'active' });
      if (!enrolled.length) continue;
      for (const p of unitPapers) {
        const entries = enrolled.map((e) => {
          k += 1;
          if (k % 29 === 0) return { studentId: e.studentId, status: 'absent' };
          return { studentId: e.studentId, marks: 9 + ((k * 7) % 17), status: 'present' };
        });
        await saveMarks(tenant, unit._id, p._id, { sectionId: sec._id, entries }, ctx);
      }
    }
  }
  const published = await publishResults(tenant, unit._id, {}, ctx);
  return `grading scale, Unit Test 1 published (${published.pass} pass / ${published.fail} fail), Half Yearly scheduled for December`;
}

/** Demo library, inventory, hostel and HR data through the module services. */
async function seedServices(school, adminEmail) {
  const schoolId = school._id;
  if (await Book.exists({ schoolId })) return 'already present';
  const admin = await User.findOne({ email: adminEmail });
  const tenant = await resolveMembership(admin._id, schoolId);
  const ctx = { actorId: admin._id, schoolId, ip: '127.0.0.1', userAgent: 'seed' };

  const books = [];
  for (const [title, author, category, copies] of [
    ['Wings of Fire', 'A. P. J. Abdul Kalam', 'Biography', 3], ['The Jungle Book', 'Rudyard Kipling', 'Fiction', 4], ['Panchatantra Tales', 'Vishnu Sharma', 'Stories', 5],
    ['Malgudi Days', 'R. K. Narayan', 'Fiction', 2], ['Children’s Encyclopedia', 'Various', 'Reference', 1], ['Ruskin Bond Stories', 'Ruskin Bond', 'Stories', 3],
  ]) books.push(await createBook(tenant, { title, author, category, shelf: category.slice(0, 1) + '1', copies }, ctx));
  const students = await Student.find({ schoolId, status: 'active' }).sort('admissionNo').limit(6);
  for (const [i, s] of students.entries()) await issueBook(tenant, { bookId: books[i % books.length]._id, studentId: s._id }, ctx);

  for (const [name, code, category, unit, qty, reorder] of [
    ['A4 paper (ream)', 'A4-REAM', 'Stationery', 'ream', 40, 10], ['Whiteboard marker', 'MARKER-BLK', 'Stationery', 'pcs', 6, 20],
    ['Chalk box', 'CHALK', 'Stationery', 'box', 25, 10], ['Football', 'FOOTBALL', 'Sports', 'pcs', 8, 4], ['First-aid kit', 'FIRSTAID', 'Medical', 'kit', 3, 2],
  ]) await createItem(tenant, { name, code, category, unit, reorderLevel: reorder, openingQuantity: qty }, ctx);

  const teacher = await Membership.findOne({ schoolId, roles: 'teacher' }).sort({ createdAt: 1 });
  const boys = await saveHostel(tenant, null, { name: 'Boys Hostel', type: 'boys', wardenId: teacher?._id ?? null }, ctx);
  const girls = await saveHostel(tenant, null, { name: 'Girls Hostel', type: 'girls' }, ctx);
  const rooms = { male: [], female: [] };
  for (const n of ['101', '102', '103']) rooms.male.push(await createRoom(tenant, boys._id, { number: n, floor: '1', capacity: 3 }, ctx));
  for (const n of ['201', '202']) rooms.female.push(await createRoom(tenant, girls._id, { number: n, floor: '2', capacity: 3 }, ctx));
  const residents = await Student.find({ schoolId, status: 'active' }).sort({ admissionNo: -1 }).limit(8);
  for (const [i, s] of residents.entries()) {
    const list = rooms[s.gender] || rooms.male;
    await allocate(tenant, { studentId: s._id, roomId: list[i % list.length]._id }, ctx).catch(() => {});
  }

  const staff = await Membership.find({ schoolId, roles: { $in: ['school_admin', 'accountant', 'teacher'] } });
  for (const [i, m] of staff.entries()) await saveSalary(tenant, m._id, { basic: 2500000 + i * 300000, allowances: [{ name: 'HRA', amount: 600000 }, { name: 'Transport allowance', amount: 160000 }], deductions: [{ name: 'Provident fund', amount: 180000 }] }, ctx);
  if (teacher) {
    const teacherTenant = await resolveMembership(teacher.userId, schoolId);
    const start = addDays(todayIn(school.timezone || 'Asia/Kolkata'), 10);
    await applyLeave(teacherTenant, { type: 'casual', fromDate: start, toDate: addDays(start, 1), reason: 'Family function' }, { ...ctx, actorId: teacher.userId }).catch(() => {});
  }
  return `${books.length} books (${students.length} on loan), 5 store items, 2 hostels, salaries for ${staff.length} staff, 1 pending staff leave`;
}

async function seedCommunication(school, adminEmail) {
  const schoolId = school._id;
  if (await Announcement.exists({ schoolId })) return 'already present';
  const admin = await User.findOne({ email: adminEmail });
  const tenant = await resolveMembership(admin._id, schoolId);
  const ctx = { actorId: admin._id, schoolId, ip: '127.0.0.1', userAgent: 'seed' };
  const grade1 = await SchoolClass.findOne({ schoolId, name: 'Grade 1' }).lean();
  const make = async (data, send) => {
    const a = await createAnnouncement(tenant, data, ctx);
    return send ? sendAnnouncement(tenant, a._id, {}, ctx) : a;
  };
  const sent = [];
  sent.push(await make({ kind: 'notice', title: 'Annual Sports Day', body: 'Annual Sports Day will be held on the school ground next Friday from 8:30 am. Students should come in sports uniform. Parents are welcome.', audience: { scope: 'everyone' }, pinned: true }, true));
  sent.push(await make({ kind: 'announcement', title: 'Parent-teacher meeting', body: 'The parent-teacher meeting for Grade 1 is on Saturday, 10 am to 1 pm. Please meet your child’s class teacher.', audience: { scope: 'parents', classIds: grade1 ? [grade1._id] : [] } }, true));
  sent.push(await make({ kind: 'notice', title: 'Staff meeting', body: 'All staff: meeting in the staff room on Monday at 3:30 pm to plan the half-yearly examinations.', audience: { scope: 'staff' } }, true));
  await make({ kind: 'announcement', title: 'Winter uniform from next month', body: 'Students may wear the winter uniform (navy sweater and blazer) from the 1st of next month.', audience: { scope: 'families' } }, false);
  return `${sent.length} sent (2 notices on the board), 1 draft; ${sent.reduce((t, a) => t + a.stats.recipients, 0)} recipients in total`;
}

async function addMember(school, user, roles) {
  await Membership.updateOne(
    { schoolId: school._id, userId: user._id },
    { $setOnInsert: { schoolId: school._id, userId: user._id, roles, status: 'active' } },
    { upsert: true },
  );
}

async function main() {
  await connectDB();
  if (process.argv.includes('--reset')) {
    await mongoose.connection.dropDatabase();
    console.log(`Dropped database ${mongoose.connection.name}`);
  }
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

  const superAdmin = await upsertUser({ name: 'Platform Admin', email: process.env.SEED_SUPERADMIN_EMAIL || 'superadmin@erp.local', platformRole: 'super_admin' });

  const plans = {};
  for (const p of PLANS) plans[p.code] = await upsertPlan(p);

  const greenwood = await upsertSchool({ name: 'Greenwood Public School', code: 'greenwood', type: 'school' }, superAdmin._id, plans.premium);
  const brightminds = await upsertSchool({ name: 'Bright Minds Coaching', code: 'brightminds', type: 'coaching' }, superAdmin._id, plans.starter, { trial: true });

  const accounts = [
    [greenwood, { name: 'Greenwood Owner', email: 'owner@greenwood.local' }, ['school_owner']],
    [greenwood, { name: 'Greenwood Admin', email: 'admin@greenwood.local' }, ['school_admin']],
    [greenwood, { name: 'Greenwood Accountant', email: 'accounts@greenwood.local' }, ['accountant']],
    [greenwood, { name: 'Greenwood Teacher', email: 'teacher@greenwood.local' }, ['teacher']],
    [brightminds, { name: 'Bright Minds Owner', email: 'owner@brightminds.local' }, ['school_owner']],
    [greenwood, { name: 'Shared Teacher', email: 'shared.teacher@erp.local' }, ['teacher']],
    [brightminds, { name: 'Shared Teacher', email: 'shared.teacher@erp.local' }, ['teacher', 'school_admin']],
    [greenwood, { name: 'Greenwood Parent', email: 'parent@greenwood.local' }, ['parent']],
    [greenwood, { name: 'Greenwood Student', email: 'student@greenwood.local' }, ['student']],
  ];
  for (const [school, info, roles] of accounts) {
    const user = await upsertUser(info);
    await addMember(school, user, roles);
  }

  await seedAcademics(greenwood, 'teacher@greenwood.local');
  await seedPeople(greenwood, { parentEmail: 'parent@greenwood.local', studentEmail: 'student@greenwood.local' });
  await seedAttendanceAndTimetable(greenwood, 'parent@greenwood.local');
  const feeResult = await seedFees(greenwood, 'accounts@greenwood.local');
  const examResult = await seedExams(greenwood, 'admin@greenwood.local');
  const servicesResult = await seedServices(greenwood, 'admin@greenwood.local');
  const commResult = await seedCommunication(greenwood, 'admin@greenwood.local');

  console.log('\nSeed complete. All accounts use password:', PASSWORD);
  console.log('  greenwood academics: session 2026-27, Nursery–Grade 5 (sections A/B), 6 subjects, holidays');
  console.log('  greenwood people:    36 students with parents, staff employee records, 3 admission applications');
  console.log('  greenwood daily:     bell schedule, Grade 1 timetables, attendance for the last 6 working days, 1 pending leave request');
  console.log(`  greenwood fees:      ${feeResult}`);
  console.log(`  greenwood exams:     ${examResult}`);
  console.log(`  greenwood services:  ${servicesResult}`);
  console.log(`  greenwood messages:  ${commResult}`);
  console.log(`  plans            ${PLANS.map((p) => p.code).join(', ')}  (greenwood: premium, brightminds: starter trial)`);
  console.log(`  super admin      ${superAdmin.email}`);
  for (const [school, info, roles] of accounts) console.log(`  ${school.code.padEnd(16)} ${info.email.padEnd(28)} ${roles.join(', ')}`);
  await settleBackgroundWork();
  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
