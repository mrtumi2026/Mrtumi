'use strict';

const mysql = require('../db/mysqlPool');

let operationsSinceCleanup = 0;
const CLEANUP_EVERY = 256;
const CLEANUP_BATCH = 500;

/**
 * Atomically consumes one MySQL-backed fixed-window bucket. The existing
 * `rate_limits` table is shared with other bounded security workflows; expiry
 * cleanup only removes rows whose reset_at has passed.
 */
async function consumeLoginBucket({ bucketKey, max, windowMs }) {
  if (typeof bucketKey !== 'string' || !bucketKey || bucketKey.length > 191) {
    throw new TypeError('A rate-limit bucket key of at most 191 characters is required.');
  }
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000) {
    throw new TypeError('A positive limit and a window of at least one second are required.');
  }
  const seconds = Math.ceil(windowMs / 1000);

  const result = await mysql.withTransaction(async (tx) => {
    await tx.execute(
      `INSERT IGNORE INTO rate_limits (bucket_key, hit_count, reset_at, updated_at)
       VALUES (?, 0, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), UTC_TIMESTAMP())`,
      [bucketKey, seconds]
    );
    const row = await tx.queryOne(
      `SELECT hit_count, reset_at,
              (reset_at <= UTC_TIMESTAMP()) AS is_expired,
              GREATEST(1, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), reset_at)) AS retry_after_sec
       FROM rate_limits WHERE bucket_key = ? FOR UPDATE`,
      [bucketKey]
    );
    if (!row) throw new Error('Rate-limit bucket disappeared during a transaction.');

    let count;
    let retryAfterSec;
    let allowed;
    if (Number(row.is_expired) === 1) {
      await tx.execute(
        `UPDATE rate_limits
         SET hit_count = 1, reset_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), updated_at = UTC_TIMESTAMP()
         WHERE bucket_key = ?`,
        [seconds, bucketKey]
      );
      count = 1;
      retryAfterSec = seconds;
      allowed = true;
    } else {
      retryAfterSec = Math.max(1, Number(row.retry_after_sec) || seconds);
      count = Number(row.hit_count) || 0;
      if (count < max) {
        await tx.execute(
          'UPDATE rate_limits SET hit_count = hit_count + 1, updated_at = UTC_TIMESTAMP() WHERE bucket_key = ?',
          [bucketKey]
        );
        count += 1;
        allowed = true;
      } else {
        allowed = false;
      }
    }

    return {
      allowed,
      count,
      limit: max,
      remaining: Math.max(0, max - count),
      retryAfterSec,
    };
  });

  operationsSinceCleanup += 1;
  if (operationsSinceCleanup >= CLEANUP_EVERY) {
    operationsSinceCleanup = 0;
    // Bounded housekeeping: expired OTP/security buckets are safe to remove too.
    // A cleanup failure must not turn a successfully consumed login bucket into an allow.
    mysql.execute(
      `DELETE FROM rate_limits WHERE reset_at <= UTC_TIMESTAMP() LIMIT ${CLEANUP_BATCH}`
    ).catch(() => {});
  }
  return result;
}

module.exports = { consumeLoginBucket };
