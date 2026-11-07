'use strict';

/**
 * Multi-Tier Caching Service with Fallback
 * ========================================
 * High-speed caching layer for catalog browsing, homepage widgets, and category taxonomy.
 * Uses Redis (`ioredis`) when configured, with an automatic in-memory TTL Map fallback.
 */

let Redis;
try {
  Redis = require('ioredis');
} catch {
  Redis = null;
}

const { logger } = require('../utils/logger');

let redisClient = null;
let isRedisReady = false;

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
        });

    redisClient.connect().then(() => {
      isRedisReady = true;
      logger.info({ event: 'redis_connected_for_catalog_cache' });
    }).catch(() => {
      isRedisReady = false;
    });

    redisClient.on('error', () => { isRedisReady = false; });
    redisClient.on('ready', () => { isRedisReady = true; });
  } catch {
    isRedisReady = false;
  }
}

// In-memory fallback map: key -> { value, expiresAt }
const memoryCache = new Map();

function cleanMemoryCache() {
  const now = Date.now();
  if (memoryCache.size > 5_000) {
    for (const [k, v] of memoryCache.entries()) {
      if (v.expiresAt <= now) memoryCache.delete(k);
    }
  }
}

/**
 * Retrieves item from cache.
 */
async function get(key) {
  const fullKey = `mrtumi:cache:${key}`;
  if (isRedisReady && redisClient) {
    try {
      const raw = await redisClient.get(fullKey);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      logger.warn({ event: 'cache_redis_get_fallback', key, error: err.message });
    }
  }

  cleanMemoryCache();
  const entry = memoryCache.get(fullKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(fullKey);
    return null;
  }
  return entry.value;
}

/**
 * Stores item in cache with TTL in seconds.
 */
async function set(key, value, ttlSeconds = 300) {
  const fullKey = `mrtumi:cache:${key}`;
  const ttl = Math.max(1, Number(ttlSeconds || 300));

  if (isRedisReady && redisClient) {
    try {
      await redisClient.set(fullKey, JSON.stringify(value), 'EX', ttl);
      return true;
    } catch (err) {
      logger.warn({ event: 'cache_redis_set_fallback', key, error: err.message });
    }
  }

  cleanMemoryCache();
  memoryCache.set(fullKey, {
    value,
    expiresAt: Date.now() + (ttl * 1000),
  });
  return true;
}

/**
 * Deletes item from cache.
 */
async function del(key) {
  const fullKey = `mrtumi:cache:${key}`;
  if (isRedisReady && redisClient) {
    try {
      await redisClient.del(fullKey);
    } catch { /* ignore */ }
  }
  memoryCache.delete(fullKey);
  return true;
}

/**
 * Invalidate multiple keys matching a pattern.
 */
async function deleteByPattern(pattern) {
  const fullPattern = `mrtumi:cache:${pattern}`;

  if (isRedisReady && redisClient) {
    try {
      const stream = redisClient.scanStream({ match: fullPattern, count: 100 });
      stream.on('data', async (keys) => {
        if (keys.length) {
          const pipeline = redisClient.pipeline();
          keys.forEach((k) => pipeline.del(k));
          await pipeline.exec();
        }
      });
    } catch { /* ignore */ }
  }

  // Memory fallback pattern deletion
  const prefix = fullPattern.replace('*', '');
  for (const k of memoryCache.keys()) {
    if (k.startsWith(prefix)) {
      memoryCache.delete(k);
    }
  }
}

/**
 * Cache-aside wrapper: Retrieves if cached; otherwise fetches, caches, and returns.
 */
async function remember(key, ttlSeconds, fetcherFn) {
  const cached = await get(key);
  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const fresh = await fetcherFn();
  if (fresh !== null && fresh !== undefined) {
    await set(key, fresh, ttlSeconds);
  }
  return fresh;
}

/**
 * Middleware factory for route-level caching.
 */
function cacheMiddleware(ttlSeconds = 180, keyGenerator) {
  return async (req, res, next) => {
    // Only cache safe idempotent GET/HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    const cacheKey = typeof keyGenerator === 'function'
      ? keyGenerator(req)
      : `http:${req.locale || 'bn'}:${req.originalUrl || req.url}`;

    try {
      const cached = await get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        if (typeof cached === 'object') {
          return res.json(cached);
        }
        return res.send(cached);
      }

      res.setHeader('X-Cache', 'MISS');

      // Intercept res.send/res.json to save response to cache
      const originalSend = res.send.bind(res);
      res.send = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = typeof body === 'string' && (body.startsWith('{') || body.startsWith('['))
              ? JSON.parse(body)
              : body;
            set(cacheKey, parsed, ttlSeconds).catch(() => {});
          } catch {
            set(cacheKey, body, ttlSeconds).catch(() => {});
          }
        }
        return originalSend(body);
      };

      next();
    } catch {
      next();
    }
  };
}

/**
 * Automated catalog invalidation helper.
 * Call this whenever a product, category, or promotional banner is mutated.
 */
async function invalidateCatalogCache() {
  await Promise.all([
    deleteByPattern('catalog:*'),
    deleteByPattern('home:*'),
    deleteByPattern('categories:*'),
    deleteByPattern('search:*'),
    deleteByPattern('http:*'),
  ]);
  logger.info({ event: 'catalog_cache_invalidated' });
}

module.exports = {
  get,
  set,
  del,
  deleteByPattern,
  remember,
  cacheMiddleware,
  invalidateCatalogCache,
};
