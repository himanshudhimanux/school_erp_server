import mongoose from 'mongoose';
import { Student, Enrollment } from './student.model.js';
import { Guardian, StudentGuardian } from '../parents/guardian.model.js';
import { AcademicSession } from '../academics/academics.models.js';
import { getTeacherScope } from '../academics/curriculum.service.js';
import { isCampusRestricted } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';

/**
 * Who may see which students.
 *
 * - Members with a management role (owner, admin, principal, accountant) or any custom role
 *   see every student, limited to their campuses when campus-restricted.
 * - Members whose only student-reading role is `teacher` see the students actively enrolled in
 *   the sections they teach or are class teacher of (current session unless one is given).
 * - Parents and students never use these lists; they go through /portal (familyStudentIds).
 */
const FULL_ACCESS_ROLES = ['school_owner', 'school_admin', 'principal', 'accountant'];

export const hasStaffRole = (tenant) => tenant.roles.some((r) => STAFF_ROLE_VALUES.includes(r)) || tenant.customRoles?.length > 0;

export const isSectionScopedTeacher = (tenant) =>
  tenant.roles.includes('teacher') && !tenant.roles.some((r) => FULL_ACCESS_ROLES.includes(r)) && !(tenant.customRoles?.length > 0);

/**
 * Returns { restricted, campusIds, studentIds, sectionIds } for the caller.
 * `studentIds`/`sectionIds` are null unless the caller is a section-scoped teacher.
 */
export async function studentAccess(tenant, { sessionId } = {}) {
  // Members without any staff role (parents, students) only ever reach their own family's records.
  if (!hasStaffRole(tenant)) {
    return { restricted: true, campusIds: null, studentIds: new Set(await familyStudentIds(tenant)), sectionIds: [] };
  }
  const campusIds = isCampusRestricted(tenant) ? tenant.campusIds.map(String) : null;
  let studentIds = null;
  let sectionIds = null;
  if (isSectionScopedTeacher(tenant)) {
    const session = sessionId ? { _id: sessionId } : await AcademicSession.findOne({ schoolId: tenant.schoolId, isCurrent: true }).select('_id').lean();
    if (session) {
      const scope = await getTeacherScope(tenant.schoolId, tenant.membershipId, session._id);
      sectionIds = scope.sectionIds;
      const ids = sectionIds.length
        ? await Enrollment.distinct('studentId', { schoolId: tenant.schoolId, sessionId: session._id, sectionId: { $in: sectionIds }, status: 'active' })
        : [];
      studentIds = new Set(ids.map(String));
    } else {
      sectionIds = [];
      studentIds = new Set();
    }
  }
  return { restricted: Boolean(campusIds || studentIds), campusIds, studentIds, sectionIds };
}

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Mongo filter fragment on Student for an access object (ObjectIds, so it also works in aggregations). */
export function studentFilter(access) {
  const f = {};
  if (access.campusIds) f.campusId = { $in: access.campusIds.map(oid) };
  if (access.studentIds) f._id = { $in: [...access.studentIds].map(oid) };
  return f;
}

export function canAccessStudent(access, student) {
  if (access.campusIds && !access.campusIds.includes(String(student.campusId))) return false;
  if (access.studentIds && !access.studentIds.has(String(student._id))) return false;
  return true;
}

export function assertSectionAccess(access, section) {
  if (access.campusIds && !access.campusIds.includes(String(section.campusId))) {
    throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
  }
  if (access.sectionIds && !access.sectionIds.includes(String(section._id))) {
    throw ApiError.forbidden('You can only view sections you teach', { code: 'SECTION_ACCESS_DENIED' });
  }
}

/** Loads a student the caller may see (404 otherwise, so ids from other scopes are not revealed). */
export async function getStudentDoc(tenant, studentId, access) {
  const student = await Student.findOne({ _id: studentId, schoolId: tenant.schoolId });
  if (!student) throw ApiError.notFound('Student not found');
  const acc = access || (await studentAccess(tenant));
  if (!canAccessStudent(acc, student)) throw ApiError.notFound('Student not found');
  return student;
}

/**
 * Students the signed-in parent or student may see: a parent's linked children plus the
 * student's own record. Later modules (attendance, fees, exams, homework) use this to limit
 * family access to their own data.
 */
export async function familyStudentIds(tenant) {
  const ids = new Set();
  if (tenant.roles.includes('parent')) {
    const guardian = await Guardian.findOne({ schoolId: tenant.schoolId, membershipId: tenant.membershipId }).select('_id').lean();
    if (guardian) {
      const links = await StudentGuardian.find({ schoolId: tenant.schoolId, guardianId: guardian._id }).select('studentId').lean();
      for (const l of links) ids.add(String(l.studentId));
    }
  }
  if (tenant.roles.includes('student')) {
    const self = await Student.findOne({ schoolId: tenant.schoolId, membershipId: tenant.membershipId }).select('_id').lean();
    if (self) ids.add(String(self._id));
  }
  return [...ids];
}
