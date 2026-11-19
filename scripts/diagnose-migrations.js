'use strict';

// CI diagnostic: apply paired migrations one version at a time on a fresh disposable MySQL schema.
// This exposes the exact failing version and underlying MySQL error without logging credentials.
const { env } = require('../src/config/env');
const { createPoolFromConfig, closePool } = require('../src/db/mysqlPool');
const { loadMigrationPairs, migrateUp } = require('../src/db/migrator');
const { isMaintenanceLocked } = require('./ops/maintenance-guard');

function emitFailure(message) {
  console.error(message);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    process.stdout.write(`::error title=MySQL migration diagnostic::${escaped}\n`);
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production' || env.isProduction) {
    throw new Error('CRITICAL_SAFETY_VIOLATION: Refusing to run diagnostic migrations in production.');
  }
  if (isMaintenanceLocked()) {
    throw new Error('MAINTENANCE_LOCKED: Refusing to run diagnostic migrations while maintenance lock is active.');
  }
  if (env.db.client !== 'mysql') throw new Error('Migration diagnostic requires DB_CLIENT=mysql.');
  const pairs = loadMigrationPairs();
  const pool = createPoolFromConfig(env.db);
  try {
    for (const pair of pairs) {
      try {
        await migrateUp(pool, { targetVersion: pair.version });
      } catch (error) {
        emitFailure(JSON.stringify({
          version: pair.version,
          migration: pair.name,
          code: error.code || 'ERROR',
          message: error.message,
          details: error.details || null,
          causeCode: error.cause && error.cause.code || null,
          stack: error.stack,
        }));
        process.exitCode = 1;
        return;
      }
    }
    console.log(`Diagnostic migration lifecycle applied all ${pairs.length} versions individually.`);
  } finally {
    await closePool(pool);
  }
}

main().catch((error) => {
  emitFailure(JSON.stringify({code:error.code||'ERROR',message:error.message,stack:error.stack}));
  process.exitCode = 1;
});
