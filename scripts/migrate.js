#!/usr/bin/env node
'use strict';

/**
 * CLI Runner for Versioned MySQL Migrations
 * Usage:
 *   node scripts/migrate.js status
 *   node scripts/migrate.js up
 *   node scripts/migrate.js down [steps]
 */

const { env } = require('../src/config/env');
const { createPoolFromConfig, closePool } = require('../src/db/mysqlPool');
const { getMigrationStatus, migrateUp, migrateDown } = require('../src/db/migrator');

async function main() {
  const command = String(process.argv[2] || 'status').toLowerCase();

  // Safety guard against accidental production runs without explicit confirmation flag
  if (env.isProduction && process.env.CONFIRM_PRODUCTION_MIGRATION !== 'true') {
    console.error(
      'SAFETY BLOCK: Refusing to run migrations with NODE_ENV=production without CONFIRM_PRODUCTION_MIGRATION=true.'
    );
    process.exit(1);
  }

  const pool = createPoolFromConfig(env.db);
  try {
    if (command === 'status') {
      const status = await getMigrationStatus(pool);
      console.table(status);
      return;
    }
    if (command === 'up') {
      const applied = await migrateUp(pool);
      console.log(`Migrations applied: ${applied.length}`);
      if (applied.length > 0) console.table(applied);
      return;
    }
    if (command === 'down') {
      const steps = Number(process.argv[3] || 1);
      const reverted = await migrateDown(pool, { steps });
      console.log(`Migrations rolled back: ${reverted.length}`);
      if (reverted.length > 0) console.table(reverted);
      return;
    }

    console.error(`Unknown migrate command "${command}". Expected: status | up | down [steps]`);
    process.exit(1);
  } finally {
    await closePool(pool);
  }
}

main().catch((err) => {
  console.error(`[MIGRATION FAILED] ${err.code || 'ERROR'}: ${err.message}`);
  process.exit(1);
});
