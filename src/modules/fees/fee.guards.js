import { FeeInvoice, FeeStructure, Payment } from './fee.models.js';
import { registerDeleteGuard, countGuard } from '../../utils/dependencyGuards.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

registerDeleteGuard('student', countGuard((schoolId, id) => FeeInvoice.countDocuments({ schoolId, studentId: id }), (n) => `they have ${plural(n, 'fee invoice')}. Mark the student withdrawn instead`));
registerDeleteGuard('student', countGuard((schoolId, id) => Payment.countDocuments({ schoolId, studentId: id }), (n) => `they have ${plural(n, 'payment')}`));
registerDeleteGuard('session', countGuard((schoolId, id) => FeeStructure.countDocuments({ schoolId, sessionId: id }), (n) => `it has ${plural(n, 'fee structure')}`));
registerDeleteGuard('class', countGuard((schoolId, id) => FeeStructure.countDocuments({ schoolId, classIds: id }), (n) => `it is used in ${plural(n, 'fee structure')}`));
registerDeleteGuard('section', countGuard((schoolId, id) => FeeInvoice.countDocuments({ schoolId, sectionId: id }), (n) => `it has ${plural(n, 'fee invoice')}`));
registerDeleteGuard('campus', countGuard((schoolId, id) => FeeInvoice.countDocuments({ schoolId, campusId: id }), (n) => `it has ${plural(n, 'fee invoice')}`));
