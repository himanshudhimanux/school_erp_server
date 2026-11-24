import { ApiError } from './ApiError.js';

/**
 * Cross-module delete protection. A module that references another entity registers a guard
 * that returns a human-readable reason when the entity is still in use, e.g.
 *
 *   registerDeleteGuard('campus', async (schoolId, campusId) =>
 *     (await Section.countDocuments({ schoolId, campusId })) ? 'it has sections' : null);
 *
 * Services call `assertDeletable('campus', schoolId, id)` before deleting.
 */
const guards = new Map();

export function registerDeleteGuard(entity, fn) {
  if (!guards.has(entity)) guards.set(entity, []);
  guards.get(entity).push(fn);
}

export async function assertDeletable(entity, schoolId, id, label = entity) {
  const reasons = [];
  for (const fn of guards.get(entity) || []) {
    const reason = await fn(schoolId, id);
    if (reason) reasons.push(reason);
  }
  if (reasons.length) {
    const name = label.charAt(0).toUpperCase() + label.slice(1);
    throw ApiError.conflict(`${name} cannot be deleted: ${reasons.join('; ')}`, {
      code: `${entity.toUpperCase()}_IN_USE`,
      details: { reasons },
    });
  }
}

/** Helper for the common "count > 0 → reason" guard. */
export const countGuard = (countFn, describe) => async (schoolId, id) => {
  const n = await countFn(schoolId, id);
  return n ? describe(n) : null;
};

/**
 * Cleanup hooks that run after an entity has been deleted (e.g. staff profiles when a member
 * is removed). Hooks must be idempotent; a failing hook is reported to the caller.
 */
const hooks = new Map();

export function registerDeleteHook(entity, fn) {
  if (!hooks.has(entity)) hooks.set(entity, []);
  hooks.get(entity).push(fn);
}

export async function runDeleteHooks(entity, schoolId, id) {
  for (const fn of hooks.get(entity) || []) await fn(schoolId, id);
}
