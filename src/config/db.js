import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

mongoose.set('strictQuery', true);
// Operator injection ({ email: { $ne: null } }) is blocked at the edge by middleware/sanitize.js
// and by Zod schemas that coerce inputs to primitives.

let transactionsSupported = false;

export async function connectDB(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, { autoIndex: !env.isProd, maxPoolSize: 20 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  logger.info({ db: mongoose.connection.name, transactionsSupported }, 'MongoDB connected');
  if (!transactionsSupported) {
    const msg = 'MongoDB is not a replica set: multi-document transactions are unavailable.';
    if (env.requireTransactions) throw new Error(`${msg} (REQUIRE_TRANSACTIONS=true)`);
    logger.warn(msg);
  }
  return mongoose.connection;
}

export const supportsTransactions = () => transactionsSupported;

export async function disconnectDB() {
  await mongoose.disconnect();
}
