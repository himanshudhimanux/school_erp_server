import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { objectId } from '../auth/auth.validators.js';
import { auditContext } from '../audit/audit.service.js';
import { todayIn, weekday } from '../../utils/dates.js';
import { TimetableEntry, BellSchedule } from './timetable.models.js';
import { TeachingAssignment, Section } from '../academics/academics.models.js';
import { registerDeleteGuard, registerDeleteHook, countGuard } from '../../utils/dependencyGuards.js';
import * as svc from './timetable.service.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
registerDeleteGuard('section', countGuard((schoolId, id) => TimetableEntry.countDocuments({ schoolId, sectionId: id }), (n) => `it has ${plural(n, 'timetable period')}`));
registerDeleteGuard('session', countGuard((schoolId, id) => BellSchedule.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'bell schedule')}`));
registerDeleteGuard('campus', countGuard((schoolId, id) => BellSchedule.countDocuments({ schoolId, campusId: id }), (n) => `it has ${plural(n, 'bell schedule')}`));
registerDeleteGuard('member', countGuard((schoolId, id) => TimetableEntry.countDocuments({ schoolId, teacherId: id }), (n) => `they are scheduled for ${plural(n, 'timetable period')}`));
registerDeleteGuard('teaching_assignment', async (schoolId, id) => {
  const a = await TeachingAssignment.findOne({ _id: id, schoolId }).lean();
  if (!a) return null;
  const n = await TimetableEntry.countDocuments({ schoolId, sectionId: a.sectionId, subjectId: a.subjectId, teacherId: a.teacherId });
  return n ? `it is used in ${plural(n, 'timetable period')}` : null;
});
// Subjects removed from a class's curriculum disappear from that class's timetables.
registerDeleteHook('class_subjects', async (schoolId, { sessionId, classId, subjectIds }) => {
  const sectionIds = await Section.distinct('_id', { schoolId, sessionId, classId });
  await TimetableEntry.deleteMany({ schoolId, sectionId: { $in: sectionIds }, subjectId: { $in: subjectIds } });
});

const router = Router();
const R = requirePermission('timetable.read');

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour)');
const periods = z
  .array(z.object({ number: z.number().int().min(1).max(20), label: z.string().trim().max(40).optional(), startTime: time, endTime: time, isBreak: z.boolean().optional() }).strict())
  .min(1)
  .max(20)
  .superRefine((list, ctx) => {
    if (new Set(list.map((p) => p.number)).size !== list.length) ctx.addIssue({ code: 'custom', message: 'Period numbers must be unique' });
    const sorted = [...list].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (const [i, p] of sorted.entries()) {
      if (p.endTime <= p.startTime) ctx.addIssue({ code: 'custom', message: `Period ${p.number} must end after it starts` });
      if (i > 0 && p.startTime < sorted[i - 1].endTime) ctx.addIssue({ code: 'custom', message: `Period ${p.number} overlaps period ${sorted[i - 1].number}` });
    }
  });
const workingDays = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((a) => new Set(a).size === a.length, 'Days must be unique');

const createSchema = z.object({ sessionId: objectId, campusId: objectId.nullable().optional(), name: z.string().trim().min(2).max(80), workingDays: workingDays.optional(), periods }).strict();
const updateSchema = z
  .object({ name: z.string().trim().min(2).max(80), workingDays, periods })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update');
const entriesSchema = z
  .object({
    entries: z
      .array(z.object({ day: z.number().int().min(0).max(6), periodNumber: z.number().int().min(1).max(20), subjectId: objectId, teacherId: objectId.nullable().optional(), room: z.string().trim().max(50).optional() }).strict())
      .max(140),
  })
  .strict();
const idParams = z.object({ id: objectId });
const sectionParams = z.object({ sectionId: objectId });
const teacherQuery = z.object({ sessionId: objectId.optional(), day: z.union([z.literal('today'), z.coerce.number().int().min(0).max(6)]).optional() });

router.get('/bell-schedules', R, validate({ query: z.object({ sessionId: objectId.optional() }) }), async (req, res) => ok(res, await svc.listSchedules(req.tenant, req.validatedQuery)));
router.post('/bell-schedules', requirePermission('timetable.create'), validate({ body: createSchema }), async (req, res) =>
  created(res, await svc.createSchedule(req.tenant, req.body, auditContext(req)), 'Bell schedule created'),
);
router.patch('/bell-schedules/:id', requirePermission('timetable.update'), validate({ params: idParams, body: updateSchema }), async (req, res) =>
  ok(res, await svc.updateSchedule(req.tenant, req.params.id, req.body, auditContext(req)), { message: 'Bell schedule updated' }),
);
router.delete('/bell-schedules/:id', requirePermission('timetable.delete'), validate({ params: idParams }), async (req, res) => {
  await svc.deleteSchedule(req.tenant, req.params.id, auditContext(req));
  return ok(res, null, { message: 'Bell schedule deleted' });
});

router.get('/sections/:sectionId', R, validate({ params: sectionParams }), async (req, res) => ok(res, await svc.getSectionTimetable(req.tenant, req.params.sectionId)));
router.put('/sections/:sectionId', requirePermission('timetable.update'), validate({ params: sectionParams, body: entriesSchema }), async (req, res) =>
  ok(res, await svc.setSectionTimetable(req.tenant, req.params.sectionId, req.body, auditContext(req)), { message: 'Timetable saved' }),
);

const resolveDay = (req) => {
  const { day } = req.validatedQuery;
  return day === 'today' ? weekday(todayIn(req.tenant.school.timezone)) : day;
};
router.get('/my', R, validate({ query: teacherQuery }), async (req, res) =>
  ok(res, await svc.teacherTimetable(req.tenant, req.tenant.membershipId, { ...req.validatedQuery, day: resolveDay(req) })),
);
router.get('/teachers/:memberId', R, validate({ params: z.object({ memberId: objectId }), query: teacherQuery }), async (req, res) =>
  ok(res, await svc.teacherTimetable(req.tenant, req.params.memberId, { ...req.validatedQuery, day: resolveDay(req) })),
);

export default router;
