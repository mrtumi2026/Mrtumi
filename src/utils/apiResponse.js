'use strict';

const crypto = require('crypto');

function attachRequestId(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  const reqId =
    incoming && /^[a-zA-Z0-9_-]{8,64}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
  req.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);
  next();
}

function sendSuccess(res, data, statusCode = 200, meta = undefined) {
  const payload = {
    ok: true,
    data,
    ...(meta !== undefined ? { meta } : {}),
  };
  return res.status(statusCode).json(payload);
}

function sendError(res, { statusCode = 500, code = 'INTERNAL_ERROR', message = 'Internal server error', details = null, requestId = undefined }) {
  const payload = {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
    ...(requestId ? { requestId } : {}),
  };
  return res.status(statusCode).json(payload);
}

function wantsJson(req) {
  return (
    req.path.startsWith('/api/') ||
    req.path === '/health' ||
    Boolean(req.xhr) ||
    String(req.headers.accept || '').includes('application/json')
  );
}

module.exports = {
  attachRequestId,
  sendSuccess,
  sendError,
  wantsJson,
};
