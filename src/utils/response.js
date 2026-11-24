/**
 * Consistent API response envelope used by every endpoint.
 *   success: { success: true, message, data, meta? }
 *   error:   { success: false, error: { code, message, details? } }   (see middleware/errorHandler.js)
 */
export function ok(res, data = null, { message = 'OK', meta, status = 200 } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function created(res, data, message = 'Created') {
  return ok(res, data, { message, status: 201 });
}
