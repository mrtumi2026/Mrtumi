'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const { AppError } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function deriveCsrfToken(sessionId, nonce) {
  const secret = env.csrfSecret || env.sessionSecret;
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${sessionId}:${nonce}`)
    .digest('hex');
  return `${nonce}.${mac}`;
}

/**
 * Ensures the active session holds a nonce and attaches a bound CSRF token to
 * `req.csrfToken()` and `res.locals.csrfToken`.
 */
function attachCsrfToken(req, res, next) {
  if (!req.session) {
    return next();
  }
  if (!req.session._csrfNonce) {
    req.session._csrfNonce = crypto.randomBytes(16).toString('hex');
  }
  const sid = req.sessionID || 'anon';
  const token = deriveCsrfToken(sid, req.session._csrfNonce);
  req.csrfToken = () => token;
  res.locals.csrfToken = token;
  return next();
}

function verifyTokenConstantTime(expected, candidate) {
  if (typeof expected !== 'string' || typeof candidate !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Enforces CSRF token validation on state-changing HTTP methods (POST, PUT, PATCH, DELETE).
 * Accepts token from `x-csrf-token` header, `req.body._csrf`, or `req.query._csrf`.
 */
function requireCsrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }
  if (!req.session || !req.session._csrfNonce) {
    return next(
      new AppError(
        'CSRF_INVALID',
        'CSRF session missing or expired. Please refresh and try again.',
        403
      )
    );
  }
  const expected = deriveCsrfToken(req.sessionID || 'anon', req.session._csrfNonce);
  const candidate =
    req.headers['x-csrf-token'] ||
    (req.body && req.body._csrf) ||
    (req.query && req.query._csrf) ||
    '';

  if (!verifyTokenConstantTime(expected, String(candidate))) {
    return next(new AppError('CSRF_INVALID', 'Invalid or missing CSRF token.', 403));
  }
  return next();
}

module.exports = {
  attachCsrfToken,
  requireCsrf,
  deriveCsrfToken,
  verifyTokenConstantTime,
};
