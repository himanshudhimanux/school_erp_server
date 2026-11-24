// Test bootstrap: must be imported before any src module so env is set first.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/school_erp_test';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.BCRYPT_ROUNDS = '4';
process.env.LOG_LEVEL = 'silent';
process.env.RESEND_API_KEY = '';

const mongoose = (await import('mongoose')).default;
const { connectDB, disconnectDB } = await import('../src/config/db.js');
const { createApp } = await import('../src/app.js');
const { User } = await import('../src/modules/users/user.model.js');
const { School } = await import('../src/modules/schools/school.model.js');
const { Membership } = await import('../src/modules/memberships/membership.model.js');

export const PASSWORD = 'Password@123';

export async function setupDb() {
  await connectDB(process.env.MONGODB_URI);
  if (!mongoose.connection.name.endsWith('_test')) throw new Error('Refusing to run tests against a non-test database');
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function teardownDb() {
  await mongoose.connection.dropDatabase();
  await disconnectDB();
}

export async function createUser(email, extra = {}) {
  const user = new User({ name: email.split('@')[0], email, emailVerifiedAt: new Date(), ...extra });
  await user.setPassword(PASSWORD);
  await user.save();
  return user;
}

const { Plan } = await import('../src/modules/subscriptions/plan.model.js');
const { Subscription } = await import('../src/modules/subscriptions/subscription.model.js');
const { Campus } = await import('../src/modules/campuses/campus.model.js');
const { assignPlan } = await import('../src/modules/subscriptions/subscription.service.js');
const { PLAN_MODULES } = await import('../src/constants/modules.js');

export async function createPlan(code, extra = {}) {
  return (await Plan.findOne({ code })) || Plan.create({ name: code, code, modules: [...PLAN_MODULES], trialDays: 14, ...extra });
}

/**
 * Creates an active school with a main campus and (by default) an active all-modules subscription.
 * Pass `plan: null` for a school without a subscription, or `subscription: {...}` for assignPlan options.
 */
export async function createSchool(code, { plan, subscription = {}, campus = true, ...extra } = {}) {
  const school = await School.create({ name: `${code} school`, code, status: 'active', ...extra });
  if (campus) await Campus.create({ schoolId: school._id, name: 'Main Campus', code: 'MAIN', isMain: true });
  if (plan !== null) await assignPlan(school._id, plan || (await createPlan('test-full')), subscription);
  return school;
}

export const addMember = (school, user, roles, extra = {}) => Membership.create({ schoolId: school._id, userId: user._id, roles, ...extra });

export { mongoose, createApp, User, School, Membership, Plan, Subscription, Campus };
