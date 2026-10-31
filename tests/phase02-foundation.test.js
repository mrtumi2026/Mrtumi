'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB_PATH = path.join(__dirname, '..', 'data', `mrtumi.phase02.${process.pid}.test.db`);
process.env.NODE_ENV = 'test';
process.env.SQLITE_PATH = TEST_DB_PATH;
process.env.SEED_DEMO_DATA = 'true';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@mrtumi.test';

const { buildConfig } = require('../src/config/env');

function validProductionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    DB_CLIENT: 'mysql',
    DB_HOST: 'mysql.example.test',
    DB_PORT: '3306',
    DB_NAME: 'mrtumi_test',
    DB_USER: 'mrtumi_runtime',
    DB_PASSWORD: 'non-production-test-password',
    APP_URL: 'https://shop.example.test',
    SESSION_SECRET: 's'.repeat(48),
    CSRF_SECRET: 'c'.repeat(48),
    TRUST_PROXY: '1',
    UPLOAD_DIR: path.join(os.tmpdir(), `mrtumi-uploads-${process.pid}`),
    ...overrides,
  };
}

function cleanupTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (_e) {}
    }
  }
}

function httpGet(baseUrl, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${urlPath}`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHttp(baseUrl, urlPath, child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Startup process exited early (${child.exitCode}).`);
    try {
      return await httpGet(baseUrl, urlPath);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('Timed out waiting for the application startup path.');
}

