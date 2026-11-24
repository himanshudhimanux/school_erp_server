import { Section, ClassSubject, TeachingAssignment } from './academics.models.js';
import { CalendarEvent } from '../calendar/calendarEvent.model.js';
import { registerDeleteGuard, countGuard } from '../../utils/dependencyGuards.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Campus
registerDeleteGuard('campus', countGuard((schoolId, campusId) => Section.countDocuments({ schoolId, campusId }), (n) => `it has ${plural(n, 'section')}`));

// Member (staff) removal: reassign teaching duties first.
registerDeleteGuard(
  'member',
  countGuard((schoolId, id) => Section.countDocuments({ schoolId, classTeacherId: id }), (n) => `they are class teacher of ${plural(n, 'section')}`),
);
registerDeleteGuard(
  'member',
  countGuard((schoolId, id) => TeachingAssignment.countDocuments({ schoolId, teacherId: id }), (n) => `they have ${plural(n, 'subject teaching assignment')}`),
);

// Academic session
registerDeleteGuard('session', countGuard((schoolId, id) => Section.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'section')}`));
registerDeleteGuard('session', countGuard((schoolId, id) => ClassSubject.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'class-subject mapping')}`));
registerDeleteGuard('session', countGuard((schoolId, id) => CalendarEvent.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'calendar event')}`));

// Class
registerDeleteGuard('class', countGuard((schoolId, id) => Section.countDocuments({ schoolId, classId: id }), (n) => `it has ${plural(n, 'section')}`));
registerDeleteGuard('class', countGuard((schoolId, id) => ClassSubject.countDocuments({ schoolId, classId: id }), (n) => `it has ${plural(n, 'subject mapping')}`));

// Subject
registerDeleteGuard('subject', countGuard((schoolId, id) => ClassSubject.countDocuments({ schoolId, subjectId: id }), (n) => `it is mapped to ${plural(n, 'class', 'classes')}`));
