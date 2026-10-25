'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK_NAME = 'mrtumi_schema_migration';

class MigrationError extends AppError {
  constructor(code, message, details = null) {
    super(code, message, 500, details);
  }
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Quote- and comment-aware SQL statement splitter so `.up.sql` and `.down.sql`
 * files execute statement-by-statement without needing `multipleStatements: true`.
 */
function splitSqlStatements(sqlText) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i];
    const next = sqlText[i + 1] || '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        current += '\n';
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '-' && next === '-' && /\s/.test(sqlText[i + 2] || ' ')) {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (ch === "'" && !inDouble && !inBacktick) {
      if (inSingle && next === "'") {
        current += "''";
        i++;
        continue;
      }
      const prev = sqlText[i - 1] || '';
      if (prev !== '\\') inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle && !inBacktick) {
      const prev = sqlText[i - 1] || '';
      if (prev !== '\\') inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }

    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}

/**
 * Discovers paired `<version>_<name>.up.sql` and `<version>_<name>.down.sql` files.
 */
function loadMigrationPairs(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) {
    throw new MigrationError(
      'MIGRATIONS_DIR_NOT_FOUND',
      `Migrations directory not found: ${migrationsDir}`
    );
  }

  const entries = fs.readdirSync(migrationsDir).sort();
  const upFiles = entries.filter((f) => f.endsWith('.up.sql'));
  const pairs = [];
  const seenVersions = new Set();

  for (const upFile of upFiles) {
    const match = upFile.match(/^(\d{4})_([a-z0-9_]+)\.up\.sql$/);
    if (!match) {
      throw new MigrationError(
        'INVALID_MIGRATION_FILENAME',
        `Invalid migration filename "${upFile}". Expected "<4-digit-version>_<snake_case_name>.up.sql".`
      );
    }

    const [, version, name] = match;
    if (seenVersions.has(version)) {
      throw new MigrationError(
        'DUPLICATE_MIGRATION_VERSION',
        `Duplicate migration version "${version}" detected.`
      );
    }
    seenVersions.add(version);

    const downFile = `${version}_${name}.down.sql`;
    const upPath = path.join(migrationsDir, upFile);
    const downPath = path.join(migrationsDir, downFile);

    if (!fs.existsSync(downPath)) {
      throw new MigrationError(
        'MISSING_DOWN_MIGRATION',
        `Missing paired rollback file "${downFile}" for "${upFile}".`
      );
    }

    const upSql = fs.readFileSync(upPath, 'utf8');
    const downSql = fs.readFileSync(downPath, 'utf8');

    pairs.push({
      version,
      name,
      upFile,
      downFile,
      upSql,
      downSql,
      checksum: sha256Hex(upSql),
    });
  }

  return pairs.sort((a, b) => a.version.localeCompare(b.version));
}

