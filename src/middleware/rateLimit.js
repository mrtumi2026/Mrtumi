'use strict';

const crypto = require('node:crypto');
const { RateLimitError, DatabaseError } = require('../utils/errors');
const { env } = require('../config/env');
const { consumeLoginBucket } = require('../repositories/loginRateLimitRepository');

const localLoginBuckets = new Map();

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
  const input = String(value || '').trim().toLowerCase();
  let phoneCandidate = input.replace(/[\s()-]/g, '');
  if (/^(?:\+?880|0)1[3-9]\d{8}$/.test(phoneCandidate)) {
    if (phoneCandidate.startsWith('+880')) phoneCandidate = `0${phoneCandidate.slice(4)}`;
    else if (phoneCandidate.startsWith('880')) phoneCandidate = `0${phoneCandidate.slice(3)}`;
    return phoneCandidate.slice(0, 191);
  }
  // Preserve email punctuation: stripping hyphens/parentheses globally can merge distinct accounts.
  return input.slice(0, 191);
}

/**
 * Shared login budgets: a generous IP ceiling and a tighter IP+account ceiling.
 * There is deliberately no account-only hard lockout. Identifier/IP values are
 * hashed before reaching either MySQL or the local development adapter.
 */
function createLoginRateLimiters(options = {}) {
  const prefix = String(options.keyPrefix || 'login');
  const windowMs = Number(options.windowMs || 15 * 60 * 1000);
  const fields = Array.isArray(options.identifierFields) ? options.identifierFields : ['identifier'];
  const maxPerIp = Number(options.maxPerIp || 2000);
  const maxPerIpAccount = Number(options.maxPerIpAccount || options.max || 12);
  const sharedStore = options.sharedStore === undefined ? env.db.client === 'mysql' : Boolean(options.sharedStore);
  const consume = options.consume || (sharedStore ? consumeLoginBucket : consumeLocalLoginBucket);

  const identityHash = (req) => {
    const raw = fields.map((field) => req.body && req.body[field]).find((value) => value !== undefined && value !== null && String(value).trim());
    const normalized = normalizeLoginIdentifier(raw);
    return crypto.createHash('sha256').update(normalized || 'missing-identifier').digest('hex');
  };
  const clientHash = (req) => crypto.createHash('sha256').update(getClientIp(req)).digest('hex');
  const policies = [
    { scope: 'ip', max: maxPerIp, key: (req) => `${prefix}:ip:${clientHash(req)}` },
    { scope: 'ip-account', max: maxPerIpAccount, key: (req) => `${prefix}:pair:${clientHash(req)}:${identityHash(req)}` },
  ];

  return policies.map((policy) => async function sharedLoginRateLimit(req, res, next) {
    try {
      const outcome = await consume({ bucketKey: policy.key(req), max: policy.max, windowMs });
      req.loginThrottle = {
        ...(req.loginThrottle || {}),
        [policy.scope]: { count: outcome.count, limit: outcome.limit, remaining: outcome.remaining, retryAfterSec: outcome.retryAfterSec },
        // Extension point for a future account recovery / step-up challenge policy.
        challengeSuggested: policy.scope === 'ip-account' && outcome.count >= Math.max(1, policy.max - 2),
      };
      res.setHeader('RateLimit-Limit', String(policy.max));
      res.setHeader('RateLimit-Remaining', String(outcome.remaining));
      res.setHeader('RateLimit-Reset', String(outcome.retryAfterSec));
      if (!outcome.allowed) {
        res.setHeader('Retry-After', String(outcome.retryAfterSec));
        if (typeof options.onLimited === 'function') await options.onLimited(req, { scope: policy.scope, ...outcome });
        return next(new RateLimitError(options.message || 'Too many login attempts. Please try again later.', outcome.retryAfterSec));
      }
      return next();
    } catch (_err) {
      if (sharedStore) {
        return next(new DatabaseError('LOGIN_RATE_LIMIT_UNAVAILABLE', 'Login protection is temporarily unavailable.', 503));
      }
      return next(_err);
    }
  });
}

async function consumeLocalLoginBucket({ bucketKey, max, windowMs }) {
  const now = Date.now();
  let bucket = localLoginBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    localLoginBuckets.set(bucketKey, bucket);
  }
  const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const allowed = bucket.count < max;
  if (allowed) bucket.count += 1;
  if (localLoginBuckets.size > 20_000) {
    for (const [key, entry] of localLoginBuckets) if (entry.resetAt <= now) localLoginBuckets.delete(key);
  }
  return { allowed, count: bucket.count, limit: max, remaining: Math.max(0, max - bucket.count), retryAfterSec };
}

module.exports = {
  getClientIp,
  createRateLimiter,
  normalizeLoginIdentifier,
  createLoginRateLimiters,
};
