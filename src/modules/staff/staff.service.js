import mongoose from 'mongoose';
import { StaffProfile } from './staffProfile.model.js';
import { Membership } from '../memberships/membership.model.js';
import { User } from '../users/user.model.js';
import { addMember, getMember } from '../memberships/membership.service.js';
import { teacherWorkload } from '../academics/curriculum.service.js';
import { STAFF_ROLE_VALUES, ROLE_LABELS } from '../../constants/roles.js';
import { nextFreeCode } from '../counters/counter.model.js';
import { escapeRegex } from '../common/person.schema.js';
import { isCampusRestricted } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { registerDeleteHook } from '../../utils/dependencyGuards.js';
import { recordAudit } from '../audit/audit.service.js';
import { logger } from '../../utils/logger.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const EMPLOYEE_CODE_PREFIX = 'EMP';

// Removing a member from the school removes their employee record (the audit log keeps the history).
registerDeleteHook('member', (schoolId, membershipId) => StaffProfile.deleteOne({ schoolId, membershipId }));

const isStaffMembership = (m) => m.roles.some((r) => STAFF_ROLE_VALUES.includes(r)) || m.customRoleIds?.length > 0;
const staffMatch = { $or: [{ roles: { $in: STAFF_ROLE_VALUES } }, { 'customRoleIds.0': { $exists: true } }] };

/** Campus visibility: staff with no campus restriction are visible to everyone. */
function campusVisibility(campusIds) {
  return { $or: [{ campusIds: { $size: 0 } }, { campusIds: { $in: campusIds.map(oid) } }] };
}
function canSeeMember(tenant, member) {
  if (!isCampusRestricted(tenant) || !member.campusIds?.length) return true;
  const mine = new Set(tenant.campusIds.map(String));
  return member.campusIds.some((c) => mine.has(String(c)));
}

const profileView = (p) =>
  p
    ? {
        employeeCode: p.employeeCode,
        department: p.department ?? null,
        designation: p.designation ?? null,
        employmentType: p.employmentType,
        employmentStatus: p.employmentStatus,
        joiningDate: p.joiningDate ?? null,
        exitDate: p.exitDate ?? null,
        dateOfBirth: p.dateOfBirth ?? null,
        gender: p.gender ?? null,
        qualification: p.qualification ?? null,
        experienceYears: p.experienceYears ?? null,
        address: p.address ?? null,
        emergencyContact: p.emergencyContact ?? null,
        notes: p.notes ?? null,
        updatedAt: p.updatedAt,
      }
    : null;

