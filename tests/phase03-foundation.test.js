'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB_PATH = path.join(__dirname, '..', 'data', `mrtumi.phase03.${process.pid}.test.db`);
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = TEST_DB_PATH;
process.env.SEED_DEMO_DATA = 'true';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'phase03admin@mrtumi.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Phase03StrongPassword!99';
process.env.LOG_SILENT = 'true';

const { buildConfig } = require('../src/config/env');
const sqliteDb = require('../src/db/database');
const {
  createPoolFromConfig,
  closePool,
  pingPool,
  createQueryClient,
  validateMysqlConfig,
} = require('../src/db/mysqlPool');
const {
  loadMigrationPairs,
  splitSqlStatements,
  MigrationError,
} = require('../src/db/migrator');
const {
  bdtToPaisa,
  paisaToBdtString,
  formatBdt,
  addPaisa,
  subtractPaisa,
  multiplyPaisaByQty,
  calculateBasisPointsPaisa,
  computeOrderTotalsPaisa,
} = require('../src/utils/money');
const logger = require('../src/utils/logger');
const {
  normalizeBdPhone,
  requireEmail,
  requirePositiveInt,
  requirePaisaFromBdt,
  requireEnum,
} = require('../src/utils/validator');
const { attachCsrfToken, requireCsrf } = require('../src/middleware/csrf');
const { createRateLimiter } = require('../src/middleware/rateLimit');
const { requireRole, requirePermission } = require('../src/middleware/rbac');
const { attachRequestId, createErrorHandler } = require('../src/middleware/errorHandler');

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

function httpRequest(baseUrl, urlPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlPath, baseUrl);
    const payload = body
      ? typeof body === 'string'
        ? body
        : new URLSearchParams(body).toString()
      : null;

    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      target,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Phase 03 — Money Representation & Arithmetic in Paisa (BDT)', () => {
  test('Eliminates IEEE-754 floating-point drift and enforces integer paisa boundaries', () => {
    // Classic 0.1 + 0.2 floating point trap: must equal exact 30 paisa (৳0.30)
    const sum = addPaisa(bdtToPaisa('0.10'), bdtToPaisa('0.20'));
    assert.equal(sum, 30);
    assert.equal(paisaToBdtString(sum, { fixedDecimals: true }), '0.30');

    assert.equal(bdtToPaisa('1,350.75'), 135075);
    assert.equal(bdtToPaisa('৳ 499'), 49900);
    assert.equal(bdtToPaisa(19.99), 1999);
    assert.equal(formatBdt(135000, { locale: 'en' }), '৳1,350');
    assert.equal(formatBdt(135050, { locale: 'en' }), '৳1,350.50');

    // Reject sub-paisa precision, negative values (by default), and non-integers
    assert.throws(() => bdtToPaisa('10.999'), /exceeds 2 decimal places/);
    assert.throws(() => bdtToPaisa('-5.00'), /cannot be negative/);
    assert.throws(() => addPaisa(10.5, 20), /safe integer in paisa/);
    assert.throws(() => subtractPaisa(500, 600), /cannot be negative/);
  });

  test('Computes commission basis points and order totals/COD balances deterministically', () => {
    // 10.00% (1000 bps) of ৳1,250.00 (125000 paisa) = 12500 paisa (৳125.00)
    assert.equal(calculateBasisPointsPaisa(125000, 1000), 12500);
    // 2.50% (250 bps) of ৳99.00 (9900 paisa) = 247.5 -> half-up 248 paisa (৳2.48)
    assert.equal(calculateBasisPointsPaisa(9900, 250), 248);

    const totals = computeOrderTotalsPaisa({
      items: [
        { sku: 'GROC-01', unitPricePaisa: 65000, qty: 2 }, // 130000
        { sku: 'GIFT-02', unitPricePaisa: 45050, qty: 1 }, //  45050
      ],
      discountPaisa: 10000, // ৳100 discount
      shippingPaisa: 6000, // ৳60 Inside Dhaka
      advanceRequiredPaisa: 6000,
      paidPaisa: 6000, // ৳60 delivery advance paid
    });

    assert.equal(totals.subtotalPaisa, 175050);
    assert.equal(totals.discountPaisa, 10000);
    assert.equal(totals.totalPaisa, 171050); // 175050 - 10000 + 6000
    assert.equal(totals.advanceRequiredPaisa, 6000);
    assert.equal(totals.codDuePaisa, 165050); // 171050 - 6000
    assert.equal(multiplyPaisaByQty(65000, 3), 195000);
  });
});

