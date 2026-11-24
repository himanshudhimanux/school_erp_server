import { AcademicSession, SchoolClass, Subject } from './academics.models.js';
import { Membership } from '../memberships/membership.model.js';
import { ApiError } from '../../utils/ApiError.js';

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const idStr = (v) => (v ? String(v._id ?? v) : null);
export const uniqIds = (ids) => [...new Set(ids.filter(Boolean).map(String))];

export async function getSessionOr404(schoolId, sessionId) {
  const s = await AcademicSession.findOne({ _id: sessionId, schoolId });
  if (!s) throw ApiError.notFound('Academic session not found');
  return s;
}

/** The given session, or the school's current session when none is given. */
export async function resolveSession(schoolId, sessionId) {
  if (sessionId) return getSessionOr404(schoolId, sessionId);
  const current = await AcademicSession.findOne({ schoolId, isCurrent: true });
  if (!current) throw ApiError.badRequest('No current academic session. Create one or pass sessionId.', { code: 'NO_CURRENT_SESSION' });
  return current;
}

/** Closed sessions are read-only, preserving historical records. */
export function assertSessionOpen(session) {
  if (session.status === 'closed') {
    throw ApiError.badRequest(`Academic session ${session.name} is closed and cannot be modified`, { code: 'SESSION_CLOSED' });
  }
}

export async function getClassOr404(schoolId, classId, { requireActive = false } = {}) {
  const c = await SchoolClass.findOne({ _id: classId, schoolId });
  if (!c) throw ApiError.notFound('Class not found');
  if (requireActive && c.status !== 'active') throw ApiError.badRequest(`Class ${c.name} is inactive`, { code: 'CLASS_INACTIVE' });
  return c;
}

export async function getSubjectOr404(schoolId, subjectId, { requireActive = false } = {}) {
  const s = await Subject.findOne({ _id: subjectId, schoolId });
  if (!s) throw ApiError.notFound('Subject not found');
  if (requireActive && s.status !== 'active') throw ApiError.badRequest(`Subject ${s.name} is inactive`, { code: 'SUBJECT_INACTIVE' });
  return s;
}

/** Map of membershipId → { id, name, email } for displaying teachers. */
export async function teacherMap(schoolId, membershipIds) {
  const ids = uniqIds(membershipIds);
  if (!ids.length) return new Map();
  const rows = await Membership.find({ schoolId, _id: { $in: ids } })
    .select('userId status')
    .populate('userId', 'name email')
    .lean();
  return new Map(rows.map((m) => [String(m._id), { id: m._id, name: m.userId?.name ?? null, email: m.userId?.email ?? null, status: m.status }]));
}

/** Map of id → doc for any tenant model, selecting `fields`. */
export async function nameMap(Model, schoolId, ids, fields = 'name code') {
  const unique = uniqIds(ids);
  if (!unique.length) return new Map();
  const rows = await Model.find({ schoolId, _id: { $in: unique } })
    .setOptions({ withDeleted: true })
    .select(fields)
    .lean();
  return new Map(rows.map((r) => [String(r._id), r]));
}