export async function listStaff(tenant, { page, limit, search, role, department, employmentStatus, campusId, status }) {
  const and = [{ schoolId: oid(tenant.schoolId) }, staffMatch];
  if (role) and.push({ roles: role });
  if (status) and.push({ status });
  if (campusId) {
    if (isCampusRestricted(tenant) && !tenant.campusIds.some((c) => String(c) === String(campusId))) {
      throw ApiError.forbidden('You do not have access to this campus', { code: 'CAMPUS_ACCESS_DENIED' });
    }
    and.push(campusVisibility([campusId]));
  } else if (isCampusRestricted(tenant)) {
    and.push(campusVisibility(tenant.campusIds));
  }

  const pipeline = [
    { $match: { schoolId: oid(tenant.schoolId), $and: and } },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $lookup: { from: StaffProfile.collection.name, localField: '_id', foreignField: 'membershipId', as: 'profile' } },
    { $addFields: { profile: { $first: '$profile' } } },
  ];
  const post = {};
  if (department) post['profile.department'] = new RegExp(`^${escapeRegex(department)}$`, 'i');
  if (employmentStatus) post['profile.employmentStatus'] = employmentStatus;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    post.$or = [{ 'user.name': rx }, { 'user.email': rx }, { 'user.phone': rx }, { 'profile.employeeCode': rx }, { 'profile.designation': rx }];
  }
  if (Object.keys(post).length) pipeline.push({ $match: post });
  pipeline.push({
    $facet: {
      items: [{ $sort: { 'user.name': 1, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
      total: [{ $count: 'n' }],
    },
  });

  const [res] = await Membership.aggregate(pipeline);
  const total = res.total[0]?.n ?? 0;
  return {
    items: res.items.map((m) => ({
      id: m._id,
      user: { id: m.user._id, name: m.user.name, email: m.user.email, phone: m.user.phone ?? null, lastLoginAt: m.user.lastLoginAt ?? null },
      roles: m.roles.filter((r) => STAFF_ROLE_VALUES.includes(r)),
      roleLabels: m.roles.filter((r) => STAFF_ROLE_VALUES.includes(r)).map((r) => ROLE_LABELS[r]),
      customRoleIds: m.customRoleIds,
      campusIds: m.campusIds,
      status: m.status,
      profile: profileView(m.profile),
    })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function getStaffMembership(tenant, memberId) {
  const m = await Membership.findOne({ _id: memberId, schoolId: tenant.schoolId }).lean();
  if (!m || !isStaffMembership(m) || !canSeeMember(tenant, m)) throw ApiError.notFound('Staff member not found');
  return m;
}

export async function getStaff(tenant, memberId) {
  const m = await getStaffMembership(tenant, memberId);
  const [member, profile] = await Promise.all([getMember(tenant.schoolId, m._id), StaffProfile.findOne({ schoolId: tenant.schoolId, membershipId: m._id }).lean()]);
  let workload = null;
  try {
    workload = await teacherWorkload(tenant, m._id);
  } catch (err) {
    if (err?.code !== 'NO_CURRENT_SESSION') throw err;
  }
  return { ...member, profile: profileView(profile), teaching: workload };
}

async function assertEmployeeCodeFree(schoolId, code, exceptMembershipId) {
  const taken = await StaffProfile.exists({ schoolId, employeeCode: code, ...(exceptMembershipId ? { membershipId: { $ne: exceptMembershipId } } : {}) });
  if (taken) throw ApiError.conflict(`Employee code ${code} is already in use`, { code: 'EMPLOYEE_CODE_TAKEN' });
}

const generateCode = (schoolId) => nextFreeCode(schoolId, 'employee_code', EMPLOYEE_CODE_PREFIX, (c) => StaffProfile.exists({ schoolId, employeeCode: c }));

/**
 * Adds a staff member (login + roles through the members service) together with their
 * employee record. If the employee record cannot be saved, the new membership is removed again.
 */
export async function createStaff(tenant, data, ctx) {
  const { profile = {}, ...memberData } = data;
  if (profile.employeeCode) await assertEmployeeCodeFree(tenant.schoolId, profile.employeeCode);

  const result = await addMember(tenant, memberData, ctx);
  const membershipId = result.member.id;
  try {
    await StaffProfile.create({
      ...profile,
      employeeCode: profile.employeeCode || (await generateCode(tenant.schoolId)),
      schoolId: tenant.schoolId,
      membershipId,
      createdBy: ctx.actorId,
    });
  } catch (err) {
    try {
      await Membership.deleteOne({ _id: membershipId, schoolId: tenant.schoolId });
      if (result.isNewUser) await User.deleteOne({ _id: result.member.user.id });
    } catch (cleanupErr) {
      logger.error({ err: cleanupErr, membershipId }, 'Staff creation rollback failed');
    }
    if (err?.code === 11000) throw ApiError.conflict('Employee code is already in use', { code: 'EMPLOYEE_CODE_TAKEN' });
    throw err;
  }
  await recordAudit({ ...ctx, action: 'staff.profile_created', entityType: 'Membership', entityId: membershipId, metadata: { department: profile.department, designation: profile.designation } });
  return { staff: await getStaff(tenant, membershipId), isNewUser: result.isNewUser, setupEmailDelivered: result.setupEmailDelivered };
}

/** Creates or updates the employee record of an existing staff member. */
export async function upsertProfile(tenant, memberId, data, ctx) {
  const m = await getStaffMembership(tenant, memberId);
  if (data.employeeCode) await assertEmployeeCodeFree(tenant.schoolId, data.employeeCode, m._id);
  let profile = await StaffProfile.findOne({ schoolId: tenant.schoolId, membershipId: m._id });
  const isNew = !profile;
  if (isNew) {
    profile = new StaffProfile({ schoolId: tenant.schoolId, membershipId: m._id, employeeCode: data.employeeCode || (await generateCode(tenant.schoolId)), createdBy: ctx.actorId });
  }
  const update = { ...data, updatedBy: ctx.actorId };
  if (data.employmentStatus === 'exited' && !data.exitDate && !profile.exitDate) update.exitDate = new Date();
  if (data.employmentStatus && data.employmentStatus !== 'exited' && !data.exitDate) update.exitDate = null;
  profile.set(update);
  try {
    await profile.save();
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('Employee code is already in use', { code: 'EMPLOYEE_CODE_TAKEN' });
    throw err;
  }
  await recordAudit({ ...ctx, action: isNew ? 'staff.profile_created' : 'staff.profile_updated', entityType: 'Membership', entityId: m._id, metadata: { changed: Object.keys(data) } });
  return getStaff(tenant, m._id);
}

/** Department and designation values in use, for filters and form suggestions. */
export async function staffDirectoryOptions(tenant) {
  const [departments, designations] = await Promise.all([
    StaffProfile.distinct('department', { schoolId: tenant.schoolId }),
    StaffProfile.distinct('designation', { schoolId: tenant.schoolId }),
  ]);
  const clean = (list) => list.filter(Boolean).sort((a, b) => a.localeCompare(b));
  return { departments: clean(departments), designations: clean(designations) };
}
