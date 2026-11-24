import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { TenantIsolationError } from '../plugins/tenant.plugin.js';

export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

function normalize(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof mongoose.Error.ValidationError) {
    return ApiError.validation(Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof mongoose.Error.CastError) return ApiError.badRequest(`Invalid value for ${err.path}`);
  if (err?.code === 11000) {
    const fields = Object.keys(err.keyValue || err.keyPattern || {}).filter((f) => f !== 'schoolId');
    return ApiError.conflict(`A record with this ${fields.join(', ') || 'value'} already exists`, { code: 'DUPLICATE', details: { fields } });
  }
  if (err?.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON body');
  if (err?.type === 'entity.too.large') return new ApiError(413, 'Request body too large', { code: 'PAYLOAD_TOO_LARGE' });
  return null;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const apiErr = normalize(err);

  if (!apiErr) {
    // Unexpected error (including TenantIsolationError, which signals a programming bug).
    const level = err instanceof TenantIsolationError ? 'fatal' : 'error';
    logger[level]({ err, path: req.originalUrl, method: req.method, reqId: req.id }, 'Unhandled error');
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: env.isProd ? 'Something went wrong' : err.message },
    });
  }

  if (apiErr.statusCode >= 500) logger.error({ err, reqId: req.id }, apiErr.message);
  const body = { success: false, error: { code: apiErr.code, message: apiErr.message } };
  if (apiErr.details) body.error.details = apiErr.details;
  return res.status(apiErr.statusCode).json(body);
}
