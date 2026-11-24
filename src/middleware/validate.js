import { ApiError } from '../utils/ApiError.js';

const formatIssues = (issues, location) =>
  issues.map((i) => ({ field: [location, ...i.path].join('.'), message: i.message }));

/**
 * Validates request parts with Zod schemas.
 * Parsed (coerced, stripped) values are exposed as req.body, req.params and req.validatedQuery
 * (Express 5's req.query is read-only).
 */
export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    const errors = [];
    if (params) {
      const r = params.safeParse(req.params);
      if (r.success) req.params = r.data;
      else errors.push(...formatIssues(r.error.issues, 'params'));
    }
    if (query) {
      const r = query.safeParse(req.query);
      if (r.success) req.validatedQuery = r.data;
      else errors.push(...formatIssues(r.error.issues, 'query'));
    }
    if (body) {
      const r = body.safeParse(req.body ?? {});
      if (r.success) req.body = r.data;
      else errors.push(...formatIssues(r.error.issues, 'body'));
    }
    if (errors.length) return next(ApiError.validation(errors));
    return next();
  };
