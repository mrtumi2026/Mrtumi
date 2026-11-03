'use strict';

const { migrateUp } = require('../../src/db/migrator');

function assertDisposableTestProfile() {
  const dbName = String(process.env.DB_NAME || process.env.MYSQL_TEST_DB || '').trim();
  const host = String(process.env.DB_HOST || process.env.MYSQL_TEST_HOST || '').trim();
  if (process.env.NODE_ENV !== 'test'
      || process.env.DB_CLIENT !== 'mysql'
      || process.env.MYSQL_TEST_REQUIRED !== 'true'
      || dbName !== 'mrtumi_test'
      || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Refusing destructive MySQL test reset outside the required disposable local mrtumi_test profile.');
  }
}

async function dropDisposableMysqlSchema(pool) {
  assertDisposableTestProfile();
  if (!pool || typeof pool.getConnection !== 'function') throw new TypeError('A MySQL pool is required.');

  const connection = await pool.getConnection();
  let failure = null;
  let foreignKeyChecksDisabled = false;
  try {
    const [rows] = await connection.query('SELECT DATABASE() AS database_name');
    if (rows?.[0]?.database_name !== 'mrtumi_test') {
      throw new Error('Refusing destructive reset: connected schema is not mrtumi_test.');
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    foreignKeyChecksDisabled = true;
    const [tables] = await connection.query(
      `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.tables
       WHERE TABLE_SCHEMA = DATABASE() ORDER BY (TABLE_TYPE = 'VIEW') DESC`
    );
    for (const { table_name: tableName, table_type: tableType } of tables) {
      const quotedName = `\`${String(tableName).replace(/`/g, '``')}\``;
      const objectType = String(tableType || 'BASE TABLE').toUpperCase();
      if (objectType === 'VIEW') await connection.query(`DROP VIEW IF EXISTS ${quotedName}`);
      else if (objectType === 'BASE TABLE') await connection.query(`DROP TABLE IF EXISTS ${quotedName}`);
      else throw new Error(`Refusing to reset unsupported database object type: ${objectType}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (foreignKeyChecksDisabled) {
      try { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); }
      catch (error) { failure ||= error; }
    }
    try { connection.release(); }
    catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
}

async function resetDisposableMysqlDatabase(pool) {
  await dropDisposableMysqlSchema(pool);
  return migrateUp(pool);
}

module.exports = { assertDisposableTestProfile, dropDisposableMysqlSchema, resetDisposableMysqlDatabase };
