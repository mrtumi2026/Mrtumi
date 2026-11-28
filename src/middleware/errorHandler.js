'use strict';

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { attachRequestId, sendError, wantsJson } = require('../utils/apiResponse');

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A readable page with a way forward, instead of a bare line of text. No script, no external assets. */
function clientErrorPage(req, statusCode, message) {
  const area = String(req.originalUrl || req.url || '');
  const home = area.startsWith('/admin') ? '/admin/login' : '/';
  const homeLabel = home === '/' ? 'হোম পেজ' : 'অ্যাডমিন লগইন';
  const heading = statusCode === 401 ? 'আগে লগইন করুন' : statusCode === 403 ? 'এই কাজের অনুমতি নেই' : 'অনুরোধটি সম্পন্ন করা যায়নি';
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>`
    + '<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;line-height:1.6;color:#1f2937">'
    + `<h1 style="font-size:22px">${heading}</h1><p>${escapeHtml(message)}</p>`
    + `<p><a href="${home}">${homeLabel}</a></p><p style="color:#6b7280;font-size:13px">আগের পেজে যেতে ব্রাউজারের Back বাটন চাপুন।</p></body></html>`;
}

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
          : 'An unexpected internal error occurred.';

    if (statusCode >= 500) {
      logger.error('Unhandled request error', {
        requestId: req.requestId,
        method: req.method,
        path: req.path || req.url,
        code,
        err,
      });
      if (typeof persistErrorLog === 'function') {
        Promise.resolve(
          persistErrorLog({
            level: 'ERROR',
            code,
            message: String(err?.code || code).slice(0, 500),
            context: `${req.method} ${req.path || ''}`.slice(0, 120),
            requestId: req.requestId || '',
          })
        ).catch(() => {});
      }
    } else {
      logger.warn('Operational request error', {
        requestId: req.requestId,
        method: req.method,
        path: req.path || req.url,
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
        details: isOperational ? logger.redactValue(err.details, 0, true) : null,
        requestId: req.requestId,
      });
    }

    if (statusCode >= 500) return res.status(statusCode).send('Internal Server Error');
    return res.status(statusCode).send(clientErrorPage(req, statusCode, safeMessage));
  };
}

module.exports = {
  attachRequestId,
  wantsJsonResponse: wantsJson,
  createErrorHandler,
};
