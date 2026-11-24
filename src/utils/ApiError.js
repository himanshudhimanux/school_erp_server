const DEFAULT_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  423: 'LOCKED',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

export class ApiError extends Error {
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || DEFAULT_CODES[statusCode] || 'INTERNAL_ERROR';
    this.details = details;
    this.isOperational = true;
  }

  static badRequest(msg, opts) {
    return new ApiError(400, msg, opts);
  }
  static unauthorized(msg = 'Authentication required', opts) {
    return new ApiError(401, msg, opts);
  }
  static forbidden(msg = 'You do not have permission to perform this action', opts) {
    return new ApiError(403, msg, opts);
  }
  static notFound(msg = 'Resource not found', opts) {
    return new ApiError(404, msg, opts);
  }
  static conflict(msg, opts) {
    return new ApiError(409, msg, opts);
  }
  static validation(details, msg = 'Validation failed') {
    return new ApiError(422, msg, { details });
  }
}
