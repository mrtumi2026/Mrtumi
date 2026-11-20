'use strict';

/**
 * One-Command Production Diagnostic Utility (OPS-03)
 * Non-destructively audits runtime, database, migrations, secrets presence, and integrations.
 * Strictly redacts all secret values — safe to run on production cPanel / SSH.
 */

const { execSync } = require('child_process');
const { env } = require('../src/config/env');

function getGitInfo() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    return { sha, branch, available: true };
  } catch (_e) {
    return { sha: 'UNKNOWN', branch: 'UNKNOWN', available: false };
  }
}

async function checkDatabase() {
  if (env.db.client !== 'mysql') {
    return { client: env.db.client, isMysql: false, connected: true, note: 'Running in SQLite/prototype mode' };
  }
  const { createPoolFromConfig } = require('../src/db/mysqlPool');
  const pool = createPoolFromConfig(env.db);
  const start = Date.now();
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS ping, @@version AS version, @@character_set_database AS charset, @@collation_database AS collation');
    const latencyMs = Date.now() - start;
    return {
      isMysql: true,
      connected: true,
      latencyMs,
      version: rows[0]?.version || 'Unknown',
      charset: rows[0]?.charset || 'Unknown',
      collation: rows[0]?.collation || 'Unknown',
      pool,
    };
  } catch (error) {
    return {
      isMysql: true,
      connected: false,
      error: error.message,
      pool: null,
    };
  }
}

async function checkMigrations(pool) {
  if (!pool) return { status: 'SKIPPED', note: 'No active MySQL connection' };
  try {
    const { loadMigrationPairs } = require('../src/db/migrator');
    const pairs = loadMigrationPairs();
    const [rows] = await pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC');
    const appliedMap = new Map(rows.map(r => [r.version, r]));
    const pending = pairs.filter(p => !appliedMap.has(p.version));

    return {
      totalDefined: pairs.length,
      appliedCount: rows.length,
      pendingCount: pending.length,
      pendingVersions: pending.map(p => `${p.version}_${p.name}`),
      status: pending.length === 0 ? 'UP_TO_DATE' : 'PENDING_MIGRATIONS',
    };
  } catch (error) {
    return { status: 'ERROR', error: error.message };
  }
}

function auditSecretPresence() {
  const audit = (val, minLen = 1) => (val && String(val).trim().length >= minLen ? 'CONFIGURED' : 'NOT_CONFIGURED');
  return {
    SESSION_SECRET: audit(env.sessionSecret, 16),
    CSRF_SECRET: audit(env.csrfSecret, 16),
    DB_USER: audit(env.db.user),
    DB_PASS: audit(env.db.password),
    DB_NAME: audit(env.db.name),
    BULKSMS_API_KEY: audit(env.bulksmsApiKey),
    BULKSMS_SENDER_ID: audit(env.bulksmsSenderId),
    SMTP_HOST: audit(env.smtpHost),
    SMTP_USER: audit(env.smtpUser),
    STEADFAST_API_KEY: audit(process.env.STEADFAST_API_KEY),
    PATHAO_CLIENT_ID: audit(process.env.PATHAO_CLIENT_ID),
  };
}

async function main() {
  console.log('================================================================');
  console.log('         MR. TUMI PLATFORM PRODUCTION DIAGNOSTIC REPORT         ');
  console.log('================================================================');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Platform:  ${process.platform} (${process.arch}), Node ${process.version}`);
  console.log(`Memory:    RSS ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB | Heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`App Env:   NODE_ENV=${env.isProduction ? 'production' : env.nodeEnv} | PASSENGER_APP_ENV=${process.env.PASSENGER_APP_ENV || '(not set)'}`);

  const git = getGitInfo();
  console.log(`Git HEAD:  Commit ${git.sha} (${git.branch})`);

  console.log('\n--- 1. SECRETS PRESENCE AUDIT (Values Redacted) ---');
  const secrets = auditSecretPresence();
  for (const [k, v] of Object.entries(secrets)) {
    const mark = v === 'CONFIGURED' ? '✔' : '⚠';
    console.log(`  ${mark} ${k.padEnd(20)}: ${v}`);
  }

  console.log('\n--- 2. DATABASE CONNECTIVITY ---');
  const db = await checkDatabase();
  if (db.isMysql && db.connected) {
    console.log(`  ✔ Connected to MySQL in ${db.latencyMs}ms`);
    console.log(`    Server Version: ${db.version}`);
    console.log(`    Database Charset: ${db.charset} (${db.collation})`);

    console.log('\n--- 3. MIGRATION STATUS ---');
    const mig = await checkMigrations(db.pool);
    if (mig.status === 'UP_TO_DATE') {
      console.log(`  ✔ Schema is fully up to date (${mig.appliedCount}/${mig.totalDefined} migrations applied)`);
    } else if (mig.status === 'PENDING_MIGRATIONS') {
      console.log(`  ⚠ ${mig.pendingCount} pending migration(s) out of ${mig.totalDefined}:`);
      mig.pendingVersions.forEach(v => console.log(`    - ${v}`));
    } else {
      console.log(`  ✖ Migration inspection error: ${mig.error}`);
    }

    const { closePool } = require('../src/db/mysqlPool');
    await closePool(db.pool);
  } else if (!db.isMysql) {
    console.log('  ℹ Running in SQLite prototype mode (DB_CLIENT !== "mysql").');
    console.log('\n--- 3. MIGRATION STATUS ---');
    console.log('  ℹ MySQL migration inspection skipped in local prototype mode.');
  } else {
    console.log(`  ✖ MySQL connection failed: ${db.error}`);
    console.log('\n--- 3. MIGRATION STATUS ---');
    console.log('  ✖ Skipped due to MySQL connection error.');
  }

  console.log('\n--- 4. CUSTOMER RECOVERY STATUS ---');
  try {
    const recovery = require('../src/services/customerRecoveryService');
    const status = await recovery.getRecoveryProviderStatus();
    console.log(`  Active: ${status.enabled ? 'ENABLED' : 'DISABLED (Fail-Closed Safeguard)'}`);
    console.log(`  SMS Gateway (BulkSMSBD): ${status.sms.available ? 'READY' : 'UNCONFIGURED'}`);
    if (status.sms.missing.length) console.log(`    Missing: ${status.sms.missing.join(', ')}`);
    console.log(`  Email Gateway (SMTP):    ${status.email.available ? 'READY' : 'UNCONFIGURED'}`);
    if (status.email.missing.length) console.log(`    Missing: ${status.email.missing.join(', ')}`);
  } catch (err) {
    console.log(`  ✖ Failed to inspect recovery status: ${err.message}`);
  }

  console.log('\n================================================================');
  console.log('              DIAGNOSTIC VERIFICATION COMPLETE                  ');
  console.log('================================================================');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Diagnostic execution error:', err.message);
    process.exit(1);
  });
}

module.exports = { main, auditSecretPresence };
