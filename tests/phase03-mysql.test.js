'use strict';

/**
 * PHASE 03 — LIVE MYSQL 8.0 INTEGRATION & ACID VERIFICATION SUITE
 *
 * Honesty & Safety Policy:
 * - Never mocks MySQL. Connects ONLY to an isolated test MySQL schema (`MYSQL_TEST_*`).
 * - When `MYSQL_TEST_HOST` is absent locally (e.g., sandbox without mysqld/docker),
 *   tests mark themselves explicitly SKIPPED with a clear explanation.
 * - When `MYSQL_TEST_REQUIRED=true` (GitHub Actions `mysql:8.0` CI job), skipping is
 *   FORBIDDEN and missing/unreachable MySQL fails the build immediately.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_SILENT = 'true';

const {
  createPoolFromConfig,
  closePool,
  pingPool,
  createQueryClient,
  withTransaction,
} = require('../src/db/mysqlPool');
const {
  migrateUp,
  migrateDown,
  getMigrationStatus,
  MigrationError,
} = require('../src/db/migrator');
const { executeIdempotent } = require('../src/repositories/idempotencyRepository');
const { adjustProductStockAtomically } = require('../src/repositories/inventoryFoundationRepository');
const settingsRepo = require('../src/repositories/settingsRepository');
const sessionRepo = require('../src/repositories/sessionRepository');
const authRepo = require('../src/repositories/authRepository');
const auditRepo = require('../src/repositories/auditLogRepository');
const { bdtToPaisa, computeOrderTotalsPaisa } = require('../src/utils/money');

const MYSQL_REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const MYSQL_HOST = (process.env.MYSQL_TEST_HOST || '').trim();

const testDbConfig = MYSQL_HOST
  ? {
      host: MYSQL_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      name: process.env.MYSQL_TEST_DB || 'mrtumi_test',
      user: process.env.MYSQL_TEST_USER || 'mrtumi_test',
      password: process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw',
      charset: 'utf8mb4',
      timezone: '+00:00',
      connectionLimit: 8,
    }
  : null;

if (MYSQL_REQUIRED && !testDbConfig) {
  throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
}

const SKIP_REASON =
  'SKIPPED locally: no local mysqld/docker in sandbox; runs against real mysql:8.0 service in GitHub Actions CI';

describe('Phase 03 — Real MySQL 8.0 Schema, Migrations, Constraints, Transactions & Concurrency', () => {
  let pool = null;
  let dbClient = null;

  before(async () => {
    if (!testDbConfig) return;

    // Safety guard: refuse running destructive schema reset unless DB name explicitly ends with `_test`
    if (!testDbConfig.name.endsWith('_test')) {
      throw new Error(
        `SAFETY ABORT: Live MySQL test suite refuses to run against non-test database "${testDbConfig.name}".`
      );
    }

    pool = createPoolFromConfig(testDbConfig);
    const health = await pingPool(pool, 8000);
    if (!health.ok) {
      await closePool(pool);
      pool = null;
      throw new Error(`Unable to reach test MySQL server: ${health.message}`);
    }
    dbClient = createQueryClient(pool);

    // Ensure clean test database before running suite
    const conn = await pool.getConnection();
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const [tables] = await conn.query(
        'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
        [testDbConfig.name]
      );
      for (const row of tables) {
        await conn.query(`DROP TABLE IF EXISTS \`${row.t}\``);
      }
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      conn.release();
    }
  });

  after(async () => {
    if (pool) {
      await closePool(pool);
    }
  });

  test('1. Clean MySQL schema creation, reversible down/up cycle, InnoDB + utf8mb4_unicode_ci verification', async (t) => {
    if (!pool) return t.skip(SKIP_REASON);

    const applied = await migrateUp(pool);
    assert.equal(applied.length, 3);
    assert.deepEqual(
      applied.map((m) => m.version),
      ['0001', '0002', '0003']
    );

    const statusAfterUp = await getMigrationStatus(pool);
    assert.equal(statusAfterUp.every((s) => s.applied), true);

    const tableMeta = await dbClient.queryAll(
      `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'`,
      [testDbConfig.name]
    );
    assert.equal(tableMeta.length, 71, 'All 71 domain tables must be created');
    for (const tbl of tableMeta) {
      assert.equal(tbl.engine, 'InnoDB', `Table ${tbl.name} must use InnoDB`);
      assert.equal(
        tbl.collation,
        'utf8mb4_unicode_ci',
        `Table ${tbl.name} must use utf8mb4_unicode_ci`
      );
    }

    // Roll back all 3 migrations in reverse FK order and verify clean schema
    const rolledBack = await migrateDown(pool, { steps: 3 });
    assert.equal(rolledBack.length, 3);
    assert.deepEqual(
      rolledBack.map((m) => m.version),
      ['0003', '0002', '0001']
    );

    const remainingTables = await dbClient.queryAll(
      `SELECT TABLE_NAME AS name
       FROM information_schema.tables
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'`,
      [testDbConfig.name]
    );
    assert.equal(remainingTables.length, 0, 'All domain tables must drop cleanly on full rollback');

    // Re-apply cleanly for subsequent tests
    const reapplied = await migrateUp(pool);
    assert.equal(reapplied.length, 3);
  });

  test('2. Migration checksum tamper detection, out-of-order rejection, and failed statement handling', async (t) => {
    if (!pool) return t.skip(SKIP_REASON);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrtumi-mysql-mig-'));
    try {
      // Copy real migrations into temp dir and tamper with 0001
      const realDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
      for (const f of fs.readdirSync(realDir)) {
        fs.copyFileSync(path.join(realDir, f), path.join(tmpDir, f));
      }

      fs.appendFileSync(path.join(tmpDir, '0001_core_security_and_sessions.up.sql'), '\n-- tampered\n');
      await assert.rejects(
        () => getMigrationStatus(pool, { migrationsDir: tmpDir }),
        (err) => err instanceof MigrationError && err.code === 'MIGRATION_CHECKSUM_MISMATCH'
      );

      // Restore 0001 checksum, add failing 0004 migration, verify failure handling & advisory lock release
      fs.copyFileSync(
        path.join(realDir, '0001_core_security_and_sessions.up.sql'),
        path.join(tmpDir, '0001_core_security_and_sessions.up.sql')
      );
      fs.writeFileSync(
        path.join(tmpDir, '0004_broken_sql.up.sql'),
        'INVALID SQL STATEMENT THAT MUST FAIL;'
      );
      fs.writeFileSync(
        path.join(tmpDir, '0004_broken_sql.down.sql'),
        'SELECT 1;'
      );

      await assert.rejects(
        () => migrateUp(pool, { migrationsDir: tmpDir }),
        (err) => err instanceof MigrationError && err.code === 'MIGRATION_STATEMENT_FAILED'
      );

      // Verify 0004 was NOT recorded in schema_migrations and advisory lock was released
      const status = await getMigrationStatus(pool);
      assert.equal(status.length, 3);
      const lockCheck = await dbClient.queryOne(
        "SELECT IS_FREE_LOCK('mrtumi_schema_migration') AS free_lock"
      );
      assert.equal(Number(lockCheck.free_lock), 1, 'Migration advisory lock must be released on failure');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('3. Foreign key & unique constraints, BIGINT paisa storage, and Phase 03 repositories', async (t) => {
    if (!pool) return t.skip(SKIP_REASON);

    // Settings, Sessions, Auth/RBAC, Audit Logs against real MySQL
    await settingsRepo.setSetting('site_name', 'মি. তুমি গ্রোসারি ও গিফট', pool);
    const fetchedName = await settingsRepo.getSetting('site_name', '', pool);
    assert.equal(fetchedName, 'মি. তুমি গ্রোসারি ও গিফট');

    const sid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    await sessionRepo.upsertSession(
      {
        sid,
        dataJson: JSON.stringify({ cart: [{ id: 1, qty: 2 }] }),
        expiresAtMs: Date.now() + 60_000,
        ipAddress: '103.108.140.10',
      },
      pool
    );
    const activeSess = await sessionRepo.getActiveSession(sid, Date.now(), pool);
    assert.ok(activeSess);
    assert.equal(JSON.parse(activeSess.dataJson).cart[0].qty, 2);

    // Role + Permission + Admin User
    const roleRes = await dbClient.execute(
      'INSERT INTO `roles` (`name`, `slug`) VALUES (?, ?)',
      ['Order Manager', 'order_manager']
    );
    const permRes = await dbClient.execute(
      'INSERT INTO `permissions` (`name`, `module`) VALUES (?, ?)',
      ['orders.approve', 'orders']
    );
    await dbClient.execute(
      'INSERT INTO `role_permissions` (`role_id`, `permission_id`) VALUES (?, ?)',
      [roleRes.insertId, permRes.insertId]
    );

    const pwHash = await bcrypt.hash('SecretAdmin!2026', 10);
    const userRes = await dbClient.execute(
      'INSERT INTO `users` (`role_id`, `name`, `email`, `phone`, `password_hash`, `status`) VALUES (?, ?, ?, ?, ?, 1)',
      [roleRes.insertId, 'Rahim Uddin', 'rahim@mrtumi.test', '01711223344', pwHash]
    );

    // Unique constraint on users.email
    await assert.rejects(
      () =>
        dbClient.execute(
          'INSERT INTO `users` (`role_id`, `name`, `email`, `password_hash`) VALUES (?, ?, ?, ?)',
          [roleRes.insertId, 'Duplicate', 'rahim@mrtumi.test', pwHash]
        ),
      (err) => err.code === 'DB_DUPLICATE_ENTRY' && err.statusCode === 409
    );

    const loadedAdmin = await authRepo.findActiveAdminByEmail('rahim@mrtumi.test', pool);
    assert.equal(loadedAdmin.id, userRes.insertId);
    assert.equal(loadedAdmin.role_slug, 'order_manager');
    assert.deepEqual(loadedAdmin.permissions, ['orders.approve']);

    // Audit log PII redaction in MySQL
    await auditRepo.recordAuditLog(
      {
        actorType: 'admin',
        actorId: userRes.insertId,
        action: 'order.verify',
        entityType: 'orders',
        entityId: '1001',
        metadata: { customer_phone: '01712345678', api_token: 'SHOULD_NOT_PERSIST' },
      },
      pool
    );
    const savedAudit = await dbClient.queryOne(
      'SELECT * FROM `audit_logs` WHERE `actor_id` = ? LIMIT 1',
      [userRes.insertId]
    );
    assert.ok(!savedAudit.after_json.includes('SHOULD_NOT_PERSIST'));
    assert.ok(savedAudit.after_json.includes('01712****78'));

    // Foreign key enforcement: inserting order_items for non-existent order_id MUST fail
    const catRes = await dbClient.execute(
      'INSERT INTO `categories` (`name_bn`, `name_en`, `slug`) VALUES (?, ?, ?)',
      ['গ্রোসারি', 'Grocery', 'grocery']
    );
    const prodRes = await dbClient.execute(
      `INSERT INTO \`products\`
        (\`sku\`, \`slug\`, \`name_bn\`, \`name_en\`, \`category_id\`, \`regular_price_paisa\`, \`sale_price_paisa\`, \`stock_on_hand\`, \`vendor_stock_on_hand\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['MRT-RICE-05', 'miniket-rice-5kg', 'মিনিকেট চাল ৫ কেজি', 'Miniket Rice 5kg', catRes.insertId, bdtToPaisa('450'), bdtToPaisa('420'), 10, 7]
    );

    await assert.rejects(
      () =>
        dbClient.execute(
          `INSERT INTO \`order_items\`
            (\`order_id\`, \`product_id\`, \`product_name\`, \`unit_price_paisa\`, \`qty\`, \`line_total_paisa\`)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [999999, prodRes.insertId, 'Miniket Rice 5kg', 42000, 1, 42000]
        ),
      (err) => err.code === 'DB_FOREIGN_KEY_CONSTRAINT' && err.statusCode === 409
    );

    // BIGINT paisa roundtrip & ON DELETE RESTRICT protection on orders -> order_items
    const calc = computeOrderTotalsPaisa({
      items: [{ unitPricePaisa: 42000, qty: 2 }],
      shippingPaisa: 6000,
    });
    const orderRes = await dbClient.execute(
      `INSERT INTO \`orders\`
        (\`invoice_no\`, \`customer_name\`, \`customer_phone\`, \`shipping_address\`, \`subtotal_paisa\`, \`shipping_paisa\`, \`total_paisa\`, \`cod_due_paisa\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['MRT-20261025-0001', 'করিম সাহেব', '01811223344', 'Dhanmondi, Dhaka', calc.subtotalPaisa, calc.shippingPaisa, calc.totalPaisa, calc.codDuePaisa]
    );
    await dbClient.execute(
      `INSERT INTO \`order_items\`
        (\`order_id\`, \`product_id\`, \`product_name\`, \`unit_price_paisa\`, \`qty\`, \`line_total_paisa\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderRes.insertId, prodRes.insertId, 'মিনিকেট চাল ৫ কেজি', 42000, 2, 84000]
    );

    // Deleting parent order with existing order_items must be blocked by ON DELETE RESTRICT
    await assert.rejects(
      () => dbClient.execute('DELETE FROM `orders` WHERE `id` = ?', [orderRes.insertId]),
      (err) => err.code === 'DB_FOREIGN_KEY_CONSTRAINT'
    );
  });

  test('4. ACID transaction rollback leaves zero partial writes on failure', async (t) => {
    if (!pool) return t.skip(SKIP_REASON);

    const beforeProduct = await dbClient.queryOne(
      'SELECT `id`, `stock_on_hand` FROM `products` WHERE `sku` = ?',
      ['MRT-RICE-05']
    );

    await assert.rejects(
      () =>
        withTransaction(
          async (tx) => {
            await tx.execute(
              `INSERT INTO \`orders\`
                (\`invoice_no\`, \`customer_name\`, \`customer_phone\`, \`shipping_address\`, \`total_paisa\`)
               VALUES (?, ?, ?, ?, ?)`,
              ['MRT-ROLLBACK-001', 'Rollback Buyer', '01900000000', 'Uttara, Dhaka', 42000]
            );
            await adjustProductStockAtomically(
              {
                productId: beforeProduct.id,
                stockPool: 'warehouse',
                movementType: 'order_reserve',
                qtyDelta: -3,
                reason: 'Should roll back',
                existingTx: tx,
              },
              pool
            );
            throw new Error('Simulated payment gateway failure mid-transaction');
          },
          { pool }
        ),
      /Database error|Simulated/
    );

    const rolledBackOrder = await dbClient.queryOne(
      'SELECT `id` FROM `orders` WHERE `invoice_no` = ?',
      ['MRT-ROLLBACK-001']
    );
    assert.equal(rolledBackOrder, null, 'Order row must roll back completely');

    const afterProduct = await dbClient.queryOne(
      'SELECT `stock_on_hand` FROM `products` WHERE `id` = ?',
      [beforeProduct.id]
    );
    assert.equal(
      Number(afterProduct.stock_on_hand),
      Number(beforeProduct.stock_on_hand),
      'Warehouse stock deduction must roll back completely'
    );
  });

  test('5. Duplicate-sensitive idempotency & concurrent FOR UPDATE warehouse/vendor stock locking', async (t) => {
    if (!pool) return t.skip(SKIP_REASON);

    // A) Idempotency: side-effect executes strictly once; replay returns cached result; mismatched payload fails 409
    let sideEffectRuns = 0;
    const first = await executeIdempotent(
      {
        scope: 'checkout.create',
        idempotencyKey: 'idem-order-key-001',
        payload: { phone: '01711000000', items: [{ sku: 'MRT-RICE-05', qty: 1 }] },
        workFn: async () => {
          sideEffectRuns += 1;
          return { statusCode: 201, response: { invoiceNo: 'MRT-IDEM-0001', totalPaisa: 48000 } };
        },
      },
      pool
    );
    assert.equal(first.replayed, false);
    assert.equal(first.statusCode, 201);
    assert.equal(sideEffectRuns, 1);

    const replay = await executeIdempotent(
      {
        scope: 'checkout.create',
        idempotencyKey: 'idem-order-key-001',
        payload: { phone: '01711000000', items: [{ sku: 'MRT-RICE-05', qty: 1 }] },
        workFn: async () => {
          sideEffectRuns += 1;
          return { statusCode: 201, response: { invoiceNo: 'SHOULD-NOT-RUN' } };
        },
      },
      pool
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.response.invoiceNo, 'MRT-IDEM-0001');
    assert.equal(sideEffectRuns, 1, 'Side effect must never run twice for replayed idempotency key');

    await assert.rejects(
      () =>
        executeIdempotent(
          {
            scope: 'checkout.create',
            idempotencyKey: 'idem-order-key-001',
            payload: { phone: '01711000000', items: [{ sku: 'MRT-RICE-05', qty: 99 }] },
            workFn: async () => ({ statusCode: 201, response: {} }),
          },
          pool
        ),
      (err) => err.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH' && err.statusCode === 409
    );

    // B) Concurrent FOR UPDATE stock locking: stock_on_hand = 5, two parallel deductions of -4
    const prod = await dbClient.queryOne(
      'SELECT `id` FROM `products` WHERE `sku` = ?',
      ['MRT-RICE-05']
    );
    await dbClient.execute(
      'UPDATE `products` SET `stock_on_hand` = 5, `vendor_stock_on_hand` = 7 WHERE `id` = ?',
      [prod.id]
    );

    const results = await Promise.allSettled([
      adjustProductStockAtomically(
        {
          productId: prod.id,
          stockPool: 'warehouse',
          movementType: 'sale',
          qtyDelta: -4,
          reason: 'Concurrent checkout A',
        },
        pool
      ),
      adjustProductStockAtomically(
        {
          productId: prod.id,
          stockPool: 'warehouse',
          movementType: 'sale',
          qtyDelta: -4,
          reason: 'Concurrent checkout B',
        },
        pool
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'Exactly one concurrent -4 deduction may succeed from 5 stock');
    assert.equal(rejected.length, 1, 'Second concurrent -4 deduction must fail with INSUFFICIENT_STOCK');
    assert.equal(rejected[0].reason.code, 'INSUFFICIENT_STOCK');

    // Verify separate vendor stock was untouched (7) while warehouse stock is exact (1)
    const finalProd = await dbClient.queryOne(
      'SELECT `stock_on_hand`, `vendor_stock_on_hand` FROM `products` WHERE `id` = ?',
      [prod.id]
    );
    assert.equal(Number(finalProd.stock_on_hand), 1);
    assert.equal(
      Number(finalProd.vendor_stock_on_hand),
      7,
      'Vendor stock pool must remain strictly separate from warehouse stock pool'
    );
  });
});
