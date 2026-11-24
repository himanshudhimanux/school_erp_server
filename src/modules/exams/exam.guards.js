import { Exam, ExamPaper, MarkEntry, ExamResult } from './exam.models.js';
import { Enrollment } from '../students/student.model.js';
import { registerDeleteGuard, countGuard } from '../../utils/dependencyGuards.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

registerDeleteGuard('session', countGuard((schoolId, id) => Exam.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'exam')}`));
registerDeleteGuard('class', countGuard((schoolId, id) => Exam.countDocuments({ schoolId, classIds: id }), (n) => `it is part of ${plural(n, 'exam')}`));
registerDeleteGuard('subject', countGuard((schoolId, id) => ExamPaper.countDocuments({ schoolId, subjectId: id }), (n) => `it has ${plural(n, 'exam paper')}`));
registerDeleteGuard('section', countGuard((schoolId, id) => MarkEntry.countDocuments({ schoolId, sectionId: id }), (n) => `it has ${plural(n, 'exam mark')}`));
registerDeleteGuard('student', countGuard((schoolId, id) => MarkEntry.countDocuments({ schoolId, studentId: id }), (n) => `they have ${plural(n, 'exam mark')}. Mark the student withdrawn instead`));
registerDeleteGuard('student', countGuard((schoolId, id) => ExamResult.countDocuments({ schoolId, studentId: id }), (n) => `they have ${plural(n, 'published result')}`));
registerDeleteGuard('enrollment', async (schoolId, enrollmentId) => {
  const e = await Enrollment.findOne({ _id: enrollmentId, schoolId }).lean();
  if (!e) return null;
  const n = await MarkEntry.countDocuments({ schoolId, studentId: e.studentId, sectionId: e.sectionId });
  return n ? `it has ${plural(n, 'exam mark')}` : null;
});
// Removing a subject from a class curriculum is blocked while exams have papers for it.
registerDeleteGuard('class_subjects', async (schoolId, { sessionId, classId, subjectIds }) => {
  const n = await ExamPaper.countDocuments({ schoolId, sessionId, classId, subjectId: { $in: subjectIds } });
  return n ? `${plural(n, 'exam paper')} use the subject(s). Remove them from the exam schedule first` : null;
});
