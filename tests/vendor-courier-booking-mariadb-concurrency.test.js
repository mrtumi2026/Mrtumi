'use strict';

/**
 * MARIADB / MYSQL MULTI-CONNECTION CONCURRENCY & ACID INTEGRATION TEST
 *
 * Verifies true database-level concurrency and isolation across two or more
 * independent connection pool instances (never mock connections).
 *
 * Safety Policy:
 * - Operates ONLY against an isolated disposable test database (mrtumi_test).
 * - NEVER runs against production or cPanel databases.
 * - When MYSQL_TEST_HOST is absent (local developer sandbox without mysqld),
 *   skips gracefully with an explicit message according to project convention.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createPoolFromConfig,
  closePool,
  withTransaction
} = require('../src/db/mysqlPool');
const { loadMigrationPairs, migrateUp } = require('../src/db/migrator');
const { ConflictError, AuthorizationError } = require('../src/utils/errors');

const MYSQL_HOST = (process.env.MYSQL_TEST_HOST || '').trim();
const MYSQL_REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';

const testDbConfig = MYSQL_HOST
  ? {
      host: MYSQL_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      name: process.env.MYSQL_TEST_DB || 'mrtumi_test',
      user: process.env.MYSQL_TEST_USER || 'mrtumi_test',
      password: process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw',
      charset: 'utf8mb4',
      timezone: '+00:00',
      connectionLimit: 10,
    }
  : null;

if (MYSQL_REQUIRED && !testDbConfig) {
  throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
}

const SKIP_REASON =
  'SKIPPED locally: no local MariaDB/MySQL daemon in sandbox; runs against real MariaDB service in CI with independent connection pools';

describe('MariaDB Multi-Connection Concurrency & ACID Integration Suite', { skip: !testDbConfig && SKIP_REASON }, () => {
  let pool = null;

  before(async () => {
    if (!testDbConfig) return;
    pool = createPoolFromConfig(testDbConfig);
    const migDir = path.join(__dirname, '../src/db/migrations');
    await migrateUp(pool, { migrationsDir: migDir, targetVersion: '0038' });
  });

  after(async () => {
    if (pool) {
      await closePool(pool);
    }
  });

  test('MariaDB generated virtual column unique constraint rejects concurrent insert across 2 independent connections', async () => {
    const subOrderId = 88801;
    const orderId = 7701;
    const vendorId = 501;

    // Clean up test rows
    await pool.query('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', [subOrderId]);
    await pool.query('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', [subOrderId]);

    // Acquire two independent pool connections
    const connA = await pool.getConnection();
    const connB = await pool.getConnection();

    try {
      const insertSql = `
        INSERT INTO vendor_courier_booking_requests
        (sub_order_id, order_id, vendor_id, courier_code, status, vendor_notes, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, 'steadfast', 'pending', 'Concurrent insert test', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
      `;

      // Launch simultaneous inserts from both independent connections
      const results = await Promise.allSettled([
        connA.query(insertSql, [subOrderId, orderId, vendorId, `idemp-connA-${Date.now()}`]),
        connB.query(insertSql, [subOrderId, orderId, vendorId, `idemp-connB-${Date.now()}`]),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent connection must succeed inserting active request');
      assert.strictEqual(rejected.length, 1, 'Second concurrent connection must be rejected by uq_vcbr_active_sub_order');

      const err = rejected[0].reason;
      assert.ok(
        err.code === 'ER_DUP_ENTRY' && String(err.message).includes('uq_vcbr_active_sub_order'),
        `Rejection must be ER_DUP_ENTRY on uq_vcbr_active_sub_order, received: ${err.message}`
      );
    } finally {
      connA.release();
      connB.release();
    }
  });

  test('MariaDB atomic row update lock prevents race between 2 independent admin connections', async () => {
    const subOrderId = 88802;
    const orderId = 7702;
    const vendorId = 502;

    await pool.query('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', [subOrderId]);
    await pool.query('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', [subOrderId]);

    const [insertRes] = await pool.query(
      `INSERT INTO vendor_courier_booking_requests
       (sub_order_id, order_id, vendor_id, courier_code, status, created_at, updated_at)
       VALUES (?, ?, ?, 'steadfast', 'pending', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [subOrderId, orderId, vendorId]
    );
    const reqId = insertRes.insertId;

    const conn1 = await pool.getConnection();
    const conn2 = await pool.getConnection();

    try {
      const lockSql = `
        UPDATE vendor_courier_booking_requests
        SET status = 'booking', approved_by_admin_id = ?, admin_notes = ?, updated_at = UTC_TIMESTAMP()
        WHERE id = ? AND status IN ('pending', 'failed', 'in_review')
      `;

      // Both connections compete simultaneously for the booking lock
      const [res1, res2] = await Promise.all([
        conn1.query(lockSql, [1001, 'Admin 1 lock attempt', reqId]),
        conn2.query(lockSql, [1002, 'Admin 2 lock attempt', reqId]),
      ]);

      const affected1 = res1[0].affectedRows;
      const affected2 = res2[0].affectedRows;

      assert.strictEqual(
        affected1 + affected2,
        1,
        'Sum of affectedRows must be exactly 1: exactly one admin connection acquires booking lock'
      );

      const [rows] = await pool.query('SELECT status, approved_by_admin_id FROM vendor_courier_booking_requests WHERE id = ?', [reqId]);
      assert.strictEqual(rows[0].status, 'booking');
      assert.ok([1001, 1002].includes(Number(rows[0].approved_by_admin_id)));
    } finally {
      conn1.release();
      conn2.release();
    }
  });

  test('MariaDB transactional rollback: audit log failure rolls back request state change', async () => {
    const subOrderId = 88803;
    const orderId = 7703;
    const vendorId = 503;

    await pool.query('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', [subOrderId]);
    await pool.query('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', [subOrderId]);

    const [insertRes] = await pool.query(
      `INSERT INTO vendor_courier_booking_requests
       (sub_order_id, order_id, vendor_id, courier_code, status, created_at, updated_at)
       VALUES (?, ?, ?, 'steadfast', 'pending', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [subOrderId, orderId, vendorId]
    );
    const reqId = insertRes.insertId;

    // Execute withTransaction with intentional audit failure
    await assert.rejects(
      async () => {
        await withTransaction(async (tx) => {
          // 1. Update status to 'booking'
          await tx.execute(
            `UPDATE vendor_courier_booking_requests
             SET status = 'booking', updated_at = UTC_TIMESTAMP()
             WHERE id = ?`,
            [reqId]
          );

          // 2. Intentionally trigger an invalid query to simulate audit failure
          await tx.execute('INSERT INTO non_existent_audit_table VALUES (1)');
        }, { pool });
      }
    );

    // Verify transaction rolled back: status must remain 'pending'
    const [rows] = await pool.query('SELECT status FROM vendor_courier_booking_requests WHERE id = ?', [reqId]);
    assert.strictEqual(rows[0].status, 'pending', 'Status change must roll back when audit/transaction fails');
  });
});
