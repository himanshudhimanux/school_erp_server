import mongoose from 'mongoose';
import { supportsTransactions } from '../config/db.js';
import { ApiError } from './ApiError.js';

/**
 * Runs `fn(session)` inside a MongoDB transaction.
 *
 * `required: true` must be used for financial operations: it refuses to run when the
 * database cannot provide transactions instead of silently writing non-atomically.
 * Without `required`, `fn(null)` runs directly on a standalone server (dev convenience).
 */
export async function withTransaction(fn, { required = false } = {}) {
  if (!supportsTransactions()) {
    if (required) {
      throw new ApiError(503, 'This operation requires database transaction support (MongoDB replica set).', {
        code: 'TRANSACTIONS_UNAVAILABLE',
      });
    }
    return fn(null);
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
