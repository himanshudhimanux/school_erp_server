import mongoose from 'mongoose';

const QUERY_OPS = [
  'find',
  'findOne',
  'countDocuments',
  'distinct',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
];

export class TenantIsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

/**
 * Mandatory multi-tenant isolation for school-owned collections.
 *
 * - Adds an immutable, required `schoolId` (indexed unless `{ index: false }`, e.g. when the model
 *   declares its own unique index on schoolId).
 * - Every query/update/delete MUST include a top-level `schoolId` filter, otherwise it throws.
 * - Aggregations MUST start with a `$match` on `schoolId`.
 *
 * Deliberate cross-tenant lookups (e.g. "list this user's memberships across schools" at login)
 * must opt out explicitly with `.setOptions({ skipTenantCheck: true })` so they are easy to audit.
 */
export function tenantPlugin(schema, { index = true } = {}) {
  schema.add({
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true, index },
  });

  schema.pre(QUERY_OPS, function enforceTenantFilter() {
    if (this.getOptions().skipTenantCheck) return;
    const filter = this.getFilter();
    if (filter.schoolId === undefined || filter.schoolId === null) {
      throw new TenantIsolationError(`Tenant isolation: ${this.model.modelName}.${this.op}() is missing a schoolId filter`);
    }
  });

  schema.pre('aggregate', function enforceTenantMatch() {
    if (this.options?.skipTenantCheck) return;
    const [first] = this.pipeline();
    if (!first?.$match || first.$match.schoolId === undefined) {
      throw new TenantIsolationError(`Tenant isolation: ${this._model?.modelName}.aggregate() must start with $match on schoolId`);
    }
  });
}
