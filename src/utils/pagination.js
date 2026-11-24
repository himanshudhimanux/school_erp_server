import { z } from 'zod';

export const MAX_LIMIT = 100;

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
  sort: z
    .string()
    .regex(/^-?[a-zA-Z_.]+$/, 'Invalid sort field')
    .optional(),
});

/**
 * Paginated find + count. The caller is responsible for including tenant scope in `filter`
 * (the tenant plugin will reject the query otherwise).
 */
export async function paginate(Model, filter, { page = 1, limit = 20, sort = '-createdAt', select, populate, lean = true } = {}) {
  const skip = (page - 1) * limit;
  let q = Model.find(filter).sort(sort).skip(skip).limit(limit);
  if (select) q = q.select(select);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  const [items, total] = await Promise.all([q, Model.countDocuments(filter)]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
