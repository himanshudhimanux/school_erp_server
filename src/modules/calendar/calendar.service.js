import { CalendarEvent } from './calendarEvent.model.js';
import { getSessionOr404, resolveSession, assertSessionOpen } from '../academics/academics.common.js';
import { assertCampusesBelongToSchool } from '../campuses/campus.service.js';
import { isCampusRestricted } from '../../utils/campusScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const MAX_RANGE_DAYS = 400;

function assertWithinSession(session, startDate, endDate) {
  if (endDate < startDate) throw ApiError.validation([{ field: 'body.endDate', message: 'End date must be on or after the start date' }]);
  if (startDate < session.startDate || endDate > session.endDate) {
    throw ApiError.badRequest(`Event dates must fall within the session ${session.name}`, { code: 'OUTSIDE_SESSION' });
  }
}

/** Campus-restricted users may only manage events limited to their own campuses. */
function assertCampusScope(tenant, campusIds) {
  if (!isCampusRestricted(tenant)) return;
  const mine = new Set(tenant.campusIds.map(String));
  if (!campusIds.length || !campusIds.every((c) => mine.has(String(c)))) {
    throw ApiError.forbidden('You can only manage events for your own campuses', { code: 'CAMPUS_ACCESS_DENIED' });
  }
}

/** Events overlapping [from, to] (defaults to the session), visible to the caller's campuses. */
export async function listEvents(tenant, { sessionId, from, to, type, campusId }) {
  const session = await resolveSession(tenant.schoolId, sessionId);
  const start = from || session.startDate;
  const end = to || session.endDate;
  if (end < start) throw ApiError.validation([{ field: 'query.to', message: '"to" must be on or after "from"' }]);
  if ((end - start) / 86400000 > MAX_RANGE_DAYS) throw ApiError.validation([{ field: 'query.to', message: `Range cannot exceed ${MAX_RANGE_DAYS} days` }]);

  const filter = { schoolId: tenant.schoolId, sessionId: session._id, startDate: { $lte: end }, endDate: { $gte: start } };
  if (type) filter.type = type;
  const campuses = campusId ? [campusId] : isCampusRestricted(tenant) ? tenant.campusIds : null;
  if (campuses) filter.$or = [{ campusIds: { $size: 0 } }, { campusIds: { $in: campuses } }];

  const items = await CalendarEvent.find(filter).sort('startDate title').limit(1000).lean();
  return { session: { id: session._id, name: session.name }, from: start, to: end, items };
}

async function loadEvent(tenant, eventId) {
  const ev = await CalendarEvent.findOne({ _id: eventId, schoolId: tenant.schoolId });
  if (!ev) throw ApiError.notFound('Calendar event not found');
  return ev;
}

export async function createEvent(tenant, data, ctx) {
  const session = await getSessionOr404(tenant.schoolId, data.sessionId);
  assertSessionOpen(session);
  assertWithinSession(session, data.startDate, data.endDate);
  const campusIds = data.campusIds || [];
  await assertCampusesBelongToSchool(tenant.schoolId, campusIds);
  assertCampusScope(tenant, campusIds);

  const ev = await CalendarEvent.create({ ...data, campusIds, schoolId: tenant.schoolId, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'calendar_event.created', entityType: 'CalendarEvent', entityId: ev._id, metadata: { title: ev.title, type: ev.type } });
  return ev;
}

export async function updateEvent(tenant, eventId, data, ctx) {
  const ev = await loadEvent(tenant, eventId);
  assertCampusScope(tenant, ev.campusIds);
  const session = await getSessionOr404(tenant.schoolId, ev.sessionId);
  assertSessionOpen(session);
  assertWithinSession(session, data.startDate ?? ev.startDate, data.endDate ?? ev.endDate);
  if (data.campusIds) {
    await assertCampusesBelongToSchool(tenant.schoolId, data.campusIds);
    assertCampusScope(tenant, data.campusIds);
  }
  ev.set({ ...data, updatedBy: ctx.actorId });
  await ev.save();
  await recordAudit({ ...ctx, action: 'calendar_event.updated', entityType: 'CalendarEvent', entityId: ev._id, metadata: { changed: Object.keys(data) } });
  return ev;
}

export async function deleteEvent(tenant, eventId, ctx) {
  const ev = await loadEvent(tenant, eventId);
  assertCampusScope(tenant, ev.campusIds);
  assertSessionOpen(await getSessionOr404(tenant.schoolId, ev.sessionId));
  await CalendarEvent.deleteOne({ _id: ev._id, schoolId: tenant.schoolId });
  await recordAudit({ ...ctx, action: 'calendar_event.deleted', entityType: 'CalendarEvent', entityId: ev._id, metadata: { title: ev.title } });
}

/**
 * Non-working dates (holidays/vacations) in [from, to] for a campus, as 'YYYY-MM-DD' strings.
 * Used by attendance to skip days and by reports to compute working days.
 */
export async function nonWorkingDates(schoolId, { from, to, campusId }) {
  const events = await CalendarEvent.find({
    schoolId,
    isNonWorking: true,
    startDate: { $lte: to },
    endDate: { $gte: from },
    $or: [{ campusIds: { $size: 0 } }, ...(campusId ? [{ campusIds: campusId }] : [])],
  }).lean();
  const out = new Set();
  for (const ev of events) {
    const start = new Date(Math.max(ev.startDate, from));
    const end = new Date(Math.min(ev.endDate, to));
    for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) out.add(d.toISOString().slice(0, 10));
  }
  return [...out].sort();
}
