'use strict';

const mysql = require('mysql2/promise');
const { env } = require('../config/env');
const { DatabaseError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

let singletonPool = null;

function validateMysqlConfig(dbCfg) {
  if (!dbCfg || typeof dbCfg !== 'object') {
    throw new ValidationError('MySQL configuration object is required.');
  }
  const missing = [];
  if (!String(dbCfg.host || '').trim()) missing.push('DB_HOST');
  if (!Number.isInteger(Number(dbCfg.port)) || Number(dbCfg.port) <= 0 || Number(dbCfg.port) > 65535) {
    missing.push('DB_PORT');
  }
  if (!String(dbCfg.name || '').trim()) missing.push('DB_NAME');
  if (!String(dbCfg.user || '').trim()) missing.push('DB_USER');

  if (missing.length > 0) {
    throw new ValidationError(
      `Missing or invalid MySQL configuration variables: ${missing.join(', ')}.`,
      { missing }
    );
  }
}

function sanitizeDbError(err, context = 'query') {
  const mysqlCode = err && err.code ? String(err.code) : 'MYSQL_ERROR';
  const errno = err && err.errno ? Number(err.errno) : undefined;

  if (mysqlCode === 'ER_DUP_ENTRY' || errno === 1062) {
    const dupErr = new DatabaseError('DB_DUPLICATE_ENTRY', 'Duplicate record violates a unique constraint.', 409);
    dupErr.mysqlCode = mysqlCode;
    return dupErr;
  }

  if (
    mysqlCode === 'ER_NO_REFERENCED_ROW_2' ||
    mysqlCode === 'ER_ROW_IS_REFERENCED_2' ||
    errno === 1451 ||
    errno === 1452
  ) {
    const fkErr = new DatabaseError(
      'DB_FOREIGN_KEY_CONSTRAINT',
      'Operation violates a relational foreign-key constraint.',
      409
    );
    fkErr.mysqlCode = mysqlCode;
    return fkErr;
  }

  if (
    mysqlCode === 'ECONNREFUSED' ||
    mysqlCode === 'ETIMEDOUT' ||
    mysqlCode === 'ENOTFOUND' ||
    mysqlCode === 'PROTOCOL_CONNECTION_LOST' ||
    mysqlCode === 'ER_ACCESS_DENIED_ERROR' ||
    mysqlCode === 'ER_BAD_DB_ERROR'
  ) {
    logger.error('MySQL connection failure', { context, mysqlCode, errno });
    const connErr = new DatabaseError(
      'DB_CONNECTION_FAILED',
      `Unable to connect to MySQL database (${mysqlCode}). Verify DB_HOST, DB_PORT, DB_NAME, and credentials.`,
      503
    );
    connErr.mysqlCode = mysqlCode;
    return connErr;
  }

  logger.error('MySQL query error', {
    context,
    mysqlCode,
    errno,
    message: err && err.message ? err.message : 'Unknown error',
  });
  const generic = new DatabaseError('DB_QUERY_FAILED', `Database error (${mysqlCode}).`, 500);
  generic.mysqlCode = mysqlCode;
  return generic;
}

function normalizeParams(params = []) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

/**
 * Wraps a mysql2 Pool or PoolConnection in a consistent async query interface.
 */
function createQueryClient(executor) {
  async function queryAll(sql, params = []) {
    try {
      const [rows] = await executor.query(sql, normalizeParams(params));
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      throw sanitizeDbError(err, 'queryAll');
    }
  }

  async function queryOne(sql, params = []) {
    const rows = await queryAll(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async function execute(sql, params = []) {
    try {
      const [res] = await executor.query(sql, normalizeParams(params));
      return {
        insertId: res && res.insertId ? Number(res.insertId) : 0,
        affectedRows: res && typeof res.affectedRows === 'number' ? res.affectedRows : 0,
        changedRows: res && typeof res.changedRows === 'number' ? res.changedRows : 0,
      };
    } catch (err) {
      throw sanitizeDbError(err, 'execute');
    }
  }

  /**
   * Acquires deterministic ascending row-level `FOR UPDATE` locks inside an active transaction
   * to prevent AB-BA deadlocks across concurrent order/inventory mutations.
   */
  async function lockRowsById(tableName, ids, columns = ['*']) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new ValidationError(`Unsafe table identifier "${tableName}".`);
    }
    const safeCols = columns.map((c) => {
      if (c === '*') return '*';
      if (!/^[a-zA-Z0-9_]+$/.test(c)) {
        throw new ValidationError(`Unsafe column identifier "${c}".`);
      }
      return `\`${c}\``;
    });

    const uniqueSortedIds = [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isSafeInteger(n) && n > 0))].sort(
      (a, b) => a - b
    );
    if (uniqueSortedIds.length === 0) return [];

    const placeholders = uniqueSortedIds.map(() => '?').join(', ');
    const sql = `SELECT ${safeCols.join(', ')} FROM \`${tableName}\` WHERE \`id\` IN (${placeholders}) ORDER BY \`id\` ASC FOR UPDATE`;
    return queryAll(sql, uniqueSortedIds);
  }

  return {
    queryAll,
    queryOne,
    execute,
    lockRowsById,
  };
}

