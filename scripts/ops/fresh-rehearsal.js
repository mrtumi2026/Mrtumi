#!/usr/bin/env node
'use strict';

/**
 * Fresh-install rehearsal on the disposable rehearsal database.
 * Run inside a SEPARATE clone whose .env points at the rehearsal database:
 *   node scripts/ops/fresh-rehearsal.js --reset
 * It empties the rehearsal database, applies every migration, creates a throw-away
 * Super Admin, starts the app on a local port and opens the public and admin pages.
 * It refuses to touch any other database, and stops if this login can read production.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REHEARSAL_DB = 'mrtumico_rehearsal';
const REHEARSAL_USER = 'mrtumico_rehearsal_usr';
const PRODUCTION_DB = 'mrtumico_Mrtumi';
const PRODUCTION_ROOT_NAME = 'mrtumi';

function assertRehearsalProfile({ database, user, root }) {
  if (database !== REHEARSAL_DB) throw new Error(`REFUSED: DB_NAME must be ${REHEARSAL_DB}.`);
  if (user !== REHEARSAL_USER) throw new Error(`REFUSED: DB_USER must be ${REHEARSAL_USER}.`);
  if (path.basename(root) === PRODUCTION_ROOT_NAME) throw new Error('REFUSED: do not run inside the production application folder.');
}

async function assertProductionDenied(connection) {
  try {
    await connection.query(`SELECT 1 FROM \`${PRODUCTION_DB}\`.\`schema_migrations\` LIMIT 1`);
  } catch (error) {
    if ([1044, 1142].includes(error.errno)) return;
    throw new Error(`REFUSED: could not prove production is blocked (MySQL error ${error.errno}).`);
  }
  throw new Error('REFUSED: the rehearsal login can read the production database.');
}

async function dropAll(connection) {
  const [rows] = await connection.query('SELECT DATABASE() AS name');
  if (rows[0].name !== REHEARSAL_DB) throw new Error('REFUSED: connected to an unexpected database.');
  const [objects] = await connection.query(
    "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY (TABLE_TYPE='VIEW') DESC"
  );
  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const object of objects) {
      const quoted = `\`${String(object.name).replace(/`/g, '``')}\``;
      await connection.query(`DROP ${object.type === 'VIEW' ? 'VIEW' : 'TABLE'} IF EXISTS ${quoted}`);
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS=1');
  }
  return objects.length;
}

/** Writes a rehearsal-only .env with new random secrets. DB_PASSWORD is left empty for the owner to fill in. */
function initEnvFile(root) {
  if (path.basename(root) === PRODUCTION_ROOT_NAME) throw new Error('REFUSED: do not run inside the production application folder.');
  const random = () => crypto.randomBytes(48).toString('hex');
  const lines = [
    'NODE_ENV=production', 'APP_URL=https://rehearsal.invalid', 'HOST=127.0.0.1', 'PORT=3999', 'TRUST_PROXY=1', 'TZ=Asia/Dhaka',
    `SESSION_SECRET=${random()}`, `CSRF_SECRET=${random()}`, `VENDOR_PII_KEY=${crypto.randomBytes(32).toString('hex')}`,
    'DB_CLIENT=mysql', 'DB_HOST=127.0.0.1', 'DB_PORT=3306', `DB_NAME=${REHEARSAL_DB}`, `DB_USER=${REHEARSAL_USER}`, 'DB_PASSWORD=',
    `UPLOAD_DIR=${root}-data/uploads`, `VENDOR_DOCUMENT_DIR=${root}-data/vendor_docs`, 'SEED_DEMO_DATA=false',
    'ANALYTICS_ATTRIBUTION_ENABLED=false', '',
  ];
  fs.writeFileSync(path.join(root, '.env'), lines.join('\n'), { mode: 0o600, flag: 'wx' });
  fs.mkdirSync(`${root}-data/uploads`, { recursive: true, mode: 0o700 });
  fs.mkdirSync(`${root}-data/vendor_docs`, { recursive: true, mode: 0o700 });
}

