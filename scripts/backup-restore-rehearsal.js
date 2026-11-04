#!/usr/bin/env node
'use strict';

/**
 * Destructive, disposable-database-only logical backup/restore drill.
 * This restores INTO the same database and relies on mysqldump's DROP TABLE statements.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');

const REQUIRED_ACK = 'YES_I_AM_USING_A_DISPOSABLE_DATABASE';
const ESSENTIAL_TABLES = ['schema_migrations', 'users', 'customers', 'products', 'orders', 'audit_logs'];

function validateTarget(env = process.env) {
  if (env.BACKUP_RESTORE_REHEARSAL !== REQUIRED_ACK) {
    throw new Error(`Refusing backup/restore rehearsal: set BACKUP_RESTORE_REHEARSAL=${REQUIRED_ACK} only for a disposable database.`);
  }
  const dbName = String(env.DB_NAME || env.MYSQL_TEST_DB || '');
  if (!/^(mrtumi_test|mrtumi_backup_test|test_[A-Za-z0-9_]+)$/.test(dbName)) {
    throw new Error('Refusing backup/restore rehearsal: database name must exactly match an approved disposable test-name pattern.');
  }
  for (const key of ['DB_HOST', 'DB_USER']) {
    if (!String(env[key] || '').trim()) throw new Error(`Missing ${key}; no values are printed by this script.`);
  }
  return { dbName, host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD || '' };
}

function run(binary, args, { env, input } = {}) {
  const result = spawnSync(binary, args, {
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw new Error(`${binary} is unavailable: ${result.error.message}`);
  if (result.status !== 0) {
    const details = String(result.stderr || '').replace(/password\s*=\s*\S+/ig, 'password=[REDACTED]').trim();
    throw new Error(`${binary} failed with exit code ${result.status}: ${details.slice(0, 1200)}`);
  }
  return result.stdout || '';
}

async function snapshotDatabase(connection) {
  const [tables] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
  );
  const names = tables.map(row => row.TABLE_NAME);
  const missing = ESSENTIAL_TABLES.filter(name => !names.includes(name));
  if (missing.length) throw new Error(`Essential application tables missing; schema may not be fully migrated (${missing.join(', ')}).`);

  const hash = crypto.createHash('sha256');
  const counts = {};
  const quoteIdentifier = name => '`' + String(name).replace(/`/g, '``') + '`';
  for (const table of names) {
    const quoted = quoteIdentifier(table);
    const [columns] = await connection.query(`SHOW COLUMNS FROM ${quoted}`);
    const colNames = columns.map(column => column.Field);
    const [pkRows] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
      [table]
    );
    const order = pkRows.length ? pkRows.map(row => quoteIdentifier(row.COLUMN_NAME)).join(',') : colNames.map(quoteIdentifier).join(',');
    const [rows] = await connection.query(`SELECT * FROM ${quoted} ORDER BY ${order}`);
    counts[table] = rows.length;
    for (const row of rows) {
      const normalized = {};
      for (const column of colNames) {
        const value = row[column];
        normalized[column] = Buffer.isBuffer(value) ? { bufferBase64: value.toString('base64') } : value;
      }
      hash.update(JSON.stringify(normalized));
      hash.update('\n');
    }
  }

  const [columnMetadata] = await connection.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  const [indexMetadata] = await connection.query(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
  );
  const [constraints] = await connection.query(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
     FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, CONSTRAINT_NAME`
  );
  const [triggers] = await connection.query(
    `SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING, ACTION_STATEMENT
     FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME`
  );
  const [views] = await connection.query(
    `SELECT TABLE_NAME, VIEW_DEFINITION, CHECK_OPTION, IS_UPDATABLE
     FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
  );
  return {
    tableNames: names,
    counts,
    rowHash: hash.digest('hex'),
    schemaHash: crypto.createHash('sha256').update(JSON.stringify({ columnMetadata, indexMetadata, constraints, triggers, views })).digest('hex')
  };
}

function sameSnapshot(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

async function rehearse(env = process.env) {
  const target = validateTarget(env);
  const passwordEnv = { ...process.env, MYSQL_PWD: target.password };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrtumi-db-drill-'));
  const dumpPath = path.join(tmpDir, 'database.sql');
  let connection;
  try {
    connection = await mysql.createConnection({ host: target.host, port: target.port, user: target.user, password: target.password, database: target.dbName, connectTimeout: 5000 });
    const [serverRows] = await connection.query('SELECT VERSION() AS version, @@version_comment AS version_comment');
    const serverInfo = serverRows[0];
    const before = await snapshotDatabase(connection);
    await connection.end();
    connection = null;

    const dumpVersion = run('mysqldump', ['--version'], { env: passwordEnv });
    const dumpArgs = [
      '--host', target.host, '--port', String(target.port), '--user', target.user,
      '--single-transaction', '--quick', '--skip-lock-tables', '--add-drop-table', '--hex-blob',
      '--routines', '--triggers', '--events', '--default-character-set=utf8mb4', target.dbName
    ];
    // MySQL-only option; MariaDB's compatible client does not recognize it.
    if (/\bMySQL\b/i.test(dumpVersion) && !/MariaDB/i.test(dumpVersion)) dumpArgs.splice(-1, 0, '--set-gtid-purged=OFF');
    const dump = run('mysqldump', dumpArgs, { env: passwordEnv });
    if (!dump.trim()) throw new Error('Backup artifact is empty.');
    fs.writeFileSync(dumpPath, dump, { mode: 0o600 });
    const backupHash = crypto.createHash('sha256').update(fs.readFileSync(dumpPath)).digest('hex');

    // Guarded import to the exact same disposable schema; the dump uses DROP TABLE IF EXISTS.
    run('mysql', ['--host', target.host, '--port', String(target.port), '--user', target.user, '--default-character-set=utf8mb4', target.dbName], {
      env: passwordEnv,
      input: fs.readFileSync(dumpPath)
    });

    connection = await mysql.createConnection({ host: target.host, port: target.port, user: target.user, password: target.password, database: target.dbName, connectTimeout: 5000 });
    const after = await snapshotDatabase(connection);
    if (!sameSnapshot(before, after)) throw new Error('Restore verification failed: schema, table list/counts, or row-content hash differs from the pre-backup state.');
    const [integrityRows] = await connection.query('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\'');
    const nonInnoDb = integrityRows.filter(row => row.ENGINE !== 'InnoDB');
    if (nonInnoDb.length) throw new Error(`Restore integrity check found non-InnoDB tables: ${nonInnoDb.map(row => row.TABLE_NAME).join(', ')}`);
    console.log(JSON.stringify({ result: 'PASS', server: serverInfo.version, serverComment: serverInfo.version_comment, database: target.dbName, tables: before.tableNames.length, essentialTables: ESSENTIAL_TABLES, rowContentSha256: before.rowHash, schemaSha256: before.schemaHash, backupSha256: backupHash, dumpClient: dumpVersion.trim() }, null, 2));
  } finally {
    if (connection) await connection.end().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  rehearse().catch(error => {
    console.error(`[BACKUP/RESTORE REHEARSAL FAILED] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { REQUIRED_ACK, ESSENTIAL_TABLES, validateTarget, snapshotDatabase, sameSnapshot, rehearse };
