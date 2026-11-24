import { Student, Enrollment } from './student.model.js';
import { StudentGuardian } from '../parents/guardian.model.js';
import { registerDeleteGuard, countGuard } from '../../utils/dependencyGuards.js';
import { registerUsageCounter } from '../subscriptions/subscription.service.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Plan limit: active students.
registerUsageCounter('maxStudents', (schoolId) => Student.countDocuments({ schoolId, status: 'active' }));

registerDeleteGuard('section', countGuard((schoolId, id) => Enrollment.countDocuments({ schoolId, sectionId: id }), (n) => `it has ${plural(n, 'student enrollment')}`));
registerDeleteGuard('session', countGuard((schoolId, id) => Enrollment.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'student enrollment')}`));
registerDeleteGuard('class', countGuard((schoolId, id) => Enrollment.countDocuments({ schoolId, classId: id }), (n) => `it has ${plural(n, 'student enrollment')}`));
registerDeleteGuard('campus', countGuard((schoolId, id) => Student.countDocuments({ schoolId, campusId: id }), (n) => `it has ${plural(n, 'student')}`));
registerDeleteGuard('campus', countGuard((schoolId, id) => Enrollment.countDocuments({ schoolId, campusId: id }), (n) => `it has ${plural(n, 'student enrollment')}`));
registerDeleteGuard('guardian', countGuard((schoolId, id) => StudentGuardian.countDocuments({ schoolId, guardianId: id }), (n) => `they are linked to ${plural(n, 'student')}. Unlink them first`));
