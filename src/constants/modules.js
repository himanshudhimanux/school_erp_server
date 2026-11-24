/**
 * ERP module catalogue used for subscription entitlements.
 *
 * Each permission `<module>.<action>` belongs to the module named by its prefix.
 * CORE modules are available to every school with a usable subscription state
 * (and remain available when a subscription lapses, so admins can still manage the
 * account and renew). PLAN modules must be included in the school's subscription.
 *
 * Modules from later phases (library, hr, inventory, hostel, ...) are appended to
 * PLAN_MODULES when they are implemented.
 */
export const CORE_MODULES = Object.freeze([
  'school',
  'campuses',
  'users',
  'roles',
  'settings',
  'subscription',
  'audit',
  'academics',
  'calendar',
  'students',
  'parents',
  'staff',
]);

export const PLAN_MODULES = Object.freeze(['admissions', 'attendance', 'timetable', 'fees', 'exams', 'homework', 'communication', 'reports', 'library', 'hr', 'inventory', 'hostel']);

export const MODULE_LABELS = Object.freeze({
  admissions: 'Admissions',
  attendance: 'Attendance & Parent Alerts',
  timetable: 'Timetable',
  fees: 'Fees & Automated Reminders',
  exams: 'Examinations & Results',
  homework: 'Homework & Assignments',
  communication: 'Communication & Notifications',
  reports: 'Reports & Analytics',
  library: 'Library',
  hr: 'HR & Payroll',
  inventory: 'Inventory',
  hostel: 'Hostel',
});

const CORE_SET = new Set(CORE_MODULES);
export const isCoreModule = (m) => CORE_SET.has(m);
export const moduleOfPermission = (permission) => permission.split('.')[0];
