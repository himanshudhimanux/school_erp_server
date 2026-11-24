/**
 * Permission keys follow `<module>.<action>`.
 * They are checked on the backend only (middleware/authorize.js); clients may read them
 * to hide UI but are never trusted to enforce them.
 */
const MODULE_ACTIONS = {
  school: ['read', 'update'],
  campuses: ['read', 'create', 'update', 'delete'],
  users: ['read', 'create', 'update', 'delete'],
  roles: ['read', 'create', 'update', 'delete'],
  academics: ['read', 'create', 'update', 'delete'],
  calendar: ['read', 'create', 'update', 'delete'],
  students: ['read', 'create', 'update', 'delete'],
  parents: ['read', 'create', 'update', 'delete'],
  staff: ['read', 'create', 'update', 'delete'],
  admissions: ['read', 'create', 'update', 'delete'],
  attendance: ['read', 'mark', 'update', 'reports'],
  timetable: ['read', 'create', 'update', 'delete'],
  fees: ['read', 'create', 'update', 'delete', 'collect', 'refund', 'reports'],
  exams: ['read', 'create', 'update', 'delete', 'marks', 'publish'],
  homework: ['read', 'create', 'update', 'delete', 'evaluate'],
  communication: ['read', 'create', 'send'],
  reports: ['read'],
  library: ['read', 'create', 'update', 'delete', 'issue'],
  hr: ['read', 'update', 'payroll', 'self'],
  inventory: ['read', 'create', 'update', 'delete'],
  hostel: ['read', 'create', 'update', 'delete'],
  settings: ['read', 'update'],
  subscription: ['read', 'update'],
  audit: ['read'],
};

export const PERMISSIONS = Object.freeze(
  Object.entries(MODULE_ACTIONS).flatMap(([mod, actions]) => actions.map((a) => `${mod}.${a}`)),
);

const PERMISSION_SET = new Set(PERMISSIONS);
export const isValidPermission = (p) => PERMISSION_SET.has(p);

/** Expands a list containing wildcards like `fees.*` or `*` into concrete permission keys. */
export function expandPermissions(list) {
  const out = new Set();
  for (const entry of list) {
    if (entry === '*') return new Set(PERMISSIONS);
    if (entry.endsWith('.*')) {
      const mod = entry.slice(0, -2);
      for (const p of PERMISSIONS) if (p.startsWith(`${mod}.`)) out.add(p);
    } else if (PERMISSION_SET.has(entry)) {
      out.add(entry);
    } else {
      throw new Error(`Unknown permission: ${entry}`);
    }
  }
  return out;
}
