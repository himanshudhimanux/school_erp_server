import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createUser, createSchool, addMember, Membership, mongoose } from './helpers.js';

let schoolA;
let schoolB;

before(async () => {
  await setupDb();
  schoolA = await createSchool('plugin-a');
  schoolB = await createSchool('plugin-b');
  const u = await createUser('plugin.user@test.local');
  await addMember(schoolA, u, ['teacher']);
  await addMember(schoolB, u, ['teacher']);
});
after(teardownDb);

test('queries without schoolId are rejected', async () => {
  await assert.rejects(Membership.find({}), /missing a schoolId filter/);
  await assert.rejects(Membership.findOne({ status: 'active' }), /missing a schoolId filter/);
  await assert.rejects(Membership.countDocuments({}), /missing a schoolId filter/);
  await assert.rejects(Membership.updateMany({}, { status: 'suspended' }), /missing a schoolId filter/);
  await assert.rejects(Membership.deleteMany({}), /missing a schoolId filter/);
});

test('queries scoped by schoolId only see that tenant', async () => {
  const a = await Membership.find({ schoolId: schoolA._id });
  assert.equal(a.length, 1);
  assert.equal(String(a[0].schoolId), String(schoolA._id));
});

test('aggregations must start with $match on schoolId', async () => {
  await assert.rejects(Membership.aggregate([{ $match: {} }]), /must start with \$match on schoolId/);
  await assert.rejects(Membership.aggregate([{ $group: { _id: null } }]), /must start with \$match on schoolId/);
  const rows = await Membership.aggregate([{ $match: { schoolId: new mongoose.Types.ObjectId(String(schoolB._id)) } }]);
  assert.equal(rows.length, 1);
});

test('explicit skipTenantCheck opt-out works', async () => {
  const all = await Membership.find({}).setOptions({ skipTenantCheck: true });
  assert.equal(all.length, 2);
});

test('schoolId is required and immutable', async () => {
  const u = await createUser('plugin.user2@test.local');
  await assert.rejects(Membership.create({ userId: u._id, roles: ['teacher'] }), /schoolId/);
  const m = await addMember(schoolA, u, ['teacher']);
  m.schoolId = schoolB._id;
  await m.save();
  const reloaded = await Membership.findOne({ schoolId: schoolA._id, userId: u._id });
  assert.equal(String(reloaded.schoolId), String(schoolA._id));
});
