import { School } from '../schools/school.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { Plan } from '../subscriptions/plan.model.js';
import { Membership } from '../memberships/membership.model.js';
import { User } from '../users/user.model.js';
import { Student } from '../students/student.model.js';
import { Guardian } from '../parents/guardian.model.js';
import { effectiveStatus } from '../subscriptions/subscription.service.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';

const DAY = 86400000;
// Deliberate cross-tenant reads: this is the platform owner's view across every school.
const ALL = { skipTenantCheck: true };

/** Monthly value of a subscription's agreed price (yearly ÷ 12; custom cycles counted as monthly). */
const monthlyValue = (sub) => (sub.billingCycle === 'yearly' ? Math.round((sub.priceAmount || 0) / 12) : sub.priceAmount || 0);

async function countBySchool(Model, match) {
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: '$schoolId', n: { $sum: 1 } } }]).option(ALL);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * Platform analytics for the super admin. Everything is counted from stored records:
 *  - subscription status uses the same expiry rules as access control (period end + grace);
 *  - "recurring revenue" is the agreed subscription price of paying (active) schools, not money
 *    received — the platform does not collect subscription payments itself.
 */
export async function platformAnalytics({ now = new Date() } = {}) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yearAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const [schools, subs, plans, students, staff, parents, parentLogins, studentLogins, totalUsers, activeUsers30] = await Promise.all([
    School.find({}).select('name code type status createdAt address.city').lean(),
    Subscription.find({}).setOptions(ALL).lean(),
    Plan.find({}).select('name code isActive priceMonthly currency').sort('sortOrder priceMonthly').lean(),
    countBySchool(Student, { isDeleted: false, status: 'active' }),
    countBySchool(Membership, { status: 'active', roles: { $in: STAFF_ROLE_VALUES } }),
    countBySchool(Guardian, { isDeleted: false }),
    countBySchool(Membership, { status: 'active', roles: 'parent' }),
    countBySchool(Membership, { status: 'active', roles: 'student' }),
    User.countDocuments({ status: 'active' }),
    User.countDocuments({ status: 'active', lastLoginAt: { $gte: new Date(now.getTime() - 30 * DAY) } }),
  ]);

  const subBy = new Map(subs.map((s) => [String(s.schoolId), s]));
  const count = (map) => [...map.values()].reduce((t, n) => t + n, 0);

  const byStatus = {};
  const bySubStatus = {};
  const byType = {};
  const planStats = new Map(plans.map((p) => [String(p._id), { planId: p._id, name: p.name, code: p.code, isActive: p.isActive, schools: 0, students: 0, monthlyRevenue: 0 }]));
  let monthlyRevenue = 0;
  const currencies = new Set();
  const attention = [];
  const rows = [];

  for (const s of schools) {
    const id = String(s._id);
    const sub = subBy.get(id);
    const subStatus = sub ? effectiveStatus(sub, now) : 'none';
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    byType[s.type] = (byType[s.type] || 0) + 1;
    if (s.status === 'active') bySubStatus[subStatus] = (bySubStatus[subStatus] || 0) + 1;
    const value = s.status === 'active' && subStatus === 'active' && sub ? monthlyValue(sub) : 0;
    if (value) {
      monthlyRevenue += value;
      currencies.add(sub.currency || 'INR');
    }
    const p = sub && planStats.get(String(sub.planId));
    if (p && s.status === 'active') {
      p.schools += 1;
      p.students += students.get(id) || 0;
      p.monthlyRevenue += value;
    }
    const row = {
      schoolId: s._id,
      name: s.name,
      code: s.code,
      type: s.type,
      city: s.address?.city ?? null,
      status: s.status,
      createdAt: s.createdAt,
      plan: sub?.planName ?? null,
      subscriptionStatus: subStatus,
      periodEnd: sub?.currentPeriodEnd ?? null,
      students: students.get(id) || 0,
      maxStudents: sub?.limits?.maxStudents ?? null,
      staff: staff.get(id) || 0,
      parents: parents.get(id) || 0,
      monthlyRevenue: value,
    };
    rows.push(row);

    // Needs the platform owner's attention: trials/periods ending within 14 days, lapsed, or near the student limit.
    if (s.status !== 'active') continue;
    const daysLeft = sub ? Math.ceil((new Date(sub.currentPeriodEnd).getTime() - now.getTime()) / DAY) : null;
    if (subStatus === 'none') attention.push({ ...row, reason: 'No subscription' });
    else if (subStatus === 'expired' || subStatus === 'cancelled') attention.push({ ...row, reason: subStatus === 'expired' ? 'Subscription expired' : 'Subscription cancelled' });
    else if (subStatus === 'past_due') attention.push({ ...row, reason: 'Payment overdue (in grace period)' });
    else if (daysLeft !== null && daysLeft <= 14) attention.push({ ...row, reason: subStatus === 'trialing' ? `Trial ends in ${Math.max(daysLeft, 0)} day(s)` : `Renewal due in ${Math.max(daysLeft, 0)} day(s)` });
    else if (row.maxStudents && row.students >= row.maxStudents * 0.9) attention.push({ ...row, reason: `Near student limit (${row.students}/${row.maxStudents})` });
  }

  // New schools per month for the last 12 months.
  const growth = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(Date.UTC(yearAgo.getUTCFullYear(), yearAgo.getUTCMonth() + i, 1));
    growth.push({ month: d.toISOString().slice(0, 7), schools: 0 });
  }
  const gBy = new Map(growth.map((g) => [g.month, g]));
  for (const s of schools) {
    const g = gBy.get(new Date(s.createdAt).toISOString().slice(0, 7));
    if (g) g.schools += 1;
  }

  return {
    asOf: now,
    schools: { total: schools.length, byStatus, byType, newThisMonth: schools.filter((s) => s.createdAt >= monthStart).length },
    subscriptions: { byStatus: bySubStatus },
    people: {
      students: count(students),
      staff: count(staff),
      parents: count(parents),
      parentLogins: count(parentLogins),
      studentLogins: count(studentLogins),
      users: totalUsers,
      activeUsers30d: activeUsers30,
    },
    revenue: { monthlyRecurring: monthlyRevenue, annualRunRate: monthlyRevenue * 12, currency: currencies.size === 1 ? [...currencies][0] : currencies.size ? 'MIXED' : 'INR' },
    plans: [...planStats.values()],
    growth,
    attention: attention.sort((a, b) => (a.periodEnd ? new Date(a.periodEnd) : 0) - (b.periodEnd ? new Date(b.periodEnd) : 0)).slice(0, 25),
    topSchools: rows.sort((a, b) => b.students - a.students),
  };
}
