/**
 * Removes keys beginning with `$` or containing `.` from request input, preventing
 * MongoDB operator injection such as { "email": { "$ne": null } }.
 * Express 5 exposes req.query as a re-parsing getter, so a cleaned copy is pinned on the request.
 */
function clean(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = clean(value[i], depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      delete value[key];
    } else {
      value[key] = clean(value[key], depth + 1);
    }
  }
  return value;
}

export function sanitizeInput(req, _res, next) {
  if (req.body) clean(req.body);
  if (req.params) clean(req.params);
  // Express 5 re-parses req.query on each access; pin the cleaned copy onto this request.
  const query = clean({ ...req.query });
  Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
  next();
}