describe('Phase 03 — Production SQLite Prohibition & DB Connection Failure Handling', () => {
  test('Rejects SQLite in production both at config validation and runtime database guard', () => {
    assert.throws(
      () =>
        buildConfig({
          NODE_ENV: 'production',
          DB_CLIENT: 'sqlite',
          SESSION_SECRET: 'x'.repeat(48),
        }),
      /SQLite is prohibited in production/
    );

    assert.throws(
      () =>
        buildConfig({
          NODE_ENV: 'production',
          DB_CLIENT: 'mysql',
          SESSION_SECRET: 'x'.repeat(48),
          CSRF_SECRET: 'short',
        }),
      /CSRF_SECRET must be at least 32 random characters/
    );

    // Runtime guard in src/db/database.js blocks SQLite calls in production or MySQL mode
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDbClient = process.env.DB_CLIENT;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => sqliteDb.assertSqliteAllowed(), /prohibited in production/i);

      process.env.NODE_ENV = 'test';
      process.env.DB_CLIENT = 'mysql';
      assert.throws(
        () => sqliteDb.assertSqliteAllowed(),
        /DB_CLIENT=mysql is active/i
      );
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      process.env.DB_CLIENT = prevDbClient;
    }
  });

  test('Handles missing MySQL config and unreachable MySQL server cleanly without leaking secrets', async () => {
    assert.throws(
      () => validateMysqlConfig({ host: '127.0.0.1', port: 3306, name: '', user: '' }),
      /DB_NAME, DB_USER/
    );

    const deadPool = createPoolFromConfig({
      host: '127.0.0.1',
      port: 65431,
      name: 'unreachable_db',
      user: 'test_user',
      password: 'SuperSecretDbPassword!123',
      connectTimeoutMs: 300,
      connectionLimit: 1,
    });

    try {
      const health = await pingPool(deadPool, 500);
      assert.equal(health.ok, false);
      assert.equal(health.code, 'DB_CONNECTION_FAILED');
      assert.ok(!JSON.stringify(health).includes('SuperSecretDbPassword!123'));

      const client = createQueryClient(deadPool);
      await assert.rejects(
        () => client.queryAll('SELECT 1'),
        (err) => {
          assert.equal(err.code, 'DB_CONNECTION_FAILED');
          assert.equal(err.statusCode, 503);
          assert.ok(!err.message.includes('SuperSecretDbPassword!123'));
          return true;
        }
      );
    } finally {
      await closePool(deadPool);
    }
  });
});

