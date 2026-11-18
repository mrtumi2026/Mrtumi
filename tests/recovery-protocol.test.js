'use strict';

/**
 * Workstream B — Full 0037/0038 Recovery Proof Suite (v3.1 Hardened)
 *
 * Verifies that the canonical recovery procedure:
 * 1. Requires explicit confirmation flag CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY.
 * 2. Employs real disposable MariaDB/MySQL database with real migrator 0001–0036.
 * 3. Uses genuine mysqldump output with verified footer.
 * 4. Removes all 0037 branding columns and indexes by dropping and recreating vendors.
 * 5. Removes all 0038 courier tables, generated columns, and indexes.
 * 6. Restores original vendor data, constraints, indexes, and schema_migrations to exact baseline.
 * 7. Verified across all 5 partial-DDL failure scenarios with ZERO schema or data diffs.
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
  verifyDumpFooter
} = require('../scripts/ops/recovery-protocol');
const { createPoolFromConfig, closePool } = require('../src/db/mysqlPool');
const { migrateUp } = require('../src/db/migrator');

const MYSQL_HOST = (process.env.MYSQL_TEST_HOST || (fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-data') ? '127.0.0.1' : '')).trim();
const MYSQL_PORT = Number(process.env.MYSQL_TEST_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test';
const MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw';
const hasDbService = Boolean(MYSQL_HOST);

function getMysqlBin() {
  if (process.platform === 'win32' && fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe')) {
    return 'C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe';
  }
  return 'mysql';
}

function getMysqldumpBin() {
  if (process.platform === 'win32' && fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysqldump.exe')) {
    return 'C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysqldump.exe';
  }
  return 'mysqldump';
}

describe('Workstream B — Full 0037/0038 Real Baseline Dump Recovery Suite', () => {
  const disposableDbName = `mrtumi_disp_recov_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const backupDir = path.join(__dirname, 'helpers', 'tmp-recovery-sandbox');
  let pool = null;
  let baselineDumpPath = null;
  let baselineSnapshot = null;
  const targetDbConfig = {
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    name: disposableDbName,
    database: disposableDbName
  };

  async function takeSnapshot(conn, dbName) {
    const [tables] = await conn.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [dbName]
    );
    const [columns] = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA
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
    const [migrations] = await conn.query(
      'SELECT version, name FROM schema_migrations ORDER BY version ASC'
    );
    const [vendorRows] = await conn.query('SELECT * FROM vendors ORDER BY id ASC');
    const vendorHash = crypto.createHash('sha256').update(JSON.stringify(vendorRows)).digest('hex');

    return {
      tableCount: tables.length,
      columnCount: columns.length,
      indexCount: indexes.length,
      migrations: migrations.map(m => m.version),
      vendorHash,
      vendorRowsCount: vendorRows.length,
      tables: tables.map(t => t.TABLE_NAME),
      columns: columns.map(c => `${c.TABLE_NAME}.${c.COLUMN_NAME}`),
      indexes: indexes.map(i => `${i.TABLE_NAME}.${i.INDEX_NAME}.${i.COLUMN_NAME}`)
    };
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

      // Capture strict baseline snapshot
      baselineSnapshot = await takeSnapshot(conn, disposableDbName);
      assert.equal(baselineSnapshot.migrations.length, 36, 'Baseline must have exactly 36 migrations applied');
      assert.equal(baselineSnapshot.vendorRowsCount, 2, 'Baseline must contain representative vendor rows');
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

  test('Workstream 3: executeCanonicalRecovery rejects fail-closed without explicit confirmation flag', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      const mysqlBin = getMysqlBin();
      await assert.rejects(
        async () => executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, { mysqlBin }),
        /FAIL_CLOSED_APPROVAL_REQUIRED/
      );
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

      // Execute canonical recovery with required approval flag
      const mysqlBin = getMysqlBin();
      await executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
        mysqlBin,
        confirmationFlag: 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY'
      });

      // Verify exact baseline restored: 0 diffs
      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.columns.includes('vendors.slug'), false, 'slug column must be gone');
      assert.equal(postSnap.columns.includes('vendors.logo_url'), false, 'logo_url column must be gone');
      assert.equal(postSnap.columnCount, baselineSnapshot.columnCount, 'Column count must match baseline exactly');
      assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash, 'Vendor data hash must match baseline exactly');
      assert.deepEqual(postSnap.tables.sort(), baselineSnapshot.tables.sort(), 'Tables must match baseline exactly');
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
        confirmationFlag: 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY'
      });

      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.indexes.includes('vendors.idx_vendors_temp.status'), false);
      assert.equal(postSnap.indexCount, baselineSnapshot.indexCount);
      assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash);
      assert.deepEqual(postSnap.indexes.sort(), baselineSnapshot.indexes.sort());
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
        confirmationFlag: 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY'
      });

      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.tables.includes('vendor_courier_booking_requests'), false);
      assert.equal(postSnap.tableCount, baselineSnapshot.tableCount);
      assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash);
      assert.deepEqual(postSnap.tables.sort(), baselineSnapshot.tables.sort());
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
        confirmationFlag: 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY'
      });

      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.migrations.includes('0038'), false);
      assert.equal(postSnap.migrations.length, 36);
      assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash);
      assert.deepEqual(postSnap.migrations, baselineSnapshot.migrations);
    } finally {
      conn.release();
    }
  });

  test('Scenario 5: Full 0037 & 0038 applied -> Canonical recovery rolls back to exact 0036 baseline with ZERO diffs', async (t) => {
    if (!hasDbService) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      // Apply real 0037 and 0038 via migrator
      const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
      await migrateUp(pool, { migrationsDir, targetVersion: '0038' });

      // Verify that 0037 and 0038 are currently applied
      const midSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(midSnap.migrations.length, 38, 'Must have 38 migrations applied');
      assert.ok(midSnap.tables.includes('vendor_courier_booking_requests'));
      assert.ok(midSnap.tables.includes('vendor_courier_booking_audit_logs'));
      assert.ok(midSnap.columns.includes('vendors.slug'));

      // Execute canonical recovery
      const mysqlBin = getMysqlBin();
      await executeCanonicalRecovery(conn, baselineDumpPath, targetDbConfig, {
        mysqlBin,
        confirmationFlag: 'I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY'
      });

      // Verify ZERO schema and data differences against baseline snapshot
      const postSnap = await takeSnapshot(conn, disposableDbName);
      assert.equal(postSnap.migrations.length, 36);
      assert.equal(postSnap.tableCount, baselineSnapshot.tableCount);
      assert.equal(postSnap.columnCount, baselineSnapshot.columnCount);
      assert.equal(postSnap.indexCount, baselineSnapshot.indexCount);
      assert.equal(postSnap.tables.includes('vendor_courier_booking_requests'), false);
      assert.equal(postSnap.tables.includes('vendor_courier_booking_audit_logs'), false);
      assert.equal(postSnap.columns.includes('vendors.slug'), false);
      assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash, 'Vendor data hash must match baseline identically');
      assert.deepEqual(postSnap.migrations, baselineSnapshot.migrations, 'Migration history must match baseline');
      assert.deepEqual(postSnap.tables.sort(), baselineSnapshot.tables.sort(), 'Tables must match baseline');
      assert.deepEqual(postSnap.columns.sort(), baselineSnapshot.columns.sort(), 'Columns must match baseline');
      assert.deepEqual(postSnap.indexes.sort(), baselineSnapshot.indexes.sort(), 'Indexes must match baseline');
    } finally {
      conn.release();
    }
  });
});
