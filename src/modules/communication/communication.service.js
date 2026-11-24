import mongoose from 'mongoose';
import { Announcement } from './announcement.model.js';
import { Notification } from '../notifications/notification.model.js';
import { buildDeliveries, queueNotifications, retryNotification, providerStatus, CHANNEL_LABELS, alertChannels, assertChannelsAvailable } from '../notifications/notification.service.js';
import { guardianRecipients } from '../notifications/recipients.js';
import { TEMPLATE_CATALOG, TEMPLATE_KEYS, NotificationTemplate, unknownPlaceholders, fill } from '../notifications/templates.js';
import { Membership } from '../memberships/membership.model.js';
import { User } from '../users/user.model.js';
import { School } from '../schools/school.model.js';
import { Student, Enrollment } from '../students/student.model.js';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models.js';
import { Campus } from '../campuses/campus.model.js';
import { escapeRegex, nameMap, idStr } from '../academics/academics.common.js';
import { studentAccess, studentFilter, hasStaffRole, familyStudentIds } from '../students/access.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { isCampusRestricted, canAccessCampus, assertCampusAccess } from '../../utils/campusScope.js';
import { reminderSettings } from '../fees/reminder.service.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const STALE_SENDING_MS = 10 * 60 * 1000;
const FAMILY_SCOPES = ['families', 'parents', 'students'];
const includesStaff = (scope) => scope === 'everyone' || scope === 'staff';
const includesParents = (scope) => ['everyone', 'families', 'parents'].includes(scope);
const includesStudents = (scope) => ['everyone', 'families', 'students'].includes(scope);

/* ------------------------------ announcements: CRUD ------------------------------ */

/** Campus-restricted staff only see and manage announcements for their campuses. */
function campusVisibility(tenant) {
  if (!isCampusRestricted(tenant)) return {};
  return { campusId: { $in: tenant.campusIds.map(oid) } };
}

async function decorate(schoolId, rows) {
  const [classes, sections, campuses, users] = await Promise.all([
    nameMap(SchoolClass, schoolId, rows.flatMap((r) => r.audience.classIds), 'name'),
    nameMap(Section, schoolId, rows.flatMap((r) => r.audience.sectionIds), 'name classId'),
    nameMap(Campus, schoolId, rows.map((r) => r.campusId), 'name'),
    User.find({ _id: { $in: rows.flatMap((r) => [r.createdBy, r.sentBy]).filter(Boolean) } }).select('name').lean(),
  ]);
  const sectionClasses = await nameMap(SchoolClass, schoolId, [...sections.values()].map((s) => s.classId), 'name');
  const userBy = new Map(users.map((u) => [String(u._id), u.name]));
  return rows.map((r) => ({
    ...r,
    audience: {
      ...r.audience,
      classes: r.audience.classIds.map((id) => ({ _id: id, name: classes.get(idStr(id))?.name ?? '—' })),
      sections: r.audience.sectionIds.map((id) => {
        const s = sections.get(idStr(id));
        return { _id: id, name: s ? `${sectionClasses.get(idStr(s.classId))?.name ?? ''} ${s.name}`.trim() : '—' };
      }),
    },
    campus: r.campusId ? { _id: r.campusId, name: campuses.get(idStr(r.campusId))?.name ?? '—' } : null,
    createdByName: userBy.get(String(r.createdBy)) ?? null,
    sentByName: r.sentBy ? userBy.get(String(r.sentBy)) ?? null : null,
  }));
}

