import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';

/**
 * Per-school sequences (admission numbers, application numbers, employee codes).
 * `nextSequence` is atomic: concurrent callers always receive distinct values.
 */
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 60 },
  seq: { type: Number, default: 0 },
});
counterSchema.plugin(tenantPlugin, { index: false });
counterSchema.index({ schoolId: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model('Counter', counterSchema);

/** Pass `session` inside a transaction: an aborted transaction then leaves no gap in the sequence. */
export async function nextSequence(schoolId, key, { session } = {}) {
  const doc = await Counter.findOneAndUpdate({ schoolId, key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session: session || undefined });
  return doc.seq;
}

/**
 * Generates the next free code like `ST0001`. Codes may also be entered manually, so the
 * generator skips values that already exist (`exists(code)` → boolean).
 */
export async function nextFreeCode(schoolId, key, prefix, exists, { pad = 4, attempts = 20 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const code = `${prefix}${String(await nextSequence(schoolId, key)).padStart(pad, '0')}`;
    if (!(await exists(code))) return code;
  }
  throw new Error(`Could not generate a free ${key} code`);
}
