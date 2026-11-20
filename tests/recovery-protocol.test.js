'use strict';

/**
 * Workstream B — Full 0037/0038 Recovery Proof Suite (v3.2 Hardened)
 *
 * Verifies that the canonical recovery procedure:
 * 1. Requires explicit confirmation token scoped to manifest run_id (prevents ambient .env inheritance).
 * 2. Enforces restore rehearsal prerequisite (database_restore_rehearsed: true).
 * 3. Employs real disposable MariaDB/MySQL database with real migrator 0001–0036.
 * 4. Uses genuine mysqldump output with verified footer and cryptographic manifest.
 * 5. Removes all 0037 branding columns and indexes by dropping and recreating vendors.
 * 6. Removes all 0038 courier tables, generated columns, and indexes.
 * 7. Restores original vendor data, constraints, indexes, triggers, foreign keys, and schema_migrations to exact baseline.
 * 8. Verified across all 5 partial-DDL failure scenarios with ZERO schema or data diffs across all structures:
 *    - tables
 *    - columns (including GENERATION_EXPRESSION)
 *    - indexes
 *    - foreign keys (KEY_COLUMN_USAGE)
 *    - referential constraints (REFERENTIAL_CONSTRAINTS)
 *    - check constraints (TABLE_CONSTRAINTS)
 *    - triggers (TRIGGERS)
 *    - views (VIEWS)
 *    - routines (ROUTINES)
 *    - migration records (schema_migrations)
 *    - vendor data rows and SHA-256 hash
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const {
  executeCanonicalRecovery,
  verifyDumpFooter,
  createHardenedManifest,
  updateManifestState
} = require('../scripts/ops/recovery-protocol');
const { createPoolFromConfig, closePool } = require('../src/db/mysqlPool');
const { migrateUp } = require('../src/db/migrator');

const MYSQL_HOST = (process.env.MYSQL_TEST_HOST || '127.0.0.1').trim();
const MYSQL_PORT = Number(process.env.MYSQL_TEST_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test';
const MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw';
const hasDbService = Boolean(process.env.MYSQL_TEST_HOST || process.env.MYSQL_HOST || process.env.CI);

function getMysqlBin() {
  if (process.env.MYSQL_BIN && fs.existsSync(process.env.MYSQL_BIN)) {
    return process.env.MYSQL_BIN;
  }
  return 'mysql';
}

function getMysqldumpBin() {
  if (process.env.MYSQLDUMP_BIN && fs.existsSync(process.env.MYSQLDUMP_BIN)) {
    return process.env.MYSQLDUMP_BIN;
  }
  return 'mysqldump';
}

describe('Workstream B — Full 0037/0038 Real Baseline Dump Recovery Suite (v3.2 Hardened)', () => {
  const disposableDbName = `mrtumi_disp_recov_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const backupDir = path.join(__dirname, 'helpers', 'tmp-recovery-sandbox');
  let pool = null;
  let baselineDumpPath = null;
  let baselineManifestPath = null;
  let baselineRunId = null;
  let baselineSnapshot = null;
  const targetDbConfig = {
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    name: disposableDbName,
    database: disposableDbName
  };

  /**
   * Comprehensive Schema & Data Snapshot:
   * Inspects tables, columns, indexes, foreign keys, referential actions, check constraints,
   * triggers, views, routines, migrations, and vendor data.
   */
  async function takeSnapshot(conn, dbName) {
    const [tables] = await conn.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [dbName]
    );

    const [columns] = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA, COALESCE(GENERATION_EXPRESSION, '') AS GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [dbName]
    );

    const [indexes] = await conn.query(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [dbName]
    );

    const [foreignKeys] = await conn.query(
      `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, TABLE_NAME, ORDINAL_POSITION`,
      [dbName]
    );

    const [referentialConstraints] = await conn.query(
      `SELECT CONSTRAINT_NAME, TABLE_NAME, UPDATE_RULE, DELETE_RULE
       FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ?
       ORDER BY CONSTRAINT_NAME`,
      [dbName]
    );

    const [checkConstraints] = await conn.query(
      `SELECT CONSTRAINT_NAME, TABLE_NAME
       FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'CHECK'
       ORDER BY CONSTRAINT_NAME`,
      [dbName]
    );

    const [triggers] = await conn.query(
      `SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING, ACTION_STATEMENT
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ?
       ORDER BY TRIGGER_NAME`,
      [dbName]
    );

    const [views] = await conn.query(
      `SELECT TABLE_NAME, VIEW_DEFINITION
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [dbName]
    );

    const [routines] = await conn.query(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
       ORDER BY ROUTINE_NAME`,
      [dbName]
    );

    const [migrations] = await conn.query(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC'
    );

    const [vendorRows] = await conn.query('SELECT * FROM vendors ORDER BY id ASC');
    const vendorHash = crypto.createHash('sha256').update(JSON.stringify(vendorRows)).digest('hex');

    return {
      tableCount: tables.length,
      columnCount: columns.length,
      indexCount: indexes.length,
      foreignKeysCount: foreignKeys.length,
      referentialConstraintsCount: referentialConstraints.length,
      checkConstraintsCount: checkConstraints.length,
      triggersCount: triggers.length,
      viewsCount: views.length,
      routinesCount: routines.length,
      migrationsCount: migrations.length,
      vendorRowsCount: vendorRows.length,
      vendorHash,
      tables: tables.map(t => t.TABLE_NAME),
      columns: columns.map(c => `${c.TABLE_NAME}.${c.COLUMN_NAME}|${c.COLUMN_TYPE}|${c.IS_NULLABLE}|${c.EXTRA}|${c.GENERATION_EXPRESSION}`),
      indexes: indexes.map(i => `${i.TABLE_NAME}.${i.INDEX_NAME}.${i.COLUMN_NAME}.${i.NON_UNIQUE}`),
      foreignKeys: foreignKeys.map(fk => `${fk.CONSTRAINT_NAME}.${fk.TABLE_NAME}.${fk.COLUMN_NAME}->${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`),
      referentialConstraints: referentialConstraints.map(rc => `${rc.CONSTRAINT_NAME}.${rc.TABLE_NAME}.${rc.UPDATE_RULE}.${rc.DELETE_RULE}`),
      checkConstraints: checkConstraints.map(cc => `${cc.CONSTRAINT_NAME}.${cc.TABLE_NAME}`),
      triggers: triggers.map(tr => `${tr.TRIGGER_NAME}.${tr.EVENT_MANIPULATION}.${tr.EVENT_OBJECT_TABLE}.${tr.ACTION_TIMING}`),
      views: views.map(v => `${v.TABLE_NAME}.${v.VIEW_DEFINITION}`),
      routines: routines.map(r => `${r.ROUTINE_NAME}.${r.ROUTINE_TYPE}`),
      migrations: migrations.map(m => `${m.version}:${m.name}:${m.checksum}`)
    };
  }

  function assertExactBaselineMatch(postSnap, baselineSnapshot, scenarioName) {
    assert.equal(postSnap.tableCount, baselineSnapshot.tableCount, `${scenarioName}: tableCount mismatch`);
    assert.equal(postSnap.columnCount, baselineSnapshot.columnCount, `${scenarioName}: columnCount mismatch`);
    assert.equal(postSnap.indexCount, baselineSnapshot.indexCount, `${scenarioName}: indexCount mismatch`);
    assert.equal(postSnap.foreignKeysCount, baselineSnapshot.foreignKeysCount, `${scenarioName}: foreignKeysCount mismatch`);
    assert.equal(postSnap.referentialConstraintsCount, baselineSnapshot.referentialConstraintsCount, `${scenarioName}: referentialConstraintsCount mismatch`);
    assert.equal(postSnap.checkConstraintsCount, baselineSnapshot.checkConstraintsCount, `${scenarioName}: checkConstraintsCount mismatch`);
    assert.equal(postSnap.triggersCount, baselineSnapshot.triggersCount, `${scenarioName}: triggersCount mismatch`);
    assert.equal(postSnap.viewsCount, baselineSnapshot.viewsCount, `${scenarioName}: viewsCount mismatch`);
    assert.equal(postSnap.routinesCount, baselineSnapshot.routinesCount, `${scenarioName}: routinesCount mismatch`);
    assert.equal(postSnap.migrationsCount, baselineSnapshot.migrationsCount, `${scenarioName}: migrationsCount mismatch`);
    assert.equal(postSnap.vendorRowsCount, baselineSnapshot.vendorRowsCount, `${scenarioName}: vendorRowsCount mismatch`);
    assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash, `${scenarioName}: vendorHash mismatch`);

    assert.deepEqual(postSnap.tables.sort(), baselineSnapshot.tables.sort(), `${scenarioName}: tables deep diff`);
    assert.deepEqual(postSnap.columns.sort(), baselineSnapshot.columns.sort(), `${scenarioName}: columns deep diff`);
    assert.deepEqual(postSnap.indexes.sort(), baselineSnapshot.indexes.sort(), `${scenarioName}: indexes deep diff`);
    assert.deepEqual(postSnap.foreignKeys.sort(), baselineSnapshot.foreignKeys.sort(), `${scenarioName}: foreign keys deep diff`);
    assert.deepEqual(postSnap.referentialConstraints.sort(), baselineSnapshot.referentialConstraints.sort(), `${scenarioName}: referential constraints deep diff`);
    assert.deepEqual(postSnap.checkConstraints.sort(), baselineSnapshot.checkConstraints.sort(), `${scenarioName}: check constraints deep diff`);
    assert.deepEqual(postSnap.triggers.sort(), baselineSnapshot.triggers.sort(), `${scenarioName}: triggers deep diff`);
    assert.deepEqual(postSnap.views.sort(), baselineSnapshot.views.sort(), `${scenarioName}: views deep diff`);
    assert.deepEqual(postSnap.routines.sort(), baselineSnapshot.routines.sort(), `${scenarioName}: routines deep diff`);
    assert.deepEqual(postSnap.migrations, baselineSnapshot.migrations, `${scenarioName}: migrations deep diff`);
  }

  before(async () => {
    if (!hasDbService) return;
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });

    // 1. Create isolated disposable database
    const adminConn = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD
    });
    try {
      await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${disposableDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await adminConn.end();
    }

    // 2. Connect pool to the disposable database
    pool = createPoolFromConfig({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      name: disposableDbName,
      database: disposableDbName,
      charset: 'utf8mb4'
    });

    // 3. Run real migrations 0001–0036 via migrator
    const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
    await migrateUp(pool, { migrationsDir, targetVersion: '0036' });

    // 4. Insert representative production-like baseline records
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO `vendors` (`shop_name`,`owner_name`,`phone`,`email`,`password_hash`,`status`,`verified`) VALUES (?,?,?,?,?,1,1)',
        ['Apex Baseline Store', 'Mr. Apex', '01711000001', 'apex@example.com', 'bcrypt_hash_1']
      );
      await conn.query(
        'INSERT INTO `vendors` (`shop_name`,`owner_name`,`phone`,`email`,`password_hash`,`status`,`verified`) VALUES (?,?,?,?,?,1,1)',
        ['Bata Baseline Store', 'Mr. Bata', '01711000002', 'bata@example.com', 'bcrypt_hash_2']
      );

      // Capture strict comprehensive baseline snapshot
      baselineSnapshot = await takeSnapshot(conn, disposableDbName);
      assert.equal(baselineSnapshot.migrationsCount, 36, 'Baseline must have exactly 36 migrations applied');
      assert.equal(baselineSnapshot.vendorRowsCount, 2, 'Baseline must contain representative vendor rows');
      assert.ok(baselineSnapshot.foreignKeysCount > 0, 'Baseline must contain foreign keys');
      assert.ok(baselineSnapshot.triggersCount > 0, 'Baseline must contain audit triggers');
    } finally {
      conn.release();
    }

    // 5. Generate genuine mysqldump baseline
    baselineDumpPath = path.join(backupDir, 'real_baseline_0036.sql');
    const dumpRes = spawnSync(getMysqldumpBin(), [
      `-h${MYSQL_HOST}`,
      `-P${MYSQL_PORT}`,
      `-u${MYSQL_USER}`,
      `--password=${MYSQL_PASSWORD}`,
      '--single-transaction',
      '--quick',
      '--routines',
      '--triggers',
      disposableDbName
    ], { maxBuffer: 100 * 1024 * 1024, encoding: 'utf8' });

    if (dumpRes.status !== 0) {
      throw new Error(`mysqldump failed with status ${dumpRes.status}: ${dumpRes.stderr}`);
    }

    fs.writeFileSync(baselineDumpPath, dumpRes.stdout, { mode: 0o600 });
    assert.ok(fs.existsSync(baselineDumpPath), 'Dump file must exist');
    assert.equal(verifyDumpFooter(baselineDumpPath), true, 'Real mysqldump must contain valid completion footer');

    // 6. Generate cryptographic manifest and record rehearsal state
    const dummyUploads = path.join(backupDir, 'baseline_uploads.tar.gz');
    fs.writeFileSync(dummyUploads, 'DUMMY_UPLOADS_PAYLOAD');
    const manifestResult = await createHardenedManifest(backupDir, targetDbConfig, baselineDumpPath, dummyUploads, {
      pre_deploy_head: '1b3c9a1950c2e8de7b76efb0d86717b02f64f100',
      target_commit: '5285d82e7e233c50561222c419fc163d79d74c5d'
    });
    baselineManifestPath = manifestResult.manifestPath;
    baselineRunId = manifestResult.runId;

    // Mark database restore rehearsed for valid testing
    updateManifestState(baselineManifestPath, { database_restore_rehearsed: true });
  });

  after(async () => {
    if (pool) {
      await closePool(pool);
    }
    if (hasDbService) {
      // Drop isolated disposable database
      try {
        const adminConn = await mysql.createConnection({
          host: MYSQL_HOST,
          port: MYSQL_PORT,
          user: MYSQL_USER,
          password: MYSQL_PASSWORD
        });
        await adminConn.query(`DROP DATABASE IF EXISTS \`${disposableDbName}\``);
        await adminConn.end();
      } catch (_) {}
    }
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  });

  test('executeCanonicalRecovery: rejects fail-closed without confirmation token scoped to manifest run_id', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      const mysqlBin = getMysqlBin();

      // Ambient confirmation flag alone must be rejected
      process.env.CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY = 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY';
      await assert.rejects(
        async () => executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
          mysqlBin,
          manifestPath: baselineManifestPath
          // no confirmationToken and no targetRunId matching baselineRunId!
        }),
        /FAIL_CLOSED_APPROVAL_REQUIRED: Destructive database recovery requires explicit operator confirmation scoped to run_id/
      );
      delete process.env.CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY;

      // Wrong confirmation token must be rejected
      await assert.rejects(
        async () => executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
          mysqlBin,
          manifestPath: baselineManifestPath,
          confirmationToken: 'wrong-uuid-token'
        }),
        /FAIL_CLOSED_APPROVAL_REQUIRED/
      );
    } finally {
      conn.release();
    }
  });

  test('executeCanonicalRecovery: rejects unrehearsed backup unless explicit emergency justification provided', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      const mysqlBin = getMysqlBin();

      // Temporarily set database_restore_rehearsed: false
      updateManifestState(baselineManifestPath, { database_restore_rehearsed: false });

      await assert.rejects(
        async () => executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
          mysqlBin,
          manifestPath: baselineManifestPath,
          confirmationToken: baselineRunId
        }),
        /FAIL_CLOSED_REHEARSAL_REQUIRED/
      );

      // Restore rehearsed state
      updateManifestState(baselineManifestPath, { database_restore_rehearsed: true });
    } finally {
      conn.release();
    }
  });

  test('Scenario 1: Partial 0037 columns added -> Canonical recovery purges columns & restores baseline', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      // Simulate partial 0037
      await conn.query('ALTER TABLE vendors ADD COLUMN slug VARCHAR(191), ADD COLUMN logo_url VARCHAR(500)');
      await conn.query("UPDATE vendors SET slug = 'store-1' WHERE id = 1");

      // Verify dirty state
      const [dirtyCols] = await conn.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = "vendors"', [disposableDbName]);
      assert.ok(dirtyCols.some(c => c.COLUMN_NAME === 'slug'));

      // Execute canonical recovery with required scoped approval token
      const mysqlBin = getMysqlBin();
      await executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
        mysqlBin,
        manifestPath: baselineManifestPath,
        confirmationToken: baselineRunId
      });

      // Verify exact baseline restored across all schema structures
      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.columns.some(c => c.startsWith('vendors.slug|')), false, 'slug column must be gone');
      assert.equal(postSnap.columns.some(c => c.startsWith('vendors.logo_url|')), false, 'logo_url column must be gone');
      assertExactBaselineMatch(postSnap, baselineSnapshot, 'Scenario 1');
    } finally {
      conn.release();
    }
  });

  test('Scenario 2: Partial 0037 index failure -> Canonical recovery restores clean table', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE vendors ADD COLUMN slug VARCHAR(191)');
      await conn.query('ALTER TABLE vendors ADD KEY idx_vendors_temp (status)');

      const mysqlBin = getMysqlBin();
      await executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
        mysqlBin,
        manifestPath: baselineManifestPath,
        confirmationToken: baselineRunId
      });

      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.indexes.some(i => i.startsWith('vendors.idx_vendors_temp.')), false);
      assertExactBaselineMatch(postSnap, baselineSnapshot, 'Scenario 2');
    } finally {
      conn.release();
    }
  });

  test('Scenario 3: Partial 0038 table creation crash -> Canonical recovery removes table and virtual columns', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      await conn.query(`
        CREATE TABLE vendor_courier_booking_requests (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          sub_order_id BIGINT NOT NULL,
          status VARCHAR(30) NOT NULL DEFAULT 'pending',
          active_sub_order_id BIGINT GENERATED ALWAYS AS (
            CASE WHEN status IN ('pending', 'booking') THEN sub_order_id ELSE NULL END
          ) VIRTUAL
        ) ENGINE=InnoDB
      `);

      const mysqlBin = getMysqlBin();
      await executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
        mysqlBin,
        manifestPath: baselineManifestPath,
        confirmationToken: baselineRunId
      });

      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.tables.includes('vendor_courier_booking_requests'), false);
      assertExactBaselineMatch(postSnap, baselineSnapshot, 'Scenario 3');
    } finally {
      conn.release();
    }
  });

  test('Scenario 4: 0038 Generated column failure and corrupt migration record -> Restores clean 0036', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      await conn.query(`
        CREATE TABLE vendor_courier_booking_requests (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          sub_order_id BIGINT NOT NULL
        ) ENGINE=InnoDB
      `);
      await conn.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ('0038', 'broken_run', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')");

      const mysqlBin = getMysqlBin();
      await executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
        mysqlBin,
        manifestPath: baselineManifestPath,
        confirmationToken: baselineRunId
      });

      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.migrations.some(m => m.startsWith('0038:')), false);
      assertExactBaselineMatch(postSnap, baselineSnapshot, 'Scenario 4');
    } finally {
      conn.release();
    }
  });

  test('Scenario 5: Full 0037 & 0038 applied -> Canonical recovery rolls back to exact 0036 baseline with ZERO diffs across all structures', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      // Apply real 0037 and 0038 via migrator
      const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
      await migrateUp(pool, { migrationsDir, targetVersion: '0038' });

      // Verify that 0037 and 0038 are currently applied
      const midSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(midSnap.migrationsCount, 38, 'Must have 38 migrations applied');
      assert.ok(midSnap.tables.includes('vendor_courier_booking_requests'));
      assert.ok(midSnap.tables.includes('vendor_courier_booking_audit_logs'));

      // Execute canonical recovery
      const mysqlBin = getMysqlBin();
      await executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
        mysqlBin,
        manifestPath: baselineManifestPath,
        confirmationToken: baselineRunId
      });

      // Verify ZERO schema and data differences against baseline snapshot
      const postSnap = await takeSnapshot(conn, disposableDbName);
      assertExactBaselineMatch(postSnap, baselineSnapshot, 'Scenario 5');
    } finally {
      conn.release();
    }
  });
});
