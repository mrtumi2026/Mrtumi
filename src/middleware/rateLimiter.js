'use strict';

/**
 * Distributed Rate Limiter with Redis & In-Memory Fallback
 * ========================================================
 * High-performance sliding-window rate limiter.
 * Automatically tries to connect to Redis (`ioredis`). If Redis is unavailable
 * or offline, falls back seamlessly to an in-memory sliding window cache without crashing.
 *
 * Emits standard headers:
 *  - RateLimit-Limit
 *  - RateLimit-Remaining
 *  - RateLimit-Reset
 *  - Retry-After (on 429)
 */

let Redis;
try {
  Redis = require('ioredis');
} catch {
  Redis = null;
}

const { RateLimitError } = require('../utils/errors');
const { logger } = require('../utils/logger');

let redisClient = null;
let isRedisReady = false;

// Initialize Redis if REDIS_URL or REDIS_HOST is configured
if (Redis && (process.env.REDIS_URL || process.env.REDIS_HOST)) {
  try {
    redisClient = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false })
      : new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
          password: process.env.REDIS_PASSWORD || undefined,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });

    redisClient.connect().then(() => {
      isRedisReady = true;
      logger.info({ event: 'redis_connected_for_rate_limiter' });
    }).catch((err) => {
      logger.warn({ event: 'redis_connect_failed_using_memory_fallback', error: err.message });
      isRedisReady = false;
    });

    redisClient.on('error', (err) => {
      isRedisReady = false;
      logger.warn({ event: 'redis_error_rate_limiter_memory_mode', error: err.message });
    });

    redisClient.on('ready', () => {
      isRedisReady = true;
    });
  } catch (err) {
    logger.warn({ event: 'redis_init_error_fallback', error: err.message });
    isRedisReady = false;
  }
}

/**
 * Extracts normalized client IP (handling LiteSpeed / Passenger proxy hops).
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = String(forwarded).split(',');
    return parts[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Factory for creating custom rate limiters.
 */
function createDistributedRateLimiter({
  keyPrefix = 'rl',
  windowMs = 60_000,
  max = 60,
  message = 'Too many requests. Please slow down and try again later.',
  keyGenerator,
} = {}) {
  // In-memory fallback map: key -> { count, resetAt }
  const memoryBuckets = new Map();

  function memoryLimit(key, now) {
    // Evict old entries periodically
    if (memoryBuckets.size > 10_000) {
      for (const [k, v] of memoryBuckets.entries()) {
        if (v.resetAt <= now) memoryBuckets.delete(k);
      }
    }

    let entry = memoryBuckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      memoryBuckets.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const resetSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    return {
      allowed: entry.count <= max,
      remaining,
      resetSec,
    };
  }

  async function redisLimit(key) {
    const now = Date.now();
    const windowSec = Math.ceil(windowMs / 1000);
    const redisKey = `mrtumi:${keyPrefix}:${key}`;

    const tx = redisClient.multi();
    tx.incr(redisKey);
    tx.ttl(redisKey);

    const [incrRes, ttlRes] = await tx.exec();
    const count = incrRes[1];
    let ttl = ttlRes[1];

    if (ttl === -1) {
      await redisClient.expire(redisKey, windowSec);
      ttl = windowSec;
    }

    const remaining = Math.max(0, max - count);
    const resetSec = ttl > 0 ? ttl : windowSec;

    return {
      allowed: count <= max,
      remaining,
      resetSec,
    };
  }

  return async function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    let key;

    if (typeof keyGenerator === 'function') {
      key = keyGenerator(req);
    } else {
      const ip = getClientIp(req);
      const identifier = req.body?.email || req.body?.phone || req.sessionID || 'anon';
      key = `${ip}:${String(identifier).toLowerCase().slice(0, 50)}`;
    }

    let result;

    if (isRedisReady && redisClient) {
      try {
        result = await redisLimit(key);
      } catch (err) {
        logger.warn({ event: 'redis_limiter_error_memory_fallback', error: err.message });
        result = memoryLimit(key, now);
      }
    } else {
      result = memoryLimit(key, now);
    }

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(result.resetSec));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.resetSec));
      return next(new RateLimitError(message, result.resetSec));
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Standard Tiered Production Limiters
// ---------------------------------------------------------------------------

// 1. Auth routes (login/register/reset): 5 attempts per 15 minutes per IP + account
const authRateLimiter = createDistributedRateLimiter({
  keyPrefix: 'auth',
  windowMs: 15 * 60_000,
  max: 5,
  message: 'Too many authentication attempts. For security, please wait 15 minutes before trying again.',
});

// 2. Checkout & Payment: 10 requests per minute
const checkoutRateLimiter = createDistributedRateLimiter({
  keyPrefix: 'checkout',
  windowMs: 60_000,
  max: 10,
  message: 'Payment requests are throttled. Please wait a moment before trying again.',
});

// 3. Webhook endpoints: 120 per minute
const webhookRateLimiter = createDistributedRateLimiter({
  keyPrefix: 'webhook',
  windowMs: 60_000,
  max: 120,
  message: 'Webhook rate threshold exceeded.',
});

// 4. Public API / Storefront browse: 300 requests per minute
const publicApiRateLimiter = createDistributedRateLimiter({
  keyPrefix: 'public_api',
  windowMs: 60_000,
  max: 300,
  message: 'Request volume too high. Please slow down.',
});

module.exports = {
  createDistributedRateLimiter,
  authRateLimiter,
  checkoutRateLimiter,
  webhookRateLimiter,
  publicApiRateLimiter,
};