export async function listAnnouncements(tenant, { page, limit, status, kind, search }) {
  const filter = { schoolId: tenant.schoolId, ...campusVisibility(tenant) };
  if (status) filter.status = status;
  if (kind) filter.kind = kind;
  if (search) filter.title = new RegExp(escapeRegex(search), 'i');
  const [rows, total] = await Promise.all([
    Announcement.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Announcement.countDocuments(filter),
  ]);
  return { items: await decorate(tenant.schoolId, rows), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function getDoc(tenant, id) {
  const doc = await Announcement.findOne({ _id: id, schoolId: tenant.schoolId });
  if (!doc || (doc.campusId && !canAccessCampus(tenant, doc.campusId)) || (!doc.campusId && isCampusRestricted(tenant))) throw ApiError.notFound('Announcement not found');
  return doc;
}

export async function getAnnouncement(tenant, id) {
  const doc = await getDoc(tenant, id);
  const [row] = await decorate(tenant.schoolId, [doc.toObject()]);
  return { ...row, delivery: await deliveryReport(tenant.schoolId, doc._id) };
}

/** Validates audience ids against the school, and campus limits for campus-restricted staff. */
async function checkAudience(tenant, data) {
  const schoolId = tenant.schoolId;
  const { scope, classIds = [], sectionIds = [] } = data.audience;
  if ((classIds.length || sectionIds.length) && !FAMILY_SCOPES.includes(scope)) {
    throw ApiError.badRequest('Classes and sections can only narrow a families, parents or students audience', { code: 'INVALID_AUDIENCE' });
  }
  if (classIds.length && (await SchoolClass.countDocuments({ schoolId, _id: { $in: classIds } })) !== new Set(classIds.map(String)).size) throw ApiError.badRequest('One or more classes were not found', { code: 'CLASS_NOT_FOUND' });
  if (sectionIds.length) {
    const sections = await Section.find({ schoolId, _id: { $in: sectionIds } }).select('campusId').lean();
    if (sections.length !== new Set(sectionIds.map(String)).size) throw ApiError.badRequest('One or more sections were not found', { code: 'SECTION_NOT_FOUND' });
    for (const s of sections) assertCampusAccess(tenant, s.campusId);
  }
  if (data.campusId) {
    if (!(await Campus.exists({ schoolId, _id: data.campusId }))) throw ApiError.badRequest('Campus not found', { code: 'CAMPUS_NOT_FOUND' });
    assertCampusAccess(tenant, data.campusId);
  } else if (isCampusRestricted(tenant)) {
    throw ApiError.badRequest('Choose one of your campuses for this announcement', { code: 'CAMPUS_REQUIRED' });
  }
}

const normalizeChannels = (channels) => [...new Set(['in_app', ...(channels || [])])];

export async function createAnnouncement(tenant, data, ctx) {
  await checkAudience(tenant, data);
  const channels = normalizeChannels(data.channels);
  assertChannelsAvailable(channels);
  const doc = await Announcement.create({
    ...data,
    schoolId: tenant.schoolId,
    channels,
    audience: { scope: data.audience.scope, classIds: data.audience.classIds || [], sectionIds: data.audience.sectionIds || [] },
    status: 'draft',
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });
  await recordAudit({ ...ctx, action: 'announcement.created', entityType: 'Announcement', entityId: doc._id, metadata: { title: doc.title, kind: doc.kind, scope: doc.audience.scope } });
  return getAnnouncement(tenant, doc._id);
}

/**
 * Drafts can be edited freely. Once sent, only the notice-board fields (pinned, expiry) change.
 */
export async function updateAnnouncement(tenant, id, data, ctx) {
  const doc = await getDoc(tenant, id);
  const boardOnly = Object.keys(data).every((k) => ['pinned', 'expiresAt'].includes(k));
  if (doc.status !== 'draft' && !(boardOnly && doc.status === 'sent')) {
    throw ApiError.conflict(doc.status === 'scheduled' ? 'Unschedule the announcement before editing it' : 'Only drafts can be edited; for sent notices you can change pinning and expiry', { code: 'ANNOUNCEMENT_NOT_EDITABLE' });
  }
  if (data.audience || data.campusId !== undefined) {
    await checkAudience(tenant, { audience: data.audience || doc.audience.toObject(), campusId: data.campusId !== undefined ? data.campusId : doc.campusId });
  }
  if (data.channels) {
    data.channels = normalizeChannels(data.channels);
    assertChannelsAvailable(data.channels);
  }
  if (data.audience) data.audience = { scope: data.audience.scope, classIds: data.audience.classIds || [], sectionIds: data.audience.sectionIds || [] };
  doc.set({ ...data, updatedBy: ctx.actorId });
  await doc.save();
  await recordAudit({ ...ctx, action: 'announcement.updated', entityType: 'Announcement', entityId: doc._id, metadata: { changed: Object.keys(data) } });
  return getAnnouncement(tenant, doc._id);
}

export async function deleteAnnouncement(tenant, id, ctx) {
  const doc = await getDoc(tenant, id);
  if (!['draft', 'cancelled'].includes(doc.status)) throw ApiError.conflict('Only drafts and cancelled announcements can be deleted', { code: 'ANNOUNCEMENT_NOT_DELETABLE' });
  await Announcement.deleteOne({ _id: doc._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'announcement.deleted', entityType: 'Announcement', entityId: doc._id, metadata: { title: doc.title } });
}

/* ------------------------------ sending ------------------------------ */

/**
 * Sends a draft now, or schedules it when `scheduledAt` is in the future (the scheduler sends it
 * within the hour; a check every few minutes runs while the server is up).
 */
export async function sendAnnouncement(tenant, id, { scheduledAt }, ctx) {
  const doc = await getDoc(tenant, id);
  if (doc.status !== 'draft') throw ApiError.conflict('Only drafts can be sent or scheduled', { code: 'ANNOUNCEMENT_NOT_DRAFT' });
  // Re-check: the campus or channels may have changed since the draft was written.
  await checkAudience(tenant, { audience: doc.audience.toObject(), campusId: doc.campusId });
  assertChannelsAvailable(doc.channels);
  if (scheduledAt && scheduledAt.getTime() > Date.now() + 60_000) {
    const r = await Announcement.updateOne({ _id: doc._id, schoolId: tenant.schoolId, status: 'draft' }, { $set: { status: 'scheduled', scheduledAt, sentBy: ctx.actorId, updatedBy: ctx.actorId } });
    if (!r.modifiedCount) throw ApiError.conflict('The announcement changed; reload and try again', { code: 'ANNOUNCEMENT_NOT_DRAFT' });
    await recordAudit({ ...ctx, action: 'announcement.scheduled', entityType: 'Announcement', entityId: doc._id, metadata: { scheduledAt } });
    return getAnnouncement(tenant, doc._id);
  }
  const claimed = await Announcement.findOneAndUpdate(
    { _id: doc._id, schoolId: tenant.schoolId, status: 'draft' },
    { $set: { status: 'sending', sendingStartedAt: new Date(), sentBy: ctx.actorId, updatedBy: ctx.actorId } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw ApiError.conflict('This announcement is already being sent', { code: 'ANNOUNCEMENT_NOT_DRAFT' });
  const stats = await deliver(claimed);
  await recordAudit({ ...ctx, action: 'announcement.sent', entityType: 'Announcement', entityId: doc._id, metadata: { title: doc.title, ...stats } });
  return getAnnouncement(tenant, doc._id);
}

export async function unscheduleAnnouncement(tenant, id, ctx) {
  const doc = await getDoc(tenant, id);
  const r = await Announcement.updateOne({ _id: doc._id, schoolId: tenant.schoolId, status: 'scheduled' }, { $set: { status: 'draft', scheduledAt: null, updatedBy: ctx.actorId } });
  if (!r.modifiedCount) throw ApiError.conflict('Only scheduled announcements can be moved back to draft', { code: 'ANNOUNCEMENT_NOT_SCHEDULED' });
  await recordAudit({ ...ctx, action: 'announcement.unscheduled', entityType: 'Announcement', entityId: doc._id });
  return getAnnouncement(tenant, doc._id);
}

export async function cancelAnnouncement(tenant, id, ctx) {
  const doc = await getDoc(tenant, id);
  const r = await Announcement.updateOne({ _id: doc._id, schoolId: tenant.schoolId, status: { $in: ['draft', 'scheduled'] } }, { $set: { status: 'cancelled', updatedBy: ctx.actorId } });
  if (!r.modifiedCount) throw ApiError.conflict('Only drafts and scheduled announcements can be cancelled', { code: 'ANNOUNCEMENT_NOT_CANCELLABLE' });
  await recordAudit({ ...ctx, action: 'announcement.cancelled', entityType: 'Announcement', entityId: doc._id });
  return getAnnouncement(tenant, doc._id);
}

/**
 * Everyone the announcement reaches, one entry per person: a member who is both staff and a
 * parent (or a parent of several children in the audience) receives it once.
 */
export async function resolveRecipients(schoolId, ann) {
  const { scope, classIds = [], sectionIds = [] } = ann.audience;
  const people = new Map();
  const add = (key, recipient) => {
    const k = recipient.membershipId ? `m:${recipient.membershipId}` : key;
    const prev = people.get(k);
    people.set(k, prev ? { ...recipient, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v)) } : recipient);
  };

  if (includesStaff(scope)) {
    const filter = { schoolId, status: 'active', $or: [{ roles: { $in: STAFF_ROLE_VALUES } }, { 'customRoleIds.0': { $exists: true } }] };
    if (ann.campusId) filter.$and = [{ $or: [{ campusIds: { $size: 0 } }, { campusIds: ann.campusId }] }];
    const members = await Membership.find(filter).select('userId').lean();
    const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select('name email phone').lean();
    const userBy = new Map(users.map((u) => [String(u._id), u]));
    for (const m of members) {
      const u = userBy.get(String(m.userId));
      if (u) add(`m:${m._id}`, { membershipId: m._id, userId: u._id, name: u.name, email: u.email || undefined, phone: u.phone || undefined });
    }
  }

  if (includesParents(scope) || includesStudents(scope)) {
    const session = await AcademicSession.findOne({ schoolId, isCurrent: true }).select('_id').lean();
    if (session) {
      const filter = { schoolId, sessionId: session._id, status: 'active' };
      if (ann.campusId) filter.campusId = ann.campusId;
      const targets = [];
      if (classIds.length) targets.push({ classId: { $in: classIds } });
      if (sectionIds.length) targets.push({ sectionId: { $in: sectionIds } });
      if (targets.length) filter.$or = targets;
      const studentIds = await Enrollment.distinct('studentId', filter);
      if (includesParents(scope) && studentIds.length) {
        for (const list of (await guardianRecipients(schoolId, studentIds)).values()) for (const g of list) add(`g:${g.guardianId}`, g);
      }
      if (includesStudents(scope) && studentIds.length) {
        const students = await Student.find({ schoolId, _id: { $in: studentIds }, status: 'active' }).select('firstName lastName email phone membershipId').lean();
        for (const s of students) {
          if (!s.membershipId && !s.email && !s.phone) continue; // no way to reach this student directly
          add(`s:${s._id}`, { membershipId: s.membershipId || null, name: `${s.firstName} ${s.lastName || ''}`.trim(), email: s.email || undefined, phone: s.phone || undefined });
        }
      }
    }
  }
  return [...people.entries()].map(([key, recipient]) => ({ key, recipient }));
}

/** Fans the announcement out to notifications. Idempotent: a re-run after a crash skips anyone already notified. */
async function deliver(ann) {
  const schoolId = ann.schoolId;
  const people = await resolveRecipients(schoolId, ann);
  const data = { announcementId: ann._id };
  const items = people.map(({ key, recipient }) => ({ recipient, type: ann.kind, title: ann.title, body: ann.body, data, key: `announcement:${ann._id}:${key}` }));
  const docs = await buildDeliveries(schoolId, items, ann.channels);
  await queueNotifications(schoolId, docs);
  const stats = { recipients: people.length, notifications: docs.filter((d) => d.channel !== 'none').length, unreachable: docs.filter((d) => d.channel === 'none').length };
  await Announcement.updateOne({ _id: ann._id, schoolId, status: 'sending' }, { $set: { status: 'sent', sentAt: new Date(), stats } });
  return stats;
}

/**
 * Sends scheduled announcements that are due, and resumes any left in "sending" by a crash.
 * Each one is claimed first, so two runs never send it twice.
 */
export async function runScheduledAnnouncements(schoolId) {
  const now = new Date();
  const scope = schoolId ? { schoolId } : {};
  let sent = 0;
  for (;;) {
    const ann = await Announcement.findOneAndUpdate(
      { ...scope, $or: [{ status: 'scheduled', scheduledAt: { $lte: now } }, { status: 'sending', sendingStartedAt: { $lt: new Date(now.getTime() - STALE_SENDING_MS) } }] },
      { $set: { status: 'sending', sendingStartedAt: new Date() } },
      { returnDocument: 'after' },
    )
      .setOptions({ skipTenantCheck: !schoolId })
      .lean();
    if (!ann) break;
    await deliver(ann);
    await recordAudit({ schoolId: ann.schoolId, actorId: ann.sentBy, action: 'announcement.sent', entityType: 'Announcement', entityId: ann._id, metadata: { title: ann.title, scheduled: true } });
    sent += 1;
  }
  return sent;
}

/** Delivery results for one announcement, by channel and status. */
export async function deliveryReport(schoolId, announcementId) {
  const rows = await Notification.aggregate([
    { $match: { schoolId: oid(schoolId), 'data.announcementId': oid(announcementId) } },
    { $group: { _id: { channel: '$channel', status: '$status' }, n: { $sum: 1 }, read: { $sum: { $cond: [{ $ifNull: ['$readAt', false] }, 1, 0] } } } },
  ]);
  const byChannel = {};
  for (const r of rows) {
    const c = (byChannel[r._id.channel] ||= { total: 0, read: 0 });
    c[r._id.status] = r.n;
    c.total += r.n;
    c.read += r.read;
  }
  return byChannel;
}

/* ------------------------------ notice board ------------------------------ */

/**
 * Current notices for the caller: staff see notices for everyone/staff (on their campuses);
 * parents and students see notices for everyone/families/their group that match their
 * children's (or their own) campus, class or section this session.
 */
export async function noticeBoard(tenant, { page, limit }) {
  const schoolId = tenant.schoolId;
  const now = new Date();
  const audiences = [];
  if (hasStaffRole(tenant)) {
    const cond = { 'audience.scope': { $in: ['everyone', 'staff'] } };
    if (isCampusRestricted(tenant)) cond.campusId = { $in: [null, ...tenant.campusIds.map(oid)] };
    audiences.push(cond);
  }
  const familyRoles = tenant.roles.filter((r) => r === 'parent' || r === 'student');
  if (familyRoles.length) {
    const ids = await familyStudentIds(tenant);
    const session = ids.length ? await AcademicSession.findOne({ schoolId, isCurrent: true }).select('_id').lean() : null;
    const enrollments = session ? await Enrollment.find({ schoolId, sessionId: session._id, studentId: { $in: ids }, status: 'active' }).select('classId sectionId campusId').lean() : [];
    const scopes = new Set(['everyone', 'families']);
    if (familyRoles.includes('parent')) scopes.add('parents');
    if (familyRoles.includes('student')) scopes.add('students');
    const campusIds = [...new Set(enrollments.map((e) => String(e.campusId)))].map(oid);
    audiences.push({
      'audience.scope': { $in: [...scopes] },
      campusId: { $in: [null, ...campusIds] },
      $or: [
        { 'audience.classIds.0': { $exists: false }, 'audience.sectionIds.0': { $exists: false } },
        { 'audience.classIds': { $in: enrollments.map((e) => e.classId) } },
        { 'audience.sectionIds': { $in: enrollments.map((e) => e.sectionId) } },
      ],
    });
  }
  if (!audiences.length) return { items: [], meta: { page, limit, total: 0, totalPages: 0 } };
  const filter = { schoolId, kind: 'notice', status: 'sent', $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, { $or: audiences }] };
  const [items, total] = await Promise.all([
    Announcement.find(filter).select('title body pinned sentAt expiresAt audience.scope campusId').sort({ pinned: -1, sentAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Announcement.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

/* ------------------------------ notification history ------------------------------ */

/** Campus-restricted staff: notifications about their students or their campuses' announcements. */
async function historyVisibility(tenant) {
  if (!isCampusRestricted(tenant)) return {};
  const schoolId = tenant.schoolId;
  const access = await studentAccess(tenant);
  const [studentIds, annIds] = await Promise.all([
    Student.distinct('_id', { schoolId, ...studentFilter(access) }),
    Announcement.distinct('_id', { schoolId, campusId: { $in: tenant.campusIds.map(oid) } }),
  ]);
  return { $or: [{ 'data.studentId': { $in: studentIds } }, { 'data.announcementId': { $in: annIds } }] };
}

/**
 * Every notification the school has sent, with real delivery status. Campus-restricted staff
 * see those about students on their campuses and announcements for their campuses.
 */
export async function listNotifications(tenant, { page, limit, type, channel, status, from, to, search, announcementId, studentId }) {
  const schoolId = tenant.schoolId;
  const filter = { schoolId };
  if (type) filter.type = type.endsWith('.*') ? new RegExp(`^${escapeRegex(type.slice(0, -2))}\\.`) : type;
  if (channel) filter.channel = channel;
  if (status) filter.status = status === 'retrying' ? 'queued' : status;
  if (status === 'retrying') filter.attempts = { $gt: 0 };
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: new Date(to.getTime() + 86400000) } : {}) };
  if (search) filter['recipient.name'] = new RegExp(escapeRegex(search), 'i');
  if (announcementId) filter['data.announcementId'] = oid(announcementId);
  if (studentId) filter['data.studentId'] = oid(studentId);
  Object.assign(filter, await historyVisibility(tenant));
  const [items, total, byStatus] = await Promise.all([
    Notification.find(filter).select('type channel recipient.name recipient.email recipient.phone title body status error attempts nextAttemptAt sentAt deliveredAt readAt data createdAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.aggregate([{ $match: { ...filter, schoolId: oid(schoolId) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit), byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])) } };
}

export async function retry(tenant, id, ctx) {
  if (!(await Notification.exists({ _id: id, schoolId: tenant.schoolId, ...(await historyVisibility(tenant)) }))) throw ApiError.notFound('Notification not found');
  const result = await retryNotification(tenant.schoolId, id);
  await recordAudit({ ...ctx, action: 'notification.retried', entityType: 'Notification', entityId: id, metadata: { channel: result.channel, status: result.status } });
  return result;
}

/* ------------------------------ channels & templates ------------------------------ */

export async function channelOverview(tenant) {
  const status = providerStatus();
  const [alerts, fees] = await Promise.all([alertChannels(tenant.schoolId), reminderSettings(tenant.schoolId)]);
  return {
    channels: Object.entries(status).map(([channel, available]) => ({
      channel,
      label: CHANNEL_LABELS[channel],
      available,
      // SMS/WhatsApp move to "delivered" only when the provider can call back.
      deliveryReceipts: channel === 'sms' || channel === 'whatsapp' ? available && Boolean(env.PUBLIC_API_URL) : channel === 'in_app' ? 'read' : false,
    })),
    alertChannels: alerts,
    feeReminderChannels: fees.channels,
  };
}

export async function updateChannelSettings(tenant, { alertChannels: list }, ctx) {
  const channels = normalizeChannels(list);
  assertChannelsAvailable(channels);
  await School.updateOne({ _id: tenant.schoolId }, { $set: { 'settings.notifications.alertChannels': channels } }, { runValidators: true });
  await recordAudit({ ...ctx, action: 'notifications.channels_updated', entityType: 'School', entityId: tenant.schoolId, metadata: { alertChannels: channels } });
  return channelOverview(tenant);
}

const SAMPLE = { student: 'Aarav Sharma', class: 'Class 5 A', date: '12 Aug 2026', exam: 'Half-Yearly Examination', invoiceNo: 'INV-2026-0042', invoiceTitle: 'Term 2 Tuition', amount: '₹12,500.00', dueDate: '15 Aug 2026' };

export async function listTemplates(tenant) {
  const [overrides, school] = await Promise.all([NotificationTemplate.find({ schoolId: tenant.schoolId }).lean(), School.findById(tenant.schoolId).select('name').lean()]);
  const byKey = new Map(overrides.map((o) => [o.key, o]));
  const vars = { ...SAMPLE, school: school?.name ?? '' };
  return TEMPLATE_KEYS.map((key) => {
    const def = TEMPLATE_CATALOG[key];
    const o = byKey.get(key);
    const title = o?.title ?? def.title;
    const body = o?.body ?? def.body;
    return { key, label: def.label, description: def.description, variables: def.variables, title, body, defaultTitle: def.title, defaultBody: def.body, customized: Boolean(o), updatedAt: o?.updatedAt ?? null, preview: { title: fill(title, vars), body: fill(body, vars) } };
  });
}

export async function saveTemplate(tenant, key, { title, body }, ctx) {
  const unknown = [...new Set([...unknownPlaceholders(key, title), ...unknownPlaceholders(key, body)])];
  if (unknown.length) {
    throw ApiError.badRequest(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}. Available: ${TEMPLATE_CATALOG[key].variables.map((v) => `{{${v}}}`).join(', ')}`, { code: 'UNKNOWN_PLACEHOLDER', details: { unknown } });
  }
  await NotificationTemplate.findOneAndUpdate({ schoolId: tenant.schoolId, key }, { $set: { title, body, updatedBy: ctx.actorId } }, { upsert: true, runValidators: true });
  await recordAudit({ ...ctx, action: 'notification_template.updated', entityType: 'NotificationTemplate', metadata: { key } });
  return (await listTemplates(tenant)).find((t) => t.key === key);
}

export async function resetTemplate(tenant, key, ctx) {
  await NotificationTemplate.deleteOne({ schoolId: tenant.schoolId, key });
  await recordAudit({ ...ctx, action: 'notification_template.reset', entityType: 'NotificationTemplate', metadata: { key } });
  return (await listTemplates(tenant)).find((t) => t.key === key);
}
