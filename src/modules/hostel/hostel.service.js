import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';
import { Student, fullName } from '../students/student.model.js';
import { getStudentDoc, familyStudentIds } from '../students/access.js';
import { currentPlacement } from '../parents/guardian.service.js';
import { AcademicSession } from '../academics/academics.models.js';
import { teacherMap } from '../academics/academics.common.js';
import { assertAssignableStaff } from '../memberships/membership.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';

const { ObjectId } = mongoose.Schema.Types;

/* ------------------------------ models ------------------------------ */

const hostelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    type: { type: String, enum: ['boys', 'girls', 'mixed'], required: true },
    wardenId: { type: ObjectId, ref: 'Membership', default: null },
    address: { type: String, trim: true, maxlength: 200 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
);
hostelSchema.plugin(tenantPlugin);
hostelSchema.index({ schoolId: 1, name: 1 }, { unique: true });
export const Hostel = mongoose.model('Hostel', hostelSchema);

/** A room. `occupied` is kept in step with active allocations through guarded atomic updates. */
const roomSchema = new mongoose.Schema(
  {
    hostelId: { type: ObjectId, ref: 'Hostel', required: true },
    number: { type: String, required: true, trim: true, maxlength: 20 },
    floor: { type: String, trim: true, maxlength: 20 },
    capacity: { type: Number, required: true, min: 1, max: 50 },
    occupied: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
);
roomSchema.plugin(tenantPlugin);
roomSchema.index({ schoolId: 1, hostelId: 1, number: 1 }, { unique: true });
export const HostelRoom = mongoose.model('HostelRoom', roomSchema);

/** A student's stay in a room. One active allocation per student. */
const allocationSchema = new mongoose.Schema(
  {
    studentId: { type: ObjectId, ref: 'Student', required: true },
    hostelId: { type: ObjectId, ref: 'Hostel', required: true },
    roomId: { type: ObjectId, ref: 'HostelRoom', required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, default: null },
    status: { type: String, enum: ['active', 'ended'], default: 'active' },
    note: { type: String, trim: true, maxlength: 300 },
    allocatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
allocationSchema.plugin(tenantPlugin);
allocationSchema.index({ schoolId: 1, studentId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
allocationSchema.index({ schoolId: 1, roomId: 1, status: 1 });
allocationSchema.index({ schoolId: 1, hostelId: 1, status: 1 });
export const HostelAllocation = mongoose.model('HostelAllocation', allocationSchema);

/* ------------------------------ hostels & rooms ------------------------------ */

export async function listHostels(tenant) {
  const schoolId = tenant.schoolId;
  const [hostels, rooms] = await Promise.all([Hostel.find({ schoolId }).sort({ name: 1 }).lean(), HostelRoom.find({ schoolId }).sort({ number: 1 }).lean()]);
  const wardens = await teacherMap(schoolId, hostels.map((h) => h.wardenId));
  return hostels.map((h) => {
    const r = rooms.filter((x) => String(x.hostelId) === String(h._id));
    return { ...h, warden: h.wardenId ? wardens.get(String(h.wardenId)) ?? null : null, rooms: r, capacity: r.reduce((t, x) => t + x.capacity, 0), occupied: r.reduce((t, x) => t + x.occupied, 0) };
  });
}

const dup = (err, msg) => (err?.code === 11000 ? ApiError.conflict(msg, { code: 'DUPLICATE' }) : err);

export async function saveHostel(tenant, id, data, ctx) {
  if (data.wardenId) await assertAssignableStaff(tenant.schoolId, data.wardenId);
  try {
    const h = id
      ? await Hostel.findOneAndUpdate({ _id: id, schoolId: tenant.schoolId }, { $set: data }, { returnDocument: 'after', runValidators: true })
      : await Hostel.create({ ...data, schoolId: tenant.schoolId });
    if (!h) throw ApiError.notFound('Hostel not found');
    await recordAudit({ ...ctx, action: id ? 'hostel.updated' : 'hostel.created', entityType: 'Hostel', entityId: h._id, metadata: { name: h.name } });
    return h;
  } catch (err) {
    throw dup(err, 'A hostel with this name already exists');
  }
}

export async function deleteHostel(tenant, id, ctx) {
  if (await HostelRoom.exists({ schoolId: tenant.schoolId, hostelId: id })) throw ApiError.conflict('Remove the hostel’s rooms first', { code: 'HOSTEL_HAS_ROOMS' });
  const r = await Hostel.deleteOne({ _id: id, schoolId: tenant.schoolId });
  if (!r.deletedCount) throw ApiError.notFound('Hostel not found');
  await recordAudit({ ...ctx, action: 'hostel.deleted', entityType: 'Hostel', entityId: id });
}

export async function createRoom(tenant, hostelId, data, ctx) {
  if (!(await Hostel.exists({ _id: hostelId, schoolId: tenant.schoolId }))) throw ApiError.notFound('Hostel not found');
  try {
    const room = await HostelRoom.create({ ...data, hostelId, schoolId: tenant.schoolId });
    await recordAudit({ ...ctx, action: 'hostel.room_created', entityType: 'HostelRoom', entityId: room._id, metadata: { number: room.number } });
    return room;
  } catch (err) {
    throw dup(err, 'This room number already exists in the hostel');
  }
}

export async function updateRoom(tenant, roomId, data, ctx) {
  const room = await HostelRoom.findOne({ _id: roomId, schoolId: tenant.schoolId });
  if (!room) throw ApiError.notFound('Room not found');
  if (data.capacity !== undefined && data.capacity < room.occupied) throw ApiError.badRequest(`${room.occupied} students live in this room; capacity cannot be lower`, { code: 'ROOM_OCCUPIED' });
  try {
    const filter = { _id: room._id, schoolId: tenant.schoolId, ...(data.capacity !== undefined ? { occupied: { $lte: data.capacity } } : {}) };
    const updated = await HostelRoom.findOneAndUpdate(filter, { $set: data }, { returnDocument: 'after', runValidators: true });
    if (!updated) throw ApiError.conflict('Room occupancy just changed. Reload and try again.', { code: 'ROOM_CHANGED' });
    await recordAudit({ ...ctx, action: 'hostel.room_updated', entityType: 'HostelRoom', entityId: room._id, metadata: { changed: Object.keys(data) } });
    return updated;
  } catch (err) {
    throw dup(err, 'This room number already exists in the hostel');
  }
}

export async function deleteRoom(tenant, roomId, ctx) {
  if (await HostelAllocation.exists({ schoolId: tenant.schoolId, roomId, status: 'active' })) throw ApiError.conflict('Students are allocated to this room', { code: 'ROOM_OCCUPIED' });
  if (await HostelAllocation.exists({ schoolId: tenant.schoolId, roomId })) throw ApiError.conflict('This room has allocation history. Mark it inactive instead.', { code: 'ROOM_IN_USE' });
  const r = await HostelRoom.deleteOne({ _id: roomId, schoolId: tenant.schoolId });
  if (!r.deletedCount) throw ApiError.notFound('Room not found');
  await recordAudit({ ...ctx, action: 'hostel.room_deleted', entityType: 'HostelRoom', entityId: roomId });
}

/* ------------------------------ allocations ------------------------------ */

async function decorate(schoolId, rows) {
  const [students, rooms, hostels] = await Promise.all([
    Student.find({ schoolId, _id: { $in: rows.map((r) => r.studentId) } }).setOptions({ withDeleted: true }).select('firstName lastName admissionNo gender').lean(),
    HostelRoom.find({ schoolId, _id: { $in: rows.map((r) => r.roomId) } }).select('number floor capacity').lean(),
    Hostel.find({ schoolId, _id: { $in: rows.map((r) => r.hostelId) } }).select('name type').lean(),
  ]);
  const session = await AcademicSession.findOne({ schoolId, isCurrent: true }).select('_id').lean();
  const placement = await currentPlacement(schoolId, session?._id, rows.map((r) => r.studentId));
  const s = new Map(students.map((x) => [String(x._id), x]));
  const rm = new Map(rooms.map((x) => [String(x._id), x]));
  const h = new Map(hostels.map((x) => [String(x._id), x]));
  return rows.map((r) => {
    const st = s.get(String(r.studentId));
    return { ...r, student: st ? { id: st._id, name: fullName(st), admissionNo: st.admissionNo, gender: st.gender, classSection: placement.get(String(st._id))?.displayName ?? null } : null, room: rm.get(String(r.roomId)) || null, hostel: h.get(String(r.hostelId)) || null };
  });
}

/**
 * Allocates a bed. The room's occupancy is reserved atomically (never above capacity) and a
 * student can hold only one active allocation. Boys/girls hostels only take matching students.
 */
export async function allocate(tenant, { studentId, roomId, fromDate, note }, ctx) {
  const schoolId = tenant.schoolId;
  const student = await getStudentDoc(tenant, studentId);
  if (student.status !== 'active') throw ApiError.badRequest('Only active students can be allocated a room', { code: 'STUDENT_INACTIVE' });
  const room = await HostelRoom.findOne({ _id: roomId, schoolId }).lean();
  if (!room) throw ApiError.notFound('Room not found');
  const hostel = await Hostel.findOne({ _id: room.hostelId, schoolId }).lean();
  if (hostel.status !== 'active' || room.status !== 'active') throw ApiError.badRequest('This hostel or room is inactive', { code: 'ROOM_INACTIVE' });
  if ((hostel.type === 'boys' && student.gender !== 'male') || (hostel.type === 'girls' && student.gender !== 'female')) {
    throw ApiError.badRequest(`This is a ${hostel.type} hostel`, { code: 'HOSTEL_GENDER_MISMATCH' });
  }
  if (await HostelAllocation.exists({ schoolId, studentId: student._id, status: 'active' })) throw ApiError.conflict('This student already has a room. Vacate it first.', { code: 'ALREADY_ALLOCATED' });

  const reserved = await HostelRoom.findOneAndUpdate({ _id: room._id, schoolId, $expr: { $lt: ['$occupied', '$capacity'] } }, { $inc: { occupied: 1 } }, { returnDocument: 'after' });
  if (!reserved) throw ApiError.conflict('This room is full', { code: 'ROOM_FULL' });
  try {
    const a = await HostelAllocation.create({ schoolId, studentId: student._id, hostelId: hostel._id, roomId: room._id, fromDate: fromDate || new Date(), note, allocatedBy: ctx.actorId });
    await recordAudit({ ...ctx, action: 'hostel.allocated', entityType: 'HostelAllocation', entityId: a._id, metadata: { studentId: student._id, room: room.number, hostel: hostel.name } });
    const [row] = await decorate(schoolId, [a.toObject()]);
    return row;
  } catch (err) {
    await HostelRoom.updateOne({ _id: room._id, schoolId }, { $inc: { occupied: -1 } });
    if (err?.code === 11000) throw ApiError.conflict('This student already has a room', { code: 'ALREADY_ALLOCATED' });
    throw err;
  }
}

export async function vacate(tenant, allocationId, { toDate, note }, ctx) {
  const schoolId = tenant.schoolId;
  const ended = await HostelAllocation.findOneAndUpdate({ _id: allocationId, schoolId, status: 'active' }, { status: 'ended', toDate: toDate || new Date(), ...(note ? { note } : {}) }, { returnDocument: 'after' });
  if (!ended) throw ApiError.notFound('Active allocation not found');
  await HostelRoom.updateOne({ _id: ended.roomId, schoolId, occupied: { $gt: 0 } }, { $inc: { occupied: -1 } });
  await recordAudit({ ...ctx, action: 'hostel.vacated', entityType: 'HostelAllocation', entityId: ended._id, metadata: { studentId: ended.studentId } });
  const [row] = await decorate(schoolId, [ended.toObject()]);
  return row;
}

export async function listAllocations(tenant, { page, limit, hostelId, roomId, status = 'active', studentId }) {
  const filter = { schoolId: tenant.schoolId };
  if (status) filter.status = status;
  if (hostelId) filter.hostelId = hostelId;
  if (roomId) filter.roomId = roomId;
  if (studentId) filter.studentId = studentId;
  const [rows, total] = await Promise.all([HostelAllocation.find(filter).sort({ fromDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), HostelAllocation.countDocuments(filter)]);
  return { items: await decorate(tenant.schoolId, rows), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

/** Family view of a child's current room. */
export async function familyHostel(tenant, studentId) {
  const ids = await familyStudentIds(tenant);
  const target = studentId || (ids.length === 1 ? ids[0] : null);
  if (!target || !ids.includes(String(target))) throw ApiError.notFound('Student not found');
  const a = await HostelAllocation.findOne({ schoolId: tenant.schoolId, studentId: target, status: 'active' }).lean();
  if (!a) return { allocation: null };
  const [row] = await decorate(tenant.schoolId, [a]);
  const hostel = await Hostel.findOne({ _id: a.hostelId, schoolId: tenant.schoolId }).lean();
  const wardens = await teacherMap(tenant.schoolId, [hostel?.wardenId]);
  return { allocation: { hostel: row.hostel, room: row.room, fromDate: row.fromDate, warden: hostel?.wardenId ? wardens.get(String(hostel.wardenId))?.name ?? null : null } };
}