describe('Phase 03 — Migration Loader, Validator, Logger Redaction, CSRF, Rate Limit & RBAC', () => {
  test('Loads versioned reversible migration pairs in strict order and validates SQL integrity', () => {
    const pairs = loadMigrationPairs();
    assert.equal(pairs.length, 4);
    assert.deepEqual(
      pairs.map((p) => p.version),
      ['0001', '0002', '0003', '0004']
    );

    let totalCreateTables = 0;
    for (const pair of pairs) {
      assert.match(pair.checksum, /^[a-f0-9]{64}$/);
      const upStmts = splitSqlStatements(pair.upSql);
      const downStmts = splitSqlStatements(pair.downSql);
      assert.ok(upStmts.length > 0);
      assert.equal(upStmts.length, downStmts.length, `UP/DOWN count must match in ${pair.upFile}`);
      totalCreateTables += upStmts.length;
    }
    assert.ok(totalCreateTables >= 70, `Expected >= 70 InnoDB tables, got ${totalCreateTables}`);

    // Reject migration directory with missing .down.sql
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrtumi-mig-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '0001_broken.up.sql'), 'CREATE TABLE t (id INT);');
      assert.throws(
        () => loadMigrationPairs(tmpDir),
        (err) => err instanceof MigrationError && err.code === 'MISSING_DOWN_MIGRATION'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Validates BD phones, emails, enums, and redacts PII/secrets in structured logs', () => {
    assert.equal(normalizeBdPhone('+880 1712-345678'), '01712345678');
    assert.throws(() => normalizeBdPhone('0212345678'), /Invalid Bangladesh mobile/);
    assert.equal(requireEmail('  Customer@MrTumi.com '), 'customer@mrtumi.com');
    assert.equal(requirePositiveInt('15', 'qty'), 15);
    assert.equal(requirePaisaFromBdt('250.50', 'price'), 25050);
    assert.equal(requireEnum('inside_dhaka', ['inside_dhaka', 'outside_dhaka'], 'zone'), 'inside_dhaka');

    const redacted = logger.redactValue({
      password_hash: '$2a$10$secret',
      apiKey: 'LIVE_SECRET_KEY',
      customer_phone: '01712345678',
      note: 'Call +8801819887766 before delivery',
    });
    assert.equal(redacted.password_hash, '[REDACTED]');
    assert.equal(redacted.apiKey, '[REDACTED]');
    assert.equal(redacted.customer_phone, '01712****78');
    assert.equal(redacted.note, 'Call +8801819****66 before delivery');
  });

  test('Enforces CSRF, CGNAT-safe rate limiting, and server-side RBAC on API endpoints', async () => {
    const miniApp = express();
    miniApp.use(attachRequestId);
    miniApp.use(express.json());
    miniApp.use(express.urlencoded({ extended: false }));

    const fakeSessions = new Map();
    miniApp.use((req, _res, next) => {
      const sid = req.headers['x-test-sid'] || 'sid-1';
      if (!fakeSessions.has(sid)) fakeSessions.set(sid, {});
      req.sessionID = sid;
      req.session = fakeSessions.get(sid);
      next();
    });
    miniApp.use(attachCsrfToken);

    miniApp.get('/api/csrf', (req, res) => res.json({ ok: true, token: req.csrfToken() }));
    miniApp.post('/api/mutate', requireCsrf, (_req, res) => res.json({ ok: true }));

    const strictLimiter = createRateLimiter({ windowMs: 60_000, max: 2, keyPrefix: 'test-rl' });
    miniApp.post('/api/otp', strictLimiter, (_req, res) => res.json({ ok: true }));

    miniApp.get(
      '/api/admin/finance',
      (req, _res, next) => {
        const role = req.headers['x-role'];
        const perm = req.headers['x-perm'];
        if (role) {
          req.adminUser = {
            id: 9,
            role_slug: String(role),
            permissions: perm ? String(perm).split(',') : [],
          };
        }
        next();
      },
      requireRole('super_admin', 'accountant'),
      requirePermission('finance.view'),
      (_req, res) => res.json({ ok: true, ledger: [] })
    );

    miniApp.use(createErrorHandler());

    const srv = await new Promise((resolve) => {
      const s = miniApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${srv.address().port}`;

    try {
      // 1. CSRF rejection vs valid token acceptance
      const csrfRes = await httpRequest(url, '/api/csrf');
      const { token } = JSON.parse(csrfRes.body);
      assert.ok(token.includes('.'));

      const badCsrf = await httpRequest(url, '/api/mutate', { method: 'POST', body: { a: '1' } });
      assert.equal(badCsrf.statusCode, 403);
      assert.equal(JSON.parse(badCsrf.body).error.code, 'CSRF_INVALID');

      const goodCsrf = await httpRequest(url, '/api/mutate', {
        method: 'POST',
        headers: { 'x-csrf-token': token },
        body: { a: '1' },
      });
      assert.equal(goodCsrf.statusCode, 200);

      // 2. Rate limiting (CGNAT-safe per IP+identifier)
      const r1 = await httpRequest(url, '/api/otp', { method: 'POST', body: { phone: '01711111111' } });
      const r2 = await httpRequest(url, '/api/otp', { method: 'POST', body: { phone: '01711111111' } });
      const r3 = await httpRequest(url, '/api/otp', { method: 'POST', body: { phone: '01711111111' } });
      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      assert.equal(r3.statusCode, 429);
      assert.equal(JSON.parse(r3.body).error.code, 'RATE_LIMITED');
      assert.ok(Number(r3.headers['retry-after']) >= 1);

      // Different phone behind same CGNAT IP is NOT unfairly blocked
      const otherSubscriber = await httpRequest(url, '/api/otp', {
        method: 'POST',
        body: { phone: '01822222222' },
      });
      assert.equal(otherSubscriber.statusCode, 200);

      // 3. Server-side RBAC
      const unauth = await httpRequest(url, '/api/admin/finance');
      assert.equal(unauth.statusCode, 401);

      const wrongRole = await httpRequest(url, '/api/admin/finance', {
        headers: { 'x-role': 'support_agent', 'x-perm': 'finance.view' },
      });
      assert.equal(wrongRole.statusCode, 403);

      const missingPerm = await httpRequest(url, '/api/admin/finance', {
        headers: { 'x-role': 'accountant', 'x-perm': 'orders.view' },
      });
      assert.equal(missingPerm.statusCode, 403);

      const authorizedAccountant = await httpRequest(url, '/api/admin/finance', {
        headers: { 'x-role': 'accountant', 'x-perm': 'finance.view' },
      });
      assert.equal(authorizedAccountant.statusCode, 200);

      const superAdminBypass = await httpRequest(url, '/api/admin/finance', {
        headers: { 'x-role': 'super_admin' },
      });
      assert.equal(superAdminBypass.statusCode, 200);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});

describe('Phase 03 — Existing Portal Regression & Health/Auth Integration', () => {
  let server;
  let baseUrl;

  before(async () => {
    cleanupTestDb();
    sqliteDb.initializeDatabase();

    // Ensure known hashed test admin user exists for end-to-end login test
    const hash = bcrypt.hashSync('Phase03StrongPassword!99', 10);
    const existing = sqliteDb.get(
      'SELECT id FROM users WHERE LOWER(email) = ?',
      'phase03admin@mrtumi.test'
    );
    if (!existing) {
      sqliteDb.run(
        'INSERT INTO users (name, email, phone, password_hash, role, status) VALUES (?, ?, ?, ?, ?, 1)',
        'Phase 03 Admin',
        'phase03admin@mrtumi.test',
        '01700000099',
        hash,
        'Super Admin'
      );
    }

    const { startServer } = require('../server');
    await new Promise((resolve) => {
      server = startServer(0, '127.0.0.1');
      server.once('listening', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
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

  test('Health, CSRF endpoint, API 404 JSON envelope, Storefront, and Admin login work end-to-end', async () => {
    const health = await httpRequest(baseUrl, '/health');
    assert.equal(health.statusCode, 200);
    const healthBody = JSON.parse(health.body);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.data.status, 'ok');
    assert.equal(healthBody.data.timezone, 'Asia/Dhaka');
    assert.equal(healthBody.data.currency, 'BDT');
    assert.ok(health.headers['x-request-id']);

    const csrfEndpoint = await httpRequest(baseUrl, '/api/v1/csrf-token');
    assert.equal(csrfEndpoint.statusCode, 200);
    assert.ok(JSON.parse(csrfEndpoint.body).data.csrfToken.length > 32);

    const api404 = await httpRequest(baseUrl, '/api/v1/unknown-endpoint');
    assert.equal(api404.statusCode, 404);
    assert.equal(JSON.parse(api404.body).error.code, 'NOT_FOUND');

    for (const route of ['/', '/all-products', '/flash-sales', '/track-order', '/vendor/login', '/reseller/login']) {
      const res = await httpRequest(baseUrl, route);
      assert.equal(res.statusCode, 200, `Expected 200 for ${route}`);
    }

    // Wrong password returns 401
    const badLogin = await httpRequest(baseUrl, '/admin/login', {
      method: 'POST',
      body: { email: 'phase03admin@mrtumi.test', password: 'WrongPassword' },
    });
    assert.equal(badLogin.statusCode, 401);

    // Valid password persists session via sessionRepository and redirects to /admin/dashboard
    const goodLogin = await httpRequest(baseUrl, '/admin/login', {
      method: 'POST',
      body: { email: 'phase03admin@mrtumi.test', password: 'Phase03StrongPassword!99' },
    });
    assert.equal(goodLogin.statusCode, 302);
    assert.match(goodLogin.headers.location || '', /^\/admin\/dashboard/);

    const rawCookie = Array.isArray(goodLogin.headers['set-cookie'])
      ? goodLogin.headers['set-cookie'][0]
      : goodLogin.headers['set-cookie'];
    const cookiePair = rawCookie.split(';')[0];

    const dashboard = await httpRequest(baseUrl, '/admin/dashboard', {
      headers: { Cookie: cookiePair },
    });
    assert.equal(dashboard.statusCode, 200);
  });
});