function createPoolFromConfig(dbCfg = env.db) {
  validateMysqlConfig(dbCfg);

  const pool = mysql.createPool({
    host: dbCfg.host,
    port: Number(dbCfg.port || 3306),
    user: dbCfg.user,
    password: dbCfg.password || '',
    database: dbCfg.name,
    charset: dbCfg.charset || 'utf8mb4',
    timezone: dbCfg.timezone || '+00:00',
    waitForConnections: true,
    connectionLimit: Math.max(1, Math.min(50, Number(dbCfg.connectionLimit || 10))),
    queueLimit: 50,
    connectTimeout: Number(dbCfg.connectTimeoutMs || 8000),
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  });

  pool.on('connection', (conn) => {
    conn.query(
      "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00'"
    );
  });

  return pool;
}

function getPool() {
  if (!singletonPool) {
    singletonPool = createPoolFromConfig(env.db);
  }
  return singletonPool;
}

async function closePool(targetPool = singletonPool) {
  if (targetPool) {
    if (targetPool === singletonPool) {
      singletonPool = null;
    }
    await targetPool.end();
  }
}

async function pingPool(targetPool = null, timeoutMs = 5000) {
  const startedAt = Date.now();
  let poolToPing = targetPool;
  try {
    poolToPing = poolToPing || getPool();
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('MySQL health check timed out.');
        err.code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMs);
    });

    await Promise.race([poolToPing.query('SELECT 1 AS ok'), timeoutPromise]);
    clearTimeout(timer);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const safeErr = sanitizeDbError(err, 'pingPool');
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      code: safeErr.code,
      mysqlCode: safeErr.mysqlCode || 'UNKNOWN',
      message: safeErr.message,
    };
  }
}

/**
 * Runs `workFn(tx)` inside an explicit MySQL InnoDB transaction.
 * Automatically commits on success and rolls back on any thrown error.
 */
async function withTransaction(workFn, { pool = null, isolationLevel = null } = {}) {
  const activePool = pool || getPool();
  let conn;
  try {
    conn = await activePool.getConnection();
  } catch (err) {
    throw sanitizeDbError(err, 'withTransaction.getConnection');
  }

  try {
    if (isolationLevel) {
      const allowedLevels = [
        'READ COMMITTED',
        'REPEATABLE READ',
        'SERIALIZABLE',
      ];
      if (!allowedLevels.includes(isolationLevel)) {
        throw new ValidationError(`Unsupported transaction isolation level "${isolationLevel}".`);
      }
      await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    }

    await conn.beginTransaction();
    const tx = createQueryClient(conn);
    const result = await workFn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      logger.error('MySQL transaction rollback error', { message: rollbackErr.message });
    }
    if (err && err.isOperational) {
      throw err;
    }
    throw sanitizeDbError(err, 'withTransaction');
  } finally {
    conn.release();
  }
}

const defaultClient = {
  queryAll: (sql, params) => createQueryClient(getPool()).queryAll(sql, params),
  queryOne: (sql, params) => createQueryClient(getPool()).queryOne(sql, params),
  execute: (sql, params) => createQueryClient(getPool()).execute(sql, params),
  withTransaction,
  validateMysqlConfig,
  createPoolFromConfig,
  createQueryClient,
  getPool,
  closePool,
  pingPool,
  sanitizeDbError,
};

module.exports = defaultClient;
