'use strict';

/**
 * MARIADB / MYSQL MULTI-CONNECTION CONCURRENCY & ACID INTEGRATION TEST
 *
 * Verifies true database-level concurrency and isolation across two independent
 * connection pool instances (poolA and poolB) connected to a disposable test database.
 *
 * Safety Policy:
 * - Operates ONLY against an isolated disposable local test database (mrtumi_test).
 * - Enforces strict guard assertDisposableTestProfile() forbidding production/cPanel hosts or schemas.
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

function assertDisposableTestProfile(cfg) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Refusing to run MariaDB concurrency test outside test NODE_ENV.');
  }
  const host = String(cfg?.host || '').trim().toLowerCase();
  const dbName = String(cfg?.name || '').trim().toLowerCase();

  // Strictly forbid remote or production hosts
  const allowedHosts = ['127.0.0.1', 'localhost', '::1'];
  if (!allowedHosts.includes(host)) {
    throw new Error(`Refusing test execution on non-local host "${host}". MariaDB tests must use localhost/127.0.0.1.`);
  }

  // Strictly enforce disposable test schema name
  if (dbName !== 'mrtumi_test') {
    throw new Error(`Refusing test execution on non-disposable schema "${dbName}". Must be "mrtumi_test".`);
  }

  // Safety check: ensure DB name does not contain 'prod' or match known production patterns
  if (dbName.includes('prod') || host.includes('mrtumi.com') || host.includes('cpanel')) {
    throw new Error('Dangerous configuration detected: test configuration points to production environment.');
  }
}

const SKIP_REASON =
  'SKIPPED locally: no local MariaDB/MySQL daemon in sandbox; runs against real MariaDB service in CI with independent connection pools';

describe('MariaDB Multi-Connection Concurrency & ACID Integration Suite', { skip: !testDbConfig && SKIP_REASON }, () => {
  let poolA = null;
  let poolB = null;

  before(async () => {
    if (!testDbConfig) return;
    assertDisposableTestProfile(testDbConfig);

    // Create TWO distinct independent connection pools to represent distinct client applications/workers
    poolA = createPoolFromConfig({ ...testDbConfig, connectionLimit: 5 });
    poolB = createPoolFromConfig({ ...testDbConfig, connectionLimit: 5 });

    const migDir = path.join(__dirname, '../src/db/migrations');
    await migrateUp(poolA, { migrationsDir: migDir, targetVersion: '0038' });
  });

  after(async () => {
    if (poolA) await closePool(poolA);
    if (poolB) await closePool(poolB);
  });

  test('MariaDB generated virtual column unique constraint rejects concurrent insert across 2 independent connection pools', async () => {
    const subOrderId = 88801;
    const orderId = 7701;
    const vendorId = 501;

    // Clean up test rows
    await poolA.query('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', [subOrderId]);
    await poolA.query('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', [subOrderId]);

    // Acquire connections from distinct independent connection pools
    const connA = await poolA.getConnection();
    const connB = await poolB.getConnection();

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

  test('MariaDB atomic row update lock prevents race between 2 independent admin connection pools', async () => {
    const subOrderId = 88802;
    const orderId = 7702;
    const vendorId = 502;

    await poolA.query('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', [subOrderId]);
    await poolA.query('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', [subOrderId]);

    const [insertRes] = await poolA.query(
      `INSERT INTO vendor_courier_booking_requests
       (sub_order_id, order_id, vendor_id, courier_code, status, created_at, updated_at)
       VALUES (?, ?, ?, 'steadfast', 'pending', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [subOrderId, orderId, vendorId]
    );
    const reqId = insertRes.insertId;

    // Connections from separate pools
    const conn1 = await poolA.getConnection();
    const conn2 = await poolB.getConnection();

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

      const [rows] = await poolA.query('SELECT status, approved_by_admin_id FROM vendor_courier_booking_requests WHERE id = ?', [reqId]);
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

    await poolA.query('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', [subOrderId]);
    await poolA.query('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', [subOrderId]);

    const [insertRes] = await poolA.query(
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
        }, { pool: poolA });
      }
    );

    // Verify transaction rolled back: status must remain 'pending'
    const [rows] = await poolA.query('SELECT status FROM vendor_courier_booking_requests WHERE id = ?', [reqId]);
    assert.strictEqual(rows[0].status, 'pending', 'Status change must roll back when audit/transaction fails');
  });
});
