'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB_PATH = path.join(__dirname, '..', 'data', `mrtumi.phase02.${process.pid}.test.db`);
process.env.NODE_ENV = 'test';
process.env.SQLITE_PATH = TEST_DB_PATH;
process.env.SEED_DEMO_DATA = 'true';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@mrtumi.test';

const { buildConfig } = require('../src/config/env');

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

  assert.throws(
    () =>
      buildConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'short-secret',
      }),
    /SESSION_SECRET must be set/
  );

  const prodCfg = buildConfig({
    NODE_ENV: 'production',
    DB_CLIENT: 'mysql',
    SESSION_SECRET: 'a'.repeat(48),
  });
  assert.equal(prodCfg.isProduction, true);
  assert.equal(prodCfg.db.client, 'mysql');
  assert.equal(prodCfg.seedDemoData, false);

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
