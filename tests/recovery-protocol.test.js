'use strict';

/**
 * Workstream B — Full 0037/0038 Recovery Proof Suite
 *
 * Verifies that the canonical recovery procedure:
 * 1. Removes all 0037 branding columns and indexes by dropping and recreating vendors.
 * 2. Removes all 0038 courier tables, generated columns, and indexes.
 * 3. Restores original vendor data, constraints, indexes, and schema_migrations to exact baseline.
 * 4. Runs across all 5 partial-DDL failure scenarios.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  executeCanonicalRecovery,
  streamRestore
} = require('../scripts/ops/recovery-protocol');
const { createPoolFromConfig, closePool } = require('../src/db/mysqlPool');

// Check test database connection
const MYSQL_HOST = (process.env.MYSQL_TEST_HOST || (fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-data') ? '127.0.0.1' : '')).trim();
const testDbConfig = MYSQL_HOST
  ? {
      host: MYSQL_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      name: process.env.MYSQL_TEST_DB || 'mrtumi_backup_test',
      user: process.env.MYSQL_TEST_USER || 'mrtumi_test',
      password: process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw',
      charset: 'utf8mb4'
    }
  : null;

describe('Workstream B — Full 0037/0038 Recovery Proof Suite', () => {
  let pool = null;
  const backupDir = path.join(__dirname, 'helpers', 'tmp-recovery-sandbox');
  let baselineDumpPath = null;
  let baselineSnapshot = null;

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
    if (!testDbConfig) return;
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });

    pool = createPoolFromConfig(testDbConfig);

    // Setup pristine 0036 baseline table state
    const conn = await pool.getConnection();
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_audit_logs');
      await conn.query('DROP TABLE IF EXISTS vendor_courier_booking_requests');
      await conn.query('DROP TABLE IF EXISTS vendors');
      await conn.query('DROP TABLE IF EXISTS schema_migrations');
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');

      await conn.query(`
        CREATE TABLE vendors (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT UNSIGNED NOT NULL,
          shop_name VARCHAR(255) NOT NULL,
          phone VARCHAR(30) NOT NULL,
          status TINYINT NOT NULL DEFAULT 1,
          lifecycle_status VARCHAR(30) NOT NULL DEFAULT 'active',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
        INSERT INTO vendors (id, user_id, shop_name, phone, status, lifecycle_status, created_at) VALUES
        (1, 101, 'Baseline Vendor 1', '01711111111', 1, 'active', '2026-11-18 10:00:00'),
        (2, 102, 'Baseline Vendor 2', '01722222222', 1, 'active', '2026-11-18 10:00:00')
      `);

      await conn.query(`
        CREATE TABLE schema_migrations (
          version VARCHAR(64) NOT NULL PRIMARY KEY,
          name VARCHAR(191) NOT NULL,
          checksum CHAR(64) NOT NULL DEFAULT 'mock_checksum'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      for (let i = 1; i <= 36; i++) {
        const v = String(i).padStart(4, '0');
        await conn.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [v, `mig_${v}`]);
      }

      baselineSnapshot = await takeSnapshot(conn, testDbConfig.name);

      // Create SQL dump for testing
      baselineDumpPath = path.join(backupDir, 'baseline_0036.sql');
      const dumpSql = [
        '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
        'DROP TABLE IF EXISTS `vendors`;',
        'CREATE TABLE `vendors` (',
        '  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,',
        '  `user_id` bigint(20) unsigned NOT NULL,',
        '  `shop_name` varchar(255) NOT NULL,',
        '  `phone` varchar(30) NOT NULL,',
        '  `status` tinyint(4) NOT NULL DEFAULT 1,',
        '  `lifecycle_status` varchar(30) NOT NULL DEFAULT \'active\',',
        '  `created_at` datetime DEFAULT current_timestamp(),',
        '  PRIMARY KEY (`id`)',
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
        'INSERT INTO `vendors` VALUES (1,101,\'Baseline Vendor 1\',\'01711111111\',1,\'active\',\'2026-11-18 10:00:00\'),(2,102,\'Baseline Vendor 2\',\'01722222222\',1,\'active\',\'2026-11-18 10:00:00\');',
        'DROP TABLE IF EXISTS `schema_migrations`;',
        'CREATE TABLE `schema_migrations` (',
        '  `version` varchar(64) NOT NULL,',
        '  `name` varchar(191) NOT NULL,',
        '  `checksum` char(64) NOT NULL DEFAULT \'mock_checksum\',',
        '  PRIMARY KEY (`version`)',
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
        ...Array.from({ length: 36 }, (_, i) => {
          const v = String(i + 1).padStart(4, '0');
          return `INSERT INTO \`schema_migrations\` VALUES ('${v}','mig_${v}','mock_checksum');`;
        }),
        '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
        '-- Dump completed'
      ].join('\n');

      fs.writeFileSync(baselineDumpPath, dumpSql, { mode: 0o600 });
    } finally {
      conn.release();
    }
  });

  after(async () => {
    if (pool) await closePool(pool);
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  });

  test('Scenario 1: Partial 0037 columns added -> Canonical recovery purges columns & restores baseline', async (t) => {
    if (!testDbConfig) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      // Simulate partial 0037
      await conn.query('ALTER TABLE vendors ADD COLUMN slug VARCHAR(191), ADD COLUMN logo_url VARCHAR(500)');
      await conn.query("UPDATE vendors SET slug = 'store-1' WHERE id = 1");

      // Verify dirty state
      const [dirtyCols] = await conn.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = "vendors"', [testDbConfig.name]);
      assert.ok(dirtyCols.some(c => c.COLUMN_NAME === 'slug'));

      // Execute canonical recovery
      const targetDb = { host: testDbConfig.host, port: testDbConfig.port, user: testDbConfig.user, password: testDbConfig.password, database: testDbConfig.name };
      const mysqlBin = process.platform === 'win32' && fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe')
        ? 'C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe'
        : 'mysql';

      await executeCanonicalRecovery(conn, baselineDumpPath, targetDb, { mysqlBin });

      // Verify exact baseline restored
      const postSnap = await takeSnapshot(conn, testDbConfig.name);
      assert.equal(postSnap.columns.includes('vendors.slug'), false, 'slug column must be gone');
      assert.equal(postSnap.columns.includes('vendors.logo_url'), false, 'logo_url column must be gone');
      assert.equal(postSnap.columnCount, baselineSnapshot.columnCount);
      assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash);
    } finally {
      conn.release();
    }
  });

  test('Scenario 2: Partial 0037 index failure -> Canonical recovery restores clean table', async (t) => {
    if (!testDbConfig) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      await conn.query('ALTER TABLE vendors ADD COLUMN slug VARCHAR(191)');
      await conn.query('ALTER TABLE vendors ADD KEY idx_vendors_temp (status)');

      const targetDb = { host: testDbConfig.host, port: testDbConfig.port, user: testDbConfig.user, password: testDbConfig.password, database: testDbConfig.name };
      const mysqlBin = process.platform === 'win32' && fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe')
        ? 'C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe'
        : 'mysql';

      await executeCanonicalRecovery(conn, baselineDumpPath, targetDb, { mysqlBin });

      const postSnap = await takeSnapshot(conn, testDbConfig.name);
      assert.equal(postSnap.indexes.includes('vendors.idx_vendors_temp.status'), false);
      assert.equal(postSnap.indexCount, baselineSnapshot.indexCount);
    } finally {
      conn.release();
    }
  });

  test('Scenario 3: Partial 0038 table creation crash -> Canonical recovery removes table and virtual columns', async (t) => {
    if (!testDbConfig) return t.skip('No disposable MariaDB/MySQL service detected');

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

      const targetDb = { host: testDbConfig.host, port: testDbConfig.port, user: testDbConfig.user, password: testDbConfig.password, database: testDbConfig.name };
      const mysqlBin = process.platform === 'win32' && fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe')
        ? 'C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe'
        : 'mysql';

      await executeCanonicalRecovery(conn, baselineDumpPath, targetDb, { mysqlBin });

      const postSnap = await takeSnapshot(conn, testDbConfig.name);
      assert.equal(postSnap.tables.includes('vendor_courier_booking_requests'), false);
      assert.equal(postSnap.tableCount, baselineSnapshot.tableCount);
    } finally {
      conn.release();
    }
  });

  test('Scenario 4: 0038 Generated column failure and corrupt migration record -> Restores clean 0036', async (t) => {
    if (!testDbConfig) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      await conn.query(`
        CREATE TABLE vendor_courier_booking_requests (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          sub_order_id BIGINT NOT NULL
        ) ENGINE=InnoDB
      `);
      await conn.query("INSERT INTO schema_migrations (version, name) VALUES ('0038', 'broken_run')");

      const targetDb = { host: testDbConfig.host, port: testDbConfig.port, user: testDbConfig.user, password: testDbConfig.password, database: testDbConfig.name };
      const mysqlBin = process.platform === 'win32' && fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe')
        ? 'C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe'
        : 'mysql';

      await executeCanonicalRecovery(conn, baselineDumpPath, targetDb, { mysqlBin });

      const postSnap = await takeSnapshot(conn, testDbConfig.name);
      assert.equal(postSnap.migrations.includes('0038'), false);
      assert.equal(postSnap.migrations.length, 36);
    } finally {
      conn.release();
    }
  });

  test('Scenario 5: Full 0037 & 0038 applied -> Canonical recovery rolls back to exact 0036 baseline', async (t) => {
    if (!testDbConfig) return t.skip('No disposable MariaDB/MySQL service detected');

    const conn = await pool.getConnection();
    try {
      // Apply 0037
      await conn.query('ALTER TABLE vendors ADD COLUMN slug VARCHAR(191), ADD COLUMN store_status TINYINT DEFAULT 1');
      await conn.query("UPDATE vendors SET slug = CONCAT('store-', id)");
      await conn.query("INSERT INTO schema_migrations (version, name) VALUES ('0037', 'vendor_store_branding')");

      // Apply 0038
      await conn.query('CREATE TABLE vendor_courier_booking_requests (id BIGINT AUTO_INCREMENT PRIMARY KEY, sub_order_id BIGINT NOT NULL) ENGINE=InnoDB');
      await conn.query('CREATE TABLE vendor_courier_booking_audit_logs (id BIGINT AUTO_INCREMENT PRIMARY KEY, action VARCHAR(50) NOT NULL) ENGINE=InnoDB');
      await conn.query("INSERT INTO schema_migrations (version, name) VALUES ('0038', 'vendor_courier_booking_requests')");

      const targetDb = { host: testDbConfig.host, port: testDbConfig.port, user: testDbConfig.user, password: testDbConfig.password, database: testDbConfig.name };
      const mysqlBin = process.platform === 'win32' && fs.existsSync('C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe')
        ? 'C:/Users/Bappi/.gemini/antigravity/scratch/mariadb-10.11/mariadb-10.11.10-winx64/bin/mysql.exe'
        : 'mysql';

      await executeCanonicalRecovery(conn, baselineDumpPath, targetDb, { mysqlBin });

      const postSnap = await takeSnapshot(conn, testDbConfig.name);
      assert.equal(postSnap.migrations.length, 36);
      assert.equal(postSnap.tables.includes('vendor_courier_booking_requests'), false);
      assert.equal(postSnap.tables.includes('vendor_courier_booking_audit_logs'), false);
      assert.equal(postSnap.columns.includes('vendors.slug'), false);
      assert.equal(postSnap.vendorHash, baselineSnapshot.vendorHash);
    } finally {
      conn.release();
    }
  });
});
