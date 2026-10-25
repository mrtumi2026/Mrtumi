'use strict';

const crypto = require('crypto');
const { withTransaction } = require('../db/mysqlPool');
const { AppError } = require('../utils/errors');

function hashPayload(payload) {
  const canonical = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toMysqlUtcDatetime(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Executes a critical operation (checkout submit, payment capture, webhook, withdrawal)
 * with database-enforced idempotency on `(scope, idem_key)`.
 *
 * - First caller inserts `status='processing'` and executes `workFn(tx)`.
 * - Duplicate caller with identical payload receives `{ replayed: true, statusCode, response }`
 *   if already completed, or throws 409 `IDEMPOTENCY_IN_PROGRESS` if concurrently executing.
 * - Duplicate caller reusing the same key with a DIFFERENT payload throws 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`.
 * - If `workFn` throws, the entire transaction rolls back cleanly so a valid retry can proceed.
 */
async function executeIdempotent(
  {
    scope,
    idempotencyKey,
    payload = {},
    ttlSeconds = 86_400,
    workFn,
  },
  poolOverride = null
) {
  const cleanScope = String(scope || '').trim();
  const cleanKey = String(idempotencyKey || '').trim();
  if (!cleanScope || !cleanKey) {
    throw new Error('Both scope and idempotencyKey are required for idempotent execution.');
  }

  const reqHash = hashPayload(payload);
  const expiresUtc = toMysqlUtcDatetime(Date.now() + ttlSeconds * 1000);

  return withTransaction(
    async (tx) => {
      await tx.execute(
        'DELETE FROM `idempotency_keys` WHERE `scope` = ? AND `idem_key` = ? AND `expires_at` <= UTC_TIMESTAMP()',
        [cleanScope, cleanKey]
      );

      let insertedNew = false;
      try {
        await tx.execute(
          `INSERT INTO \`idempotency_keys\`
            (\`scope\`, \`idem_key\`, \`request_hash\`, \`status\`, \`expires_at\`)
           VALUES (?, ?, ?, 'processing', ?)`,
          [cleanScope, cleanKey, reqHash, expiresUtc]
        );
        insertedNew = true;
      } catch (err) {
        if (err && err.code !== 'DB_DUPLICATE_ENTRY') {
          throw err;
        }
      }

      if (!insertedNew) {
        const existing = await tx.queryOne(
          'SELECT * FROM `idempotency_keys` WHERE `scope` = ? AND `idem_key` = ? FOR UPDATE',
          [cleanScope, cleanKey]
        );
        if (!existing) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Concurrent idempotency state conflict. Please retry.',
            409
          );
        }
        if (existing.request_hash !== reqHash) {
          throw new AppError(
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            'Idempotency key was already used with different request parameters.',
            409
          );
        }
        if (existing.status === 'completed') {
          return {
            replayed: true,
            statusCode: existing.response_code || 200,
            response: existing.response_json ? JSON.parse(existing.response_json) : null,
          };
        }
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'An identical request is currently being processed.',
          409
        );
      }

      const result = await workFn(tx);
      const statusCode = Number(result?.statusCode || 200);
      const responseBody =
        result && Object.prototype.hasOwnProperty.call(result, 'response')
          ? result.response
          : result;

      await tx.execute(
        `UPDATE \`idempotency_keys\`
         SET \`status\` = 'completed', \`response_code\` = ?, \`response_json\` = ?
         WHERE \`scope\` = ? AND \`idem_key\` = ?`,
        [statusCode, JSON.stringify(responseBody ?? null), cleanScope, cleanKey]
      );

      return {
        replayed: false,
        statusCode,
        response: responseBody,
      };
    },
    { pool: poolOverride }
  );
}

module.exports = {
  hashPayload,
  executeIdempotent,
};
