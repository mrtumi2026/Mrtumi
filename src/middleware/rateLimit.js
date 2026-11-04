'use strict';

const crypto = require('node:crypto');
const { RateLimitError } = require('../utils/errors');

/**
 * Extracts client IP safely when running behind cPanel LiteSpeed/Passenger reverse proxy.
 */
function getClientIp(req) {
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(raw).replace(/^::ffff:/, '').slice(0, 64);
}

/**
 * CGNAT-safe in-memory sliding-window rate limiter.
 * In Bangladesh, mobile carriers (Grameenphone, Robi, Banglalink, Teletalk) place thousands
 * of shoppers behind shared CGNAT IPv4 addresses. Combining IP with session/account identifier
 * avoids false-positive carrier-wide blocks while still throttling brute-force abuse.
 */
function createRateLimiter(options = {}) {
  const windowMs = Number(options.windowMs || 60_000);
  const max = Number(options.max || 60);
  const keyPrefix = String(options.keyPrefix || 'rl');
  const maxBuckets = Number(options.maxBuckets || 10_000);
  const message =
    options.message || 'Too many requests in a short period. Please wait a moment and try again.';

  const buckets = new Map();

  function sweepExpired(now) {
    if (buckets.size <= maxBuckets) return;
    for (const [k, entry] of buckets.entries()) {
      if (entry.resetAt <= now) {
        buckets.delete(k);
      }
    }
    // If still above cap, evict oldest entries
    if (buckets.size > maxBuckets) {
      const overflow = buckets.size - maxBuckets;
      let removed = 0;
      for (const k of buckets.keys()) {
        buckets.delete(k);
        removed++;
        if (removed >= overflow) break;
      }
    }
  }

  function resolveKey(req) {
    if (typeof options.keyGenerator === 'function') {
      return `${keyPrefix}:${options.keyGenerator(req)}`;
    }
    const ip = getClientIp(req);
    const sid = req.sessionID || '';
    const identifier =
      (req.body && (req.body.email || req.body.phone)) ||
      '';
    const discriminator = String(identifier || sid || 'anon').toLowerCase().trim().slice(0, 80);
    return `${keyPrefix}:${ip}:${discriminator}`;
  }

  function middleware(req, res, next) {
    const now = Date.now();
    sweepExpired(now);

    const key = resolveKey(req);
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(retryAfterSec));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return next(new RateLimitError(message, retryAfterSec));
    }
    return next();
  }

  middleware._buckets = buckets;
  return middleware;
}

function normalizeLoginIdentifier(value) {
  let normalized = String(value || '').trim().toLowerCase().replace(/[\s()-]/g, '');
  if (/^(?:\+?880|0)1[3-9]\d{8}$/.test(normalized)) {
    if (normalized.startsWith('+880')) normalized = `0${normalized.slice(4)}`;
    else if (normalized.startsWith('880')) normalized = `0${normalized.slice(3)}`;
  }
  return normalized.slice(0, 191);
}

/**
 * Three independent login budgets: a generous IP ceiling, an account ceiling
 * shared across source IPs, and a tighter IP+account ceiling. Keys for account
 * identifiers are hashed so limiter memory never retains raw email/phone values.
 */
function createLoginRateLimiters(options = {}) {
  const prefix = String(options.keyPrefix || 'login');
  const windowMs = Number(options.windowMs || 15 * 60 * 1000);
  const fields = Array.isArray(options.identifierFields) ? options.identifierFields : ['identifier'];
  const identityHash = (req) => {
    const raw = fields.map((field) => req.body && req.body[field]).find((value) => value !== undefined && value !== null && String(value).trim());
    const normalized = normalizeLoginIdentifier(raw);
    return crypto.createHash('sha256').update(normalized || 'missing-identifier').digest('hex');
  };
  return [
    createRateLimiter({ windowMs, max: Number(options.maxPerIp || 2000), keyPrefix: `${prefix}-ip`, keyGenerator: getClientIp }),
    createRateLimiter({ windowMs, max: Number(options.maxPerAccount || 100), keyPrefix: `${prefix}-account`, keyGenerator: identityHash }),
    createRateLimiter({ windowMs, max: Number(options.maxPerIpAccount || options.max || 12), keyPrefix: `${prefix}-ip-account`, keyGenerator: (req) => `${getClientIp(req)}:${identityHash(req)}` }),
  ];
}

module.exports = {
  getClientIp,
  createRateLimiter,
  normalizeLoginIdentifier,
  createLoginRateLimiters,
};