const cookieJar = new Map();
async function request(base, url, { method = 'GET', form } = {}) {
  const headers = { 'x-forwarded-proto': 'https' };
  if (cookieJar.size) headers.cookie = [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(base + url, {
    method, headers, redirect: 'manual', body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  });
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair.indexOf('=');
    cookieJar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return { status: response.status, location: response.headers.get('location') || '', body: await response.text() };
}

async function waitForServer(base) {
  for (let i = 0; i < 60; i += 1) {
    try { await request(base, '/admin/login'); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('The app did not start within 30 seconds.');
}

async function main() {
  if (process.argv.includes('--init-env')) {
    initEnvFile(ROOT);
    console.log(`Created ${path.join(ROOT, '.env')}. Type the rehearsal database password after DB_PASSWORD= (File Manager).`);
    return;
  }
  const { env } = require('../../src/config/env');
  assertRehearsalProfile({ database: env.db.database, user: env.db.user, root: ROOT });
  const { createPoolFromConfig, closePool } = require('../../src/db/mysqlPool');
  const mysql = require('../../src/db/mysqlPool');
  const { loadMigrationPairs, migrateUp, DEFAULT_MIGRATIONS_DIR } = require('../../src/db/migrator');
  const { createFirstSuperAdmin } = require('../create-first-admin');
  const failures = [];
  const pool = createPoolFromConfig(env.db);
  let server;
  try {
    const connection = await pool.getConnection();
    try {
      await assertProductionDenied(connection);
      console.log('PASS  production database is blocked for the rehearsal login');
      const [[version]] = await connection.query('SELECT VERSION() AS v');
      console.log(`      database server: ${version.v}`);
      const [[count]] = await connection.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()');
      if (Number(count.n) && !process.argv.includes('--reset')) throw new Error('The rehearsal database is not empty. Run again with --reset.');
      if (Number(count.n)) console.log(`      emptied ${await dropAll(connection)} old rehearsal objects`);
    } finally {
      connection.release();
    }
    const expected = loadMigrationPairs(DEFAULT_MIGRATIONS_DIR).length;
    const applied = await migrateUp(pool);
    if (applied.length !== expected) throw new Error(`Applied ${applied.length} of ${expected} migrations.`);
    if ((await migrateUp(pool)).length !== 0) throw new Error('A second migration run was not a no-op.');
    console.log(`PASS  ${expected} migrations applied to an empty database; second run changed nothing`);

    const email = `rehearsal-${crypto.randomBytes(4).toString('hex')}@example.invalid`;
    const password = crypto.randomBytes(24).toString('base64url');
    await createFirstSuperAdmin({ name: 'Rehearsal Admin', email, password }, { pool });
    console.log('PASS  first Super Admin created');

    const port = 20000 + crypto.randomInt(20000);
    const base = `http://127.0.0.1:${port}`;
    let log = '';
    server = spawn(process.execPath, ['app.js'], { cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) } });
    server.stdout.on('data', (d) => { log = (log + d).slice(-20000); });
    server.stderr.on('data', (d) => { log = (log + d).slice(-20000); });
    await waitForServer(base);

    const check = async (url, allowed = [200]) => {
      let result = await request(base, url);
      // Some old menu addresses redirect to their current admin page; follow one such hop.
      if (result.status === 302 && result.location.startsWith('/admin/') && !/login/.test(result.location)) {
        result = await request(base, result.location.split('#')[0]);
      }
      if (!allowed.includes(result.status)) failures.push(`${url} -> ${result.status} ${result.location}`);
      return result;
    };
    for (const url of ['/', '/track-order', '/vendor/login', '/reseller/login']) await check(url);
    console.log('      public pages requested');

    const login = await check('/admin/login');
    const token = /name="_csrf" value="([^"]+)"/.exec(login.body)?.[1];
    const posted = await request(base, '/admin/login', { method: 'POST', form: { _csrf: token || '', email, password } });
    if (posted.status !== 302 || /login/.test(posted.location)) throw new Error(`Admin login failed (${posted.status} ${posted.location}).`);
    console.log('PASS  admin login');

    const dashboard = await check('/admin/dashboard');
    const links = [...new Set([...dashboard.body.matchAll(/href="(\/admin\/[^"#]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&')))]
      .filter((url) => !/logout|export|download|delete|\.csv/i.test(url));
    for (const url of links) await check(url);
    console.log(`      ${links.length} admin pages requested`);

    if (failures.length) {
      console.log(log.split('\n').filter((l) => /"level":"error"|Error/.test(l)).slice(-15).join('\n'));
    }
  } finally {
    if (server) server.kill();
    await closePool(pool);
    await mysql.closePool().catch(() => {});
  }
  if (failures.length) {
    failures.forEach((f) => console.log(`FAIL  ${f}`));
    process.exit(1);
  }
  console.log('REHEARSAL PASSED');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(`REHEARSAL FAILED: ${error.code || ''} ${error.message}`);
    process.exit(1);
  });
}

module.exports = { assertRehearsalProfile, assertProductionDenied };
