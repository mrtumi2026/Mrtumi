'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { env } = require('../src/config/env');
const mysql = require('../src/db/mysqlPool');
const { consumeLoginBucket } = require('../src/repositories/loginRateLimitRepository');

const testDatabase = /(?:^|[_-])test(?:[_-]|$)/i.test(String(env.db.name || ''));
const enabled = process.env.RUN_MYSQL_LOGIN_LIMIT_TESTS === '1' && env.nodeEnv !== 'production' && env.db.client === 'mysql' && testDatabase;
const skipReason = enabled ? false : 'SKIP: requires RUN_MYSQL_LOGIN_LIMIT_TESTS=1, NODE_ENV=test/development, DB_CLIENT=mysql and a disposable DB_NAME containing "test".';

test('MySQL login limiter is atomic under concurrency, persists across pool restart, and expires', { skip: skipReason }, async () => {
  const suffix = crypto.randomBytes(12).toString('hex');
  const restartKey = `round3:test:restart:${suffix}`;
  const concurrentKey = `round3:test:concurrent:${suffix}`;
  const expiryKey = `round3:test:expiry:${suffix}`;
  const keys = [restartKey, concurrentKey, expiryKey];
  try {
    await mysql.execute('DELETE FROM rate_limits WHERE bucket_key IN (?, ?, ?)', keys);

    assert.equal((await consumeLoginBucket({ bucketKey: restartKey, max: 2, windowMs: 60_000 })).allowed, true);
    await mysql.closePool(); // simulate process/pool restart without deleting the shared DB row
    assert.equal((await consumeLoginBucket({ bucketKey: restartKey, max: 2, windowMs: 60_000 })).allowed, true);
    assert.equal((await consumeLoginBucket({ bucketKey: restartKey, max: 2, windowMs: 60_000 })).allowed, false);

    const concurrent = await Promise.all(Array.from({ length: 20 }, () => consumeLoginBucket({ bucketKey: concurrentKey, max: 5, windowMs: 60_000 })));
    assert.equal(concurrent.filter((result) => result.allowed).length, 5);
    assert.equal(concurrent.filter((result) => !result.allowed).length, 15);

    assert.equal((await consumeLoginBucket({ bucketKey: expiryKey, max: 1, windowMs: 1000 })).allowed, true);
    assert.equal((await consumeLoginBucket({ bucketKey: expiryKey, max: 1, windowMs: 1000 })).allowed, false);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal((await consumeLoginBucket({ bucketKey: expiryKey, max: 1, windowMs: 1000 })).allowed, true);
  } finally {
    await mysql.execute('DELETE FROM rate_limits WHERE bucket_key IN (?, ?, ?)', keys).catch(() => {});
    await mysql.closePool().catch(() => {});
  }
});
