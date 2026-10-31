'use strict';

const { env } = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { attachRequestId, sendError, wantsJson } = require('../utils/apiResponse');

/**
 * Creates the centralized Express error handler with optional async error-log persistence.
 */
function createErrorHandler({ persistErrorLog } = {}) {
  return function centralizedErrorHandler(err, req, res, _next) {
    const isOperational = Boolean(err instanceof AppError && err.isOperational);
    const malformedBody = err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large';
    const statusCode = err instanceof AppError ? err.statusCode : malformedBody ? (err.type === 'entity.too.large' ? 413 : 400) : 500;
    const code = err instanceof AppError ? err.code : malformedBody ? 'INVALID_REQUEST_BODY' : 'INTERNAL_ERROR';

    const safeMessage =
      isOperational && statusCode < 500
        ? String(err.message || 'Request failed')
        : malformedBody
          ? 'Invalid request body.'
          : !env.isProduction && err && err.message
            ? String(err.message)
            : 'An unexpected internal error occurred.';

    if (statusCode >= 500) {
      logger.error('Unhandled request error', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        code,
        err,
      });
      if (typeof persistErrorLog === 'function') {
        Promise.resolve(
          persistErrorLog({
            level: 'ERROR',
            code,
            message: String(err?.message || 'Unhandled error').slice(0, 500),
            context: `${req.method} ${req.path || ''}`.slice(0, 120),
            requestId: req.requestId || '',
          })
        ).catch(() => {});
      }
    } else {
      logger.warn('Operational request error', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode,
        code,
      });
    }

    if (res.headersSent) {
      return;
    }

    if (wantsJson(req)) {
      return sendError(res, {
        statusCode,
        code,
        message: safeMessage,
        details: isOperational ? err.details : null,
        requestId: req.requestId,
      });
    }

    return res.status(statusCode).send(statusCode < 500 ? safeMessage : 'Internal Server Error');
  };
}

module.exports = {
  attachRequestId,
  wantsJsonResponse: wantsJson,
  createErrorHandler,
};
