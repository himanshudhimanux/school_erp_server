import { expandPermissions } from './permissions.js';

/** Platform-level role (stored on User.platformRole). Never grants tenant access implicitly. */
export const PLATFORM_ROLES = Object.freeze({ SUPER_ADMIN: 'super_admin' });

/** Built-in school roles (stored on Membership.roles). Custom school roles arrive in Phase 2. */
export const SCHOOL_ROLES = Object.freeze({
  SCHOOL_OWNER: 'school_owner',
  SCHOOL_ADMIN: 'school_admin',
  PRINCIPAL: 'principal',
  ACCOUNTANT: 'accountant',
  TEACHER: 'teacher',
  STAFF: 'staff',
  PARENT: 'parent',
  STUDENT: 'student',
});

export const SCHOOL_ROLE_VALUES = Object.freeze(Object.values(SCHOOL_ROLES));

/** Roles that count as staff seats (plan `maxUsers`) and may be assigned via member management. */
export const STAFF_ROLE_VALUES = Object.freeze(['school_owner', 'school_admin', 'principal', 'accountant', 'teacher', 'staff']);

/** Parent/student memberships are created by the student & parent modules (Phase 4), not directly. */
export const FAMILY_ROLE_VALUES = Object.freeze(['parent', 'student']);

export const ROLE_LABELS = Object.freeze({
  school_owner: 'School Owner',
  school_admin: 'School Admin',
  principal: 'Principal',
  accountant: 'Accountant',
  teacher: 'Teacher',
  staff: 'Staff',
  parent: 'Parent',
  student: 'Student',
});

const ROLE_PERMISSION_SPEC = {
  school_owner: ['*'],
  school_admin: [
    'school.*', 'campuses.*', 'users.*', 'roles.*', 'academics.*', 'calendar.*', 'students.*', 'parents.*', 'staff.*',
    'admissions.*', 'attendance.*', 'timetable.*', 'fees.*', 'exams.*', 'homework.*', 'communication.*',
    'reports.*', 'settings.*', 'audit.read', 'subscription.read', 'library.*', 'hr.*', 'inventory.*', 'hostel.*',
  ],
  principal: [
    'school.read', 'campuses.read', 'users.read', 'academics.*', 'calendar.*', 'students.*', 'parents.read', 'staff.read',
    'admissions.*', 'attendance.*', 'timetable.*', 'fees.read', 'fees.reports', 'exams.*', 'homework.*',
    'communication.*', 'reports.read', 'audit.read', 'library.*', 'hr.read', 'hr.update', 'hr.self', 'inventory.read', 'hostel.*',
  ],
  accountant: [
    'school.read', 'campuses.read', 'academics.read', 'calendar.read', 'students.read', 'parents.read',
    'fees.*', 'reports.read', 'communication.read', 'communication.send', 'hr.read', 'hr.payroll', 'hr.self', 'inventory.*', 'library.read',
  ],
  teacher: [
    'school.read', 'academics.read', 'calendar.read', 'students.read', 'parents.read', 'attendance.read', 'attendance.mark',
    'timetable.read', 'exams.read', 'exams.marks', 'homework.*', 'communication.read', 'communication.create', 'library.read', 'hr.self',
  ],
  // General staff (librarian, office clerk): library desk, store room, own HR.
  staff: ['school.read', 'academics.read', 'calendar.read', 'communication.read', 'library.read', 'library.issue', 'hr.self', 'inventory.read'],
  // Parent and student access is further restricted to their own/linked records in each service.
  parent: ['school.read', 'calendar.read', 'attendance.read', 'timetable.read', 'fees.read', 'exams.read', 'homework.read', 'communication.read', 'library.read', 'hostel.read'],
  student: ['school.read', 'calendar.read', 'attendance.read', 'timetable.read', 'exams.read', 'homework.read', 'communication.read', 'library.read', 'hostel.read'],
};

export const ROLE_PERMISSIONS = Object.freeze(
  Object.fromEntries(Object.entries(ROLE_PERMISSION_SPEC).map(([role, spec]) => [role, Object.freeze([...expandPermissions(spec)])])),
);

export function permissionsForRoles(roles) {
  const out = new Set();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] || []) out.add(p);
  return out;
}
