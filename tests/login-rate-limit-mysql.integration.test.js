'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { env } = require('../src/config/env');
const mysql = require('../src/db/mysqlPool');
const { consumeLoginBucket } = require('../src/repositories/loginRateLimitRepository');

const testDatabase = /(?:^|[_-])test(?:[_-]|$)/i.test(String(env.db.name || process.env.MYSQL_TEST_DB || ''));
const isMySQLConfigured = env.db.client === 'mysql' || process.env.MYSQL_TEST_REQUIRED === 'true' || Boolean(process.env.MYSQL_TEST_HOST);
const enabled = (process.env.RUN_MYSQL_LOGIN_LIMIT_TESTS === '1' || process.env.MYSQL_TEST_REQUIRED === 'true' || Boolean(process.env.MYSQL_TEST_HOST)) &&
  env.nodeEnv !== 'production' &&
  isMySQLConfigured &&
  testDatabase;
const skipReason = enabled ? false : 'SKIP: requires disposable MySQL/MariaDB service with DB_NAME containing "test" (or RUN_MYSQL_LOGIN_LIMIT_TESTS=1).';

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