test('env.js enforces Bangladesh defaults (Asia/Dhaka, BDT, bn/en) and rejects weak production secrets', () => {
  const devCfg = buildConfig({
    NODE_ENV: 'development',
    SESSION_SECRET: '',
  });
  assert.equal(devCfg.timezone, 'Asia/Dhaka');
  assert.equal(devCfg.defaultLocale, 'bn');
  assert.deepEqual(devCfg.supportedLocales, ['bn', 'en']);
  assert.equal(devCfg.currencyCode, 'BDT');
  assert.equal(devCfg.currencySymbol, '৳');
  assert.ok(devCfg.sessionSecret.length >= 32);
  assert.equal(devCfg.analyticsAttributionEnabled, false, 'optional attribution is disabled by default');
  assert.equal(buildConfig({ NODE_ENV: 'test', ANALYTICS_ATTRIBUTION_ENABLED: 'true' }).analyticsAttributionEnabled, true);
  assert.equal(buildConfig({ NODE_ENV: 'test', ANALYTICS_ATTRIBUTION_ENABLED: '1' }).analyticsAttributionEnabled, false, 'unknown values fail closed');

  assert.throws(
    () =>
      buildConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'short-secret',
      }),
    /SESSION_SECRET must be set/
  );

  const prodCfg = buildConfig(validProductionEnv());
  assert.equal(prodCfg.isProduction, true);
  assert.equal(prodCfg.db.client, 'mysql');
  assert.equal(prodCfg.seedDemoData, false);
  assert.equal(prodCfg.trustProxy, 1);
  assert.equal(prodCfg.uploadDir, validProductionEnv().UPLOAD_DIR);

  assert.throws(
    () => buildConfig(validProductionEnv({ DB_HOST: undefined, APP_URL: 'http://localhost' })),
    (err) => {
      assert.match(err.message, /DB_HOST/);
      assert.match(err.message, /APP_URL/);
      assert.doesNotMatch(err.message, /non-production-test-password|s{48}|c{48}/);
      return true;
    },
    'missing/unsafe production configuration fails without echoing values'
  );

  assert.throws(
    () => buildConfig(validProductionEnv({ CSRF_SECRET: 's'.repeat(48) })),
    /CSRF_SECRET \(must differ from SESSION_SECRET\)/
  );

  assert.throws(
    () => buildConfig(validProductionEnv({ TRUST_PROXY: undefined })),
    /TRUST_PROXY \(set to the verified proxy-hop count\)/
  );

  assert.throws(
    () => buildConfig(validProductionEnv({ UPLOAD_DIR: path.join(__dirname, '..', 'public', 'uploads') })),
    /UPLOAD_DIR \(must be outside the application root\)/
  );

  const startupSecret = 'startup-only-secret-do-not-print-123456';
  const failedProductionStartup = spawnSync(process.execPath, ['--no-warnings', 'app.js'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DB_CLIENT: 'mysql',
      DB_HOST: '',
      DB_PORT: '',
      DB_NAME: '',
      DB_USER: '',
      DB_PASSWORD: '',
      APP_URL: '',
      SESSION_SECRET: startupSecret,
      CSRF_SECRET: '',
      TRUST_PROXY: '',
      UPLOAD_DIR: '',
    },
  });
  assert.notEqual(failedProductionStartup.status, 0, 'production startup must fail closed with missing config');
  assert.match(failedProductionStartup.stderr, /PRODUCTION CONFIGURATION ERROR/);
  assert.doesNotMatch(failedProductionStartup.stderr, new RegExp(startupSecret));
  assert.doesNotMatch(failedProductionStartup.stderr, /SQLite/);

  const directServerDbPath = path.join(os.tmpdir(), `mrtumi-direct-server-${process.pid}.db`);
  const rejectedDevelopmentServerEntry = spawnSync(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DB_CLIENT: 'sqlite',
      SQLITE_PATH: directServerDbPath,
      SEED_DEMO_DATA: 'false',
    },
  });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${directServerDbPath}${suffix}`); } catch (_err) {}
  }
  assert.notEqual(rejectedDevelopmentServerEntry.status, 0);
  assert.match(rejectedDevelopmentServerEntry.stderr, /direct server\.js startup refuses development defaults/);

  assert.throws(
    () =>
      buildConfig({
        NODE_ENV: 'production',
        DB_CLIENT: 'sqlite',
        SESSION_SECRET: 'a'.repeat(48),
      }),
    /SQLite is prohibited in production/
  );
});

describeServerBoot();

function describeServerBoot() {
  let server;
  let baseUrl;

  before(async () => {
    cleanupTestDb();
    const passengerEntry = require('../app');
    assert.equal(typeof passengerEntry, 'function', 'app.js must export the Express app for Passenger');

    const { startServer } = require('../server');
    await new Promise((resolve) => {
      server = startServer(0, '127.0.0.1');
      server.once('listening', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    cleanupTestDb();
  });

  test('app.js startup honors assigned host/port and serves files from a persistent upload root', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrtumi-cpanel-upload-'));
    const customDir = path.join(storageRoot, 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'startup-check.txt'), 'persistent-upload-ok');
    const port = await reserveTcpPort();
    const child = spawn(process.execPath, ['--no-warnings', 'app.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        APP_ALLOW_TEST_STARTUP: 'true',
        DB_CLIENT: 'sqlite',
        SQLITE_PATH: path.join(storageRoot, 'startup-test.db'),
        UPLOAD_DIR: storageRoot,
        HOST: '127.0.0.1',
        PORT: String(port),
        SEED_DEMO_DATA: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childOutput = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { childOutput += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { childOutput += chunk; });
    const childBaseUrl = `http://127.0.0.1:${port}`;

    try {
      const health = await waitForHttp(childBaseUrl, '/health', child);
      assert.equal(health.statusCode, 200, childOutput);
      const uploaded = await httpGet(childBaseUrl, '/uploads/custom/startup-check.txt');
      assert.equal(uploaded.statusCode, 200, childOutput);
      assert.equal(uploaded.body, 'persistent-upload-ok');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  test('Storefront, Admin, Vendor, and Reseller routes respond cleanly with zero hardcoded passwords', async () => {
    const home = await httpGet(baseUrl, '/');
    assert.equal(home.statusCode, 200);
    assert.equal(home.headers['x-powered-by'], undefined, 'x-powered-by header must be disabled');

    const adminLogin = await httpGet(baseUrl, '/admin/login');
    assert.equal(adminLogin.statusCode, 200);
    assert.ok(!adminLogin.body.includes('admin123'), 'Admin login HTML must not leak default passwords');

    const vendorLogin = await httpGet(baseUrl, '/vendor/login');
    assert.equal(vendorLogin.statusCode, 200);
    assert.ok(!vendorLogin.body.includes('vendor123'), 'Vendor login HTML must not leak default passwords');

    const resellerLogin = await httpGet(baseUrl, '/reseller/login');
    assert.equal(resellerLogin.statusCode, 200);
    assert.ok(!resellerLogin.body.includes('reseller123'), 'Reseller login HTML must not leak default passwords');
  });

  test('Unconfigured external integrations start empty instead of seeded fake live keys', () => {
    const db = require('../src/db/database');
    const settings = db.getSettings();
    assert.equal(settings.bulksms_api_key, '');
    assert.equal(settings.bdcourier_api_key, '');
    assert.equal(settings.fb_capi_token, '');

    const couriers = db.all('SELECT code, api_key, status FROM courier_apis');
    assert.equal(couriers.length, 3);
    for (const c of couriers) {
      assert.equal(c.api_key, '', `Courier ${c.code} API key must be blank until configured`);
      assert.equal(c.status, 0, `Courier ${c.code} must be inactive until configured`);
    }
  });
}
