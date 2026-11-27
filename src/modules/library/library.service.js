import { Book, BookIssue } from './library.models.js';
import { Student, fullName } from '../students/student.model.js';
import { Membership } from '../memberships/membership.model.js';
import { School } from '../schools/school.model.js';
import { FeeCategory } from '../fees/fee.models.js';
import { getStudentDoc, familyStudentIds } from '../students/access.js';
import { createAdhocInvoice } from '../fees/invoice.service.js';
import { STAFF_ROLE_VALUES } from '../../constants/roles.js';
import { escapeRegex } from '../common/person.schema.js';
import { todayIn, addDays, daysBetween } from '../../utils/dates.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const DEFAULTS = { loanDays: 14, maxBooksStudent: 3, maxBooksStaff: 5, finePerDay: 100, maxFine: null, fineCategoryId: null };

export async function librarySettings(schoolId) {
  const s = await School.findById(schoolId).select('timezone settings.library').lean();
  const l = s?.settings?.library || {};
  const pick = (k) => (l[k] === undefined || l[k] === null ? DEFAULTS[k] : l[k]);
  return { loanDays: pick('loanDays'), maxBooksStudent: pick('maxBooksStudent'), maxBooksStaff: pick('maxBooksStaff'), finePerDay: pick('finePerDay'), maxFine: l.maxFine ?? null, fineCategoryId: l.fineCategoryId ?? null, timezone: s?.timezone || 'UTC' };
}

export async function updateLibrarySettings(tenant, data, ctx) {
  if (data.fineCategoryId && !(await FeeCategory.exists({ schoolId: tenant.schoolId, _id: data.fineCategoryId }))) {
    throw ApiError.badRequest('Fee category not found', { code: 'INVALID_CATEGORY' });
  }
  const set = Object.fromEntries(Object.entries(data).map(([k, v]) => [`settings.library.${k}`, v]));
  await School.updateOne({ _id: tenant.schoolId }, { $set: set }, { runValidators: true });
  await recordAudit({ ...ctx, action: 'library.settings_updated', entityType: 'School', entityId: tenant.schoolId, metadata: { changed: Object.keys(data) } });
  return librarySettings(tenant.schoolId);
}

/* ------------------------------ books ------------------------------ */