async function ensureSchemaMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
      \`version\` VARCHAR(64) NOT NULL,
      \`name\` VARCHAR(191) NOT NULL,
      \`checksum\` CHAR(64) NOT NULL,
      \`execution_ms\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`applied_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`version\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function acquireAdvisoryLock(conn, lockTimeoutSec = 15) {
  const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS locked', [
    MIGRATION_LOCK_NAME,
    lockTimeoutSec,
  ]);
  const locked = rows && rows[0] ? Number(rows[0].locked) : 0;
  if (locked !== 1) {
    throw new MigrationError(
      'MIGRATION_LOCK_BUSY',
      `Could not acquire MySQL migration advisory lock "${MIGRATION_LOCK_NAME}" within ${lockTimeoutSec}s.`
    );
  }
}

async function releaseAdvisoryLock(conn) {
  try {
    await conn.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME]);
  } catch (_e) {}
}

async function getAppliedMigrationsMap(conn) {
  await ensureSchemaMigrationsTable(conn);
  const [rows] = await conn.query(
    'SELECT `version`, `name`, `checksum`, `execution_ms`, `applied_at` FROM `schema_migrations` ORDER BY `version` ASC'
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.version, r);
  }
  return map;
}

/**
 * Verifies checksum integrity and ordering consistency between disk files and `schema_migrations`.
 */
function verifyIntegrity(pairs, appliedMap) {
  const diskByVersion = new Map(pairs.map((p) => [p.version, p]));

  for (const [appliedVer, appliedRow] of appliedMap.entries()) {
    const disk = diskByVersion.get(appliedVer);
    if (!disk) {
      throw new MigrationError(
        'MISSING_APPLIED_MIGRATION_FILE',
        `Applied migration version "${appliedVer}" (${appliedRow.name}) is missing from disk.`
      );
    }
    if (disk.checksum !== appliedRow.checksum) {
      throw new MigrationError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `Checksum mismatch for applied migration "${disk.upFile}". Expected ${appliedRow.checksum}, got ${disk.checksum}.`,
        { version: appliedVer, expected: appliedRow.checksum, actual: disk.checksum }
      );
    }
  }

  // Reject out-of-order unapplied migrations preceding an already-applied higher version
  const highestApplied = [...appliedMap.keys()].sort().pop() || null;
  if (highestApplied) {
    for (const pair of pairs) {
      if (!appliedMap.has(pair.version) && pair.version < highestApplied) {
        throw new MigrationError(
          'OUT_OF_ORDER_MIGRATION',
          `Unapplied migration "${pair.upFile}" precedes already-applied version "${highestApplied}".`,
          { unappliedVersion: pair.version, highestApplied }
        );
      }
    }
  }
}

async function getMigrationStatus(pool, { migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  const pairs = loadMigrationPairs(migrationsDir);
  const conn = await pool.getConnection();
  try {
    const appliedMap = await getAppliedMigrationsMap(conn);
    verifyIntegrity(pairs, appliedMap);
    return pairs.map((p) => {
      const applied = appliedMap.get(p.version);
      return {
        version: p.version,
        name: p.name,
        checksum: p.checksum,
        applied: Boolean(applied),
        appliedAt: applied ? applied.applied_at : null,
        executionMs: applied ? applied.execution_ms : null,
      };
    });
  } finally {
    conn.release();
  }
}

async function migrateUp(pool, { migrationsDir = DEFAULT_MIGRATIONS_DIR, targetVersion = null, lockTimeoutSec = 15 } = {}) {
  const pairs = loadMigrationPairs(migrationsDir);
  const conn = await pool.getConnection();
  const appliedNow = [];

  try {
    await acquireAdvisoryLock(conn, lockTimeoutSec);
    const appliedMap = await getAppliedMigrationsMap(conn);
    verifyIntegrity(pairs, appliedMap);

    for (const pair of pairs) {
      if (targetVersion && pair.version > targetVersion) break;
      if (appliedMap.has(pair.version)) continue;

      const statements = splitSqlStatements(pair.upSql);
      if (statements.length === 0) {
        throw new MigrationError('EMPTY_MIGRATION', `Migration "${pair.upFile}" contains no SQL statements.`);
      }

      const started = Date.now();
      for (let idx = 0; idx < statements.length; idx++) {
        try {
          await conn.query(statements[idx]);
        } catch (err) {
          throw new MigrationError(
            'MIGRATION_STATEMENT_FAILED',
            `Failed applying "${pair.upFile}" at statement #${idx + 1}: ${err.message}`,
            { version: pair.version, statementIndex: idx + 1, mysqlCode: err.code }
          );
        }
      }
      const executionMs = Date.now() - started;

      await conn.query(
        'INSERT INTO `schema_migrations` (`version`, `name`, `checksum`, `execution_ms`) VALUES (?, ?, ?, ?)',
        [pair.version, pair.name, pair.checksum, executionMs]
      );

      logger.info('Applied MySQL migration', {
        version: pair.version,
        name: pair.name,
        executionMs,
      });
      appliedNow.push({ version: pair.version, name: pair.name, executionMs });
    }

    return appliedNow;
  } finally {
    await releaseAdvisoryLock(conn);
    conn.release();
  }
}

async function migrateDown(pool, { migrationsDir = DEFAULT_MIGRATIONS_DIR, steps = 1, lockTimeoutSec = 15 } = {}) {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new MigrationError('INVALID_ROLLBACK_STEPS', 'Rollback steps must be a positive integer.');
  }

  const pairs = loadMigrationPairs(migrationsDir);
  const diskByVersion = new Map(pairs.map((p) => [p.version, p]));
  const conn = await pool.getConnection();
  const rolledBack = [];

  try {
    await acquireAdvisoryLock(conn, lockTimeoutSec);
    const appliedMap = await getAppliedMigrationsMap(conn);
    verifyIntegrity(pairs, appliedMap);

    const appliedVersionsDesc = [...appliedMap.keys()].sort().reverse().slice(0, steps);
    for (const ver of appliedVersionsDesc) {
      const pair = diskByVersion.get(ver);
      const statements = splitSqlStatements(pair.downSql);
      if (statements.length === 0) {
        throw new MigrationError('EMPTY_ROLLBACK', `Rollback "${pair.downFile}" contains no SQL statements.`);
      }

      const started = Date.now();
      for (let idx = 0; idx < statements.length; idx++) {
        try {
          await conn.query(statements[idx]);
        } catch (err) {
          throw new MigrationError(
            'ROLLBACK_STATEMENT_FAILED',
            `Failed rolling back "${pair.downFile}" at statement #${idx + 1}: ${err.message}`,
            { version: pair.version, statementIndex: idx + 1, mysqlCode: err.code }
          );
        }
      }
      const executionMs = Date.now() - started;

      await conn.query('DELETE FROM `schema_migrations` WHERE `version` = ?', [pair.version]);

      logger.info('Rolled back MySQL migration', {
        version: pair.version,
        name: pair.name,
        executionMs,
      });
      rolledBack.push({ version: pair.version, name: pair.name, executionMs });
    }

    return rolledBack;
  } finally {
    await releaseAdvisoryLock(conn);
    conn.release();
  }
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  MigrationError,
  sha256Hex,
  splitSqlStatements,
  loadMigrationPairs,
  getMigrationStatus,
  migrateUp,
  migrateDown,
};