export async function listBooks(tenant, { page, limit, search, category, available, status }) {
  const filter = { schoolId: tenant.schoolId };
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (available) filter.availableCopies = { $gt: 0 };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ title: rx }, { author: rx }, { isbn: rx }, { publisher: rx }];
  }
  const [items, total, categories] = await Promise.all([
    Book.find(filter).sort({ title: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Book.countDocuments(filter),
    Book.distinct('category', { schoolId: tenant.schoolId }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit), categories: categories.filter(Boolean).sort() } };
}

async function getBookDoc(schoolId, id) {
  const b = await Book.findOne({ _id: id, schoolId });
  if (!b) throw ApiError.notFound('Book not found');
  return b;
}

export async function createBook(tenant, { copies, ...data }, ctx) {
  const book = await Book.create({ ...data, totalCopies: copies, availableCopies: copies, schoolId: tenant.schoolId, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'library.book_added', entityType: 'Book', entityId: book._id, metadata: { title: book.title, copies } });
  return book;
}

/** Updating the copy count keeps copies on loan: available changes by the same difference. */
export async function updateBook(tenant, id, { copies, ...data }, ctx) {
  const book = await getBookDoc(tenant.schoolId, id);
  if (copies !== undefined && copies !== book.totalCopies) {
    const onLoan = book.totalCopies - book.availableCopies;
    if (copies < onLoan) throw ApiError.badRequest(`${onLoan} copies are on loan; the total cannot be lower`, { code: 'COPIES_ON_LOAN' });
    const delta = copies - book.totalCopies;
    const r = await Book.updateOne({ _id: book._id, schoolId: tenant.schoolId, totalCopies: book.totalCopies, availableCopies: book.availableCopies }, { $inc: { totalCopies: delta, availableCopies: delta } });
    if (!r.modifiedCount) throw ApiError.conflict('The book was just issued or returned. Reload and try again.', { code: 'BOOK_CHANGED' });
  }
  if (Object.keys(data).length) await Book.updateOne({ _id: book._id, schoolId: tenant.schoolId }, { $set: data }, { runValidators: true });
  await recordAudit({ ...ctx, action: 'library.book_updated', entityType: 'Book', entityId: book._id, metadata: { changed: [...Object.keys(data), ...(copies !== undefined ? ['copies'] : [])] } });
  return Book.findOne({ _id: book._id, schoolId: tenant.schoolId }).lean();
}

export async function deleteBook(tenant, id, ctx) {
  const book = await getBookDoc(tenant.schoolId, id);
  if (await BookIssue.exists({ schoolId: tenant.schoolId, bookId: book._id, status: 'issued' })) throw ApiError.conflict('Copies of this book are on loan', { code: 'BOOK_ON_LOAN' });
  await book.softDelete(ctx.actorId);
  await recordAudit({ ...ctx, action: 'library.book_deleted', entityType: 'Book', entityId: book._id, metadata: { title: book.title } });
}

/* ------------------------------ loans ------------------------------ */

async function decorateIssues(schoolId, rows, today) {
  const [books, students, members] = await Promise.all([
    Book.find({ schoolId, _id: { $in: rows.map((r) => r.bookId) } }).setOptions({ withDeleted: true }).select('title author isbn').lean(),
    Student.find({ schoolId, _id: { $in: rows.map((r) => r.studentId).filter(Boolean) } }).setOptions({ withDeleted: true }).select('firstName lastName admissionNo').lean(),
    Membership.find({ schoolId, _id: { $in: rows.map((r) => r.membershipId).filter(Boolean) } }).populate('userId', 'name email').lean(),
  ]);
  const b = new Map(books.map((x) => [String(x._id), x]));
  const s = new Map(students.map((x) => [String(x._id), x]));
  const m = new Map(members.map((x) => [String(x._id), x]));
  return rows.map((r) => {
    const st = r.studentId && s.get(String(r.studentId));
    const mem = r.membershipId && m.get(String(r.membershipId));
    const overdueDays = r.status === 'issued' ? Math.max(0, daysBetween(r.dueDate, today)) : 0;
    return {
      ...r,
      book: b.get(String(r.bookId)) || null,
      borrower: st ? { type: 'student', id: st._id, name: fullName(st), admissionNo: st.admissionNo } : mem ? { type: 'staff', id: mem._id, name: mem.userId?.name, email: mem.userId?.email } : null,
      overdueDays,
      displayStatus: r.status === 'issued' && overdueDays > 0 ? 'overdue' : r.status,
    };
  });
}

async function resolveBorrower(tenant, { studentId, membershipId }) {
  if (studentId) {
    const student = await getStudentDoc(tenant, studentId);
    if (student.status !== 'active') throw ApiError.badRequest('Only active students can borrow books', { code: 'STUDENT_INACTIVE' });
    return { borrowerType: 'student', studentId: student._id };
  }
  const m = await Membership.findOne({ _id: membershipId, schoolId: tenant.schoolId, status: 'active' }).lean();
  if (!m || !(m.roles.some((r) => STAFF_ROLE_VALUES.includes(r)) || m.customRoleIds?.length)) throw ApiError.badRequest('Borrower must be an active staff member', { code: 'INVALID_BORROWER' });
  return { borrowerType: 'staff', membershipId: m._id };
}

/** Lends a copy. The copy is reserved atomically; the borrower's limit and duplicates are checked. */
export async function issueBook(tenant, { bookId, studentId, membershipId, dueDate, note }, ctx) {
  const schoolId = tenant.schoolId;
  const settings = await librarySettings(schoolId);
  const borrower = await resolveBorrower(tenant, { studentId, membershipId });
  const who = borrower.studentId ? { studentId: borrower.studentId } : { membershipId: borrower.membershipId };
  const active = await BookIssue.countDocuments({ schoolId, ...who, status: 'issued' });
  const max = borrower.borrowerType === 'student' ? settings.maxBooksStudent : settings.maxBooksStaff;
  if (active >= max) throw ApiError.conflict(`This borrower already has ${active} book(s); the limit is ${max}`, { code: 'BORROW_LIMIT' });
  if (await BookIssue.exists({ schoolId, ...who, bookId, status: 'issued' })) throw ApiError.conflict('This borrower already has a copy of this book', { code: 'ALREADY_BORROWED' });

  const reserved = await Book.findOneAndUpdate({ _id: bookId, schoolId, status: 'active', availableCopies: { $gt: 0 } }, { $inc: { availableCopies: -1 } }, { returnDocument: 'after' });
  if (!reserved) {
    await getBookDoc(schoolId, bookId);
    throw ApiError.conflict('No copies of this book are available', { code: 'NO_COPIES_AVAILABLE' });
  }
  const today = todayIn(settings.timezone);
  try {
    const issue = await BookIssue.create({ schoolId, bookId, ...borrower, issuedAt: new Date(), dueDate: dueDate || addDays(today, settings.loanDays), note, issuedBy: ctx.actorId });
    await recordAudit({ ...ctx, action: 'library.issued', entityType: 'BookIssue', entityId: issue._id, metadata: { bookId, ...who } });
    const [row] = await decorateIssues(schoolId, [issue.toObject()], today);
    return row;
  } catch (err) {
    await Book.updateOne({ _id: bookId, schoolId }, { $inc: { availableCopies: 1 } });
    throw err;
  }
}

async function getOpenIssue(tenant, id) {
  const issue = await BookIssue.findOne({ _id: id, schoolId: tenant.schoolId });
  if (!issue) throw ApiError.notFound('Loan not found');
  if (issue.status !== 'issued') throw ApiError.badRequest(`This book is already ${issue.status}`, { code: 'LOAN_CLOSED' });
  return issue;
}

/**
 * Returns a copy; a late return records a fine of finePerDay for each day past the due date,
 * never more than the school's maxFine (when set).
 * `waiveFine` needs library.update, like waiving a fine later (library.issue alone cannot waive).
 */
export async function returnBook(tenant, id, { waiveFine = false, note }, ctx) {
  const schoolId = tenant.schoolId;
  if (waiveFine && !tenant.permissions?.has('library.update')) throw ApiError.forbidden('You do not have permission to waive library fines', { code: 'FORBIDDEN' });
  const settings = await librarySettings(schoolId);
  const issue = await getOpenIssue(tenant, id);
  const today = todayIn(settings.timezone);
  const late = Math.max(0, daysBetween(issue.dueDate, today));
  const uncapped = late * settings.finePerDay;
  const fine = settings.maxFine ? Math.min(uncapped, settings.maxFine) : uncapped;
  const closed = await BookIssue.findOneAndUpdate(
    { _id: issue._id, schoolId, status: 'issued' },
    { status: 'returned', returnedAt: new Date(), fine, fineStatus: fine ? (waiveFine ? 'waived' : 'pending') : 'none', closedBy: ctx.actorId, ...(note ? { note } : {}) },
    { returnDocument: 'after' },
  );
  if (!closed) throw ApiError.conflict('This loan was just closed', { code: 'LOAN_CLOSED' });
  await Book.updateOne({ _id: issue.bookId, schoolId }, { $inc: { availableCopies: 1 } });
  await recordAudit({ ...ctx, action: 'library.returned', entityType: 'BookIssue', entityId: issue._id, metadata: { lateDays: late, fine, capped: fine < uncapped, waived: Boolean(waiveFine && fine) } });
  const [row] = await decorateIssues(schoolId, [closed.toObject()], today);
  return row;
}

/** A lost copy leaves the collection; an optional replacement charge becomes the fine. */
export async function markLost(tenant, id, { charge = 0, note }, ctx) {
  const schoolId = tenant.schoolId;
  const issue = await getOpenIssue(tenant, id);
  const closed = await BookIssue.findOneAndUpdate({ _id: issue._id, schoolId, status: 'issued' }, { status: 'lost', returnedAt: new Date(), fine: charge, fineStatus: charge ? 'pending' : 'none', closedBy: ctx.actorId, ...(note ? { note } : {}) }, { returnDocument: 'after' });
  if (!closed) throw ApiError.conflict('This loan was just closed', { code: 'LOAN_CLOSED' });
  await Book.updateOne({ _id: issue.bookId, schoolId, totalCopies: { $gt: 0 } }, { $inc: { totalCopies: -1 } });
  await recordAudit({ ...ctx, action: 'library.lost', entityType: 'BookIssue', entityId: issue._id, metadata: { charge } });
  const [row] = await decorateIssues(schoolId, [closed.toObject()], todayIn((await librarySettings(schoolId)).timezone));
  return row;
}

async function getFineIssue(tenant, id) {
  const issue = await BookIssue.findOne({ _id: id, schoolId: tenant.schoolId });
  if (!issue) throw ApiError.notFound('Loan not found');
  if (issue.fineStatus !== 'pending') throw ApiError.badRequest('There is no pending fine on this loan', { code: 'NO_PENDING_FINE' });
  return issue;
}

export async function waiveFine(tenant, id, { reason }, ctx) {
  const issue = await getFineIssue(tenant, id);
  const updated = await BookIssue.findOneAndUpdate({ _id: issue._id, schoolId: tenant.schoolId, fineStatus: 'pending' }, { fineStatus: 'waived' }, { returnDocument: 'after' }).lean();
  if (!updated) throw ApiError.conflict('This fine was just updated', { code: 'FINE_CHANGED' });
  await recordAudit({ ...ctx, action: 'library.fine_waived', entityType: 'BookIssue', entityId: issue._id, metadata: { fine: issue.fine, reason } });
  return updated;
}

/**
 * Adds a student's pending fine to their fees as a one-off invoice (same rules, receipts and
 * accounting as every other fee). Needs the fees module and a library fine category.
 */
export async function chargeFine(tenant, id, ctx) {
  const issue = await getFineIssue(tenant, id);
  if (issue.borrowerType !== 'student') throw ApiError.badRequest('Only student fines can be added to fees', { code: 'NOT_A_STUDENT' });
  if (!tenant.enabledModules?.has('fees')) throw ApiError.forbidden('The fees module is not enabled for this school', { code: 'MODULE_NOT_ENABLED' });
  const settings = await librarySettings(tenant.schoolId);
  if (!settings.fineCategoryId) throw ApiError.badRequest('Choose a fee category for library fines in library settings first', { code: 'FINE_CATEGORY_REQUIRED' });
  const book = await Book.findOne({ _id: issue.bookId, schoolId: tenant.schoolId }).setOptions({ withDeleted: true }).select('title').lean();
  // Claim the pending fine first: of two simultaneous requests only one creates an invoice.
  const claim = await BookIssue.updateOne({ _id: issue._id, schoolId: tenant.schoolId, fineStatus: 'pending' }, { fineStatus: 'charged' });
  if (!claim.modifiedCount) throw ApiError.conflict('This fine was just updated', { code: 'FINE_CHANGED' });
  let invoice;
  try {
    invoice = await createAdhocInvoice(
      tenant,
      { studentId: issue.studentId, title: `Library fine: ${book?.title ?? 'book'}`, dueDate: addDays(todayIn(settings.timezone), 7), lines: [{ categoryId: settings.fineCategoryId, amount: issue.fine, description: issue.status === 'lost' ? 'Lost book' : 'Late return' }] },
      ctx,
    );
  } catch (err) {
    await BookIssue.updateOne({ _id: issue._id, schoolId: tenant.schoolId, fineStatus: 'charged', fineInvoiceId: null }, { fineStatus: 'pending' });
    throw err;
  }
  await BookIssue.updateOne({ _id: issue._id, schoolId: tenant.schoolId }, { fineInvoiceId: invoice._id });
  await recordAudit({ ...ctx, action: 'library.fine_charged', entityType: 'BookIssue', entityId: issue._id, metadata: { invoiceNo: invoice.invoiceNo, fine: issue.fine } });
  return { invoiceId: invoice._id, invoiceNo: invoice.invoiceNo, amount: issue.fine };
}

export async function listIssues(tenant, { page, limit, status, studentId, membershipId, bookId, fineStatus }) {
  const schoolId = tenant.schoolId;
  const settings = await librarySettings(schoolId);
  const today = todayIn(settings.timezone);
  const filter = { schoolId };
  if (status === 'overdue') Object.assign(filter, { status: 'issued', dueDate: { $lt: today } });
  else if (status) filter.status = status;
  if (studentId) filter.studentId = studentId;
  if (membershipId) filter.membershipId = membershipId;
  if (bookId) filter.bookId = bookId;
  if (fineStatus) filter.fineStatus = fineStatus;
  const [rows, total] = await Promise.all([
    BookIssue.find(filter).sort({ status: 1, dueDate: 1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    BookIssue.countDocuments(filter),
  ]);
  return { items: await decorateIssues(schoolId, rows, today), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function librarySummary(tenant) {
  const schoolId = tenant.schoolId;
  const today = todayIn((await librarySettings(schoolId)).timezone);
  const [titles, copies, onLoan, overdue, fines] = await Promise.all([
    Book.countDocuments({ schoolId }),
    Book.aggregate([{ $match: { schoolId, isDeleted: false } }, { $group: { _id: null, total: { $sum: '$totalCopies' }, available: { $sum: '$availableCopies' } } }]),
    BookIssue.countDocuments({ schoolId, status: 'issued' }),
    BookIssue.countDocuments({ schoolId, status: 'issued', dueDate: { $lt: today } }),
    BookIssue.aggregate([{ $match: { schoolId, fineStatus: 'pending' } }, { $group: { _id: null, amount: { $sum: '$fine' }, n: { $sum: 1 } } }]),
  ]);
  return { titles, copies: copies[0]?.total ?? 0, available: copies[0]?.available ?? 0, onLoan, overdue, pendingFines: { amount: fines[0]?.amount ?? 0, count: fines[0]?.n ?? 0 } };
}

/** Family view: books currently borrowed by the family's children, plus recent history. */
export async function familyLoans(tenant, studentId) {
  const ids = await familyStudentIds(tenant);
  const target = studentId || (ids.length === 1 ? ids[0] : null);
  if (!target || !ids.includes(String(target))) throw ApiError.notFound('Student not found');
  const today = todayIn((await librarySettings(tenant.schoolId)).timezone);
  const rows = await BookIssue.find({ schoolId: tenant.schoolId, studentId: target }).sort({ issuedAt: -1 }).limit(30).lean();
  const items = await decorateIssues(tenant.schoolId, rows, today);
  return { current: items.filter((i) => i.status === 'issued'), history: items.filter((i) => i.status !== 'issued') };
}
