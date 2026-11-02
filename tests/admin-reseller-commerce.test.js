'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { attachCsrfToken } = require('../src/middleware/csrf');
const adminRoutes = require('../src/routes/adminResellerCommerce');
const repo = require('../src/repositories/adminResellerCommerceRepository');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function fakePool({ settings = null, reseller = null, withdrawal = null, resellerBalance = 10000 } = {}) {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push(['BEGIN']); }, async commit() { calls.push(['COMMIT']); },
    async rollback() { calls.push(['ROLLBACK']); }, release() {},
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql.startsWith('SET TRANSACTION')) return [{ affectedRows: 0 }, []];
      if (sql.includes('FROM reseller_commerce_settings')) return [[settings || {
        id: 1, reseller_price_mode_enabled: 0, official_price_mode_enabled: 0, platform_fee_paisa: 0,
        platform_fee_type: 'fixed', platform_fee_bps: 0, minimum_price_paisa: 0, maximum_price_paisa: null,
        return_window_days: 7, official_commission_bps: 0,
      }], []];
      if (sql.includes('FROM resellers WHERE id=? FOR UPDATE')) return [[reseller || {
        id: 9, shop_name: 'Old Shop', logo_url: '', branding_status: 'pending', branding_review_note: '', verified: 0, status: 0,
      }], []];
      if (sql.includes('FROM reseller_transactions WHERE id=?')) return [[withdrawal || { id: 77, reseller_id: 9, amount_paisa: 7000, status: 'pending', tx_type: 'withdrawal' }], []];
      if (sql.includes('FROM partner_wallets WHERE reseller_id=?')) return [[{ available_balance: String(resellerBalance) }], []];
      if (sql.startsWith('SELECT')) return [[], []];
      return [{ affectedRows: 1, insertId: 77 }, []];
    },
  };
  return { calls, getConnection: async () => connection };
}

const admin = { id: 42, ip: '192.0.2.8', userAgent: 'test-agent/1.0' };

test('admin pricing settings validate fixed/percent modes and persist with actor/IP/user-agent audit in one transaction', async () => {
  const pool = fakePool();
  const result = await repo.updateCommerceSettings({
    reseller_price_mode_enabled: '1', official_price_mode_enabled: '0', platform_fee_type: 'percent',
    platform_fee_value: '2.50', minimum_price_bdt: '25.00', maximum_price_bdt: '900.00',
    return_window_days: '14', official_commission_bps: '1250',
  }, admin, { pool });
  assert.equal(result.platformFeeBps, 250);
  assert.equal(result.minimumPricePaisa, 2500);
  const update = pool.calls.find(([sql]) => sql.startsWith('UPDATE reseller_commerce_settings'));
  assert.ok(update);
  const audit = pool.calls.find(([sql]) => sql.includes('audit_logs'));
  assert.ok(audit);
  assert.deepEqual(audit[1].slice(0, 2), ['admin', 42]);
  assert.equal(audit[1][7], admin.ip);
  assert.equal(audit[1][8], admin.userAgent);
  assert.equal(pool.calls.at(-1)[0], 'COMMIT');
  assert.throws(() => repo.normalizeCommerceSettings({
    reseller_price_mode_enabled: '1', official_price_mode_enabled: '1', platform_fee_type: 'percent', platform_fee_value: '100.01',
    minimum_price_bdt: '10', return_window_days: '7', official_commission_bps: '0',
  }), { code: 'VALIDATION_ERROR' });
});

test('co-branding approval validates HTTPS, updates public brand fields, and records admin audit context', async () => {
  const pool = fakePool();
  const result = await repo.reviewBranding(9, { action: 'approve', shopName: 'New Shop', logoUrl: 'https://cdn.example.test/logo.png' }, admin, { pool });
  assert.equal(result.status, 'approved');
  const update = pool.calls.find(([sql]) => sql.startsWith('UPDATE resellers SET shop_name'));
  assert.ok(update);
  assert.equal(update[1][0], 'New Shop');
  assert.equal(update[1][1], 'https://cdn.example.test/logo.png');
  const audit = pool.calls.find(([sql]) => sql.includes('audit_logs'));
  assert.equal(audit[1][1], 42);
  assert.equal(audit[1][7], admin.ip);
  assert.equal(audit[1][8], admin.userAgent);
  assert.throws(() => repo.safeLogo('javascript:alert(1)'), { code: 'VALIDATION_ERROR' });
});

test('withdrawal approval atomically debits only available funds and rejects overdrafts', async () => {
  const pool = fakePool({ resellerBalance: 10000 });
  const result = await repo.decideWithdrawal({ partnerType: 'reseller', requestId: 77, decision: 'approve' }, admin, { pool });
  assert.equal(result.decision, 'approve');
  assert.ok(pool.calls.some(([sql, args]) => sql.startsWith('UPDATE partner_wallets SET available_balance=available_balance-?') && args[0] === 7000));
  assert.ok(pool.calls.some(([sql, args]) => sql.includes('INSERT INTO partner_transactions') && args[1] === 'withdrawal:reseller:77' && args[2] === -7000));
  assert.equal(pool.calls.at(-1)[0], 'COMMIT');
  const audit = pool.calls.find(([sql]) => sql.includes('audit_logs'));
  assert.equal(audit[1][7], admin.ip);
  assert.equal(audit[1][8], admin.userAgent);

  const insufficient = fakePool({ resellerBalance: 6999 });
  await assert.rejects(repo.decideWithdrawal({ partnerType: 'reseller', requestId: 77, decision: 'approve' }, admin, { pool: insufficient }), { code: 'CONFLICT' });
  assert.equal(insufficient.calls.some(([sql]) => sql.startsWith('UPDATE partner_wallets SET available_balance=available_balance-?')), false);
  assert.equal(insufficient.calls.at(-1)[0], 'ROLLBACK');
});

test('withdrawal UNION ordering and masking use aliases defined by the first SELECT', () => {
  const source = read('src/repositories/adminResellerCommerceRepository.js');
  const start = source.indexOf('async function listWithdrawalRequests');
  const end = source.indexOf('async function decideWithdrawal', start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /vw\.id AS id/);
  assert.match(implementation, /rt\.id AS id/);
  assert.match(implementation, /AS destination/);
  assert.match(implementation, /ORDER BY created_at ASC,id ASC LIMIT 300/);
  assert.doesNotMatch(implementation, /request_id|masked_account/);
});

test('HTTP router gates every write with CSRF, admin permission, audits and is mounted with a sidebar entry', async () => {
  const route = read('src/routes/adminResellerCommerce.js');
  assert.match(route, /router\.use\('\/admin\/reseller-commerce', requireAdmin, requirePermission\('resellers\.manage'\)\)/);
  assert.match(route, /const write = \(handler\) => \[requireCsrf, asyncHandler\(handler\)\]/);
  assert.match(route, /settlements\/release-matured/);
  assert.match(read('server.js'), /app\.use\(adminResellerCommerceRoutes\)/);
  assert.match(read('views/admin/partials/sidebar.ejs'), /href="\/admin\/reseller-commerce"/);
  assert.match(read('src/middleware/legacyAdminRbac.js'), /has\(path,'\/admin\/reseller-commerce'\)/);

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { adminUser: { id: 42, role_slug: 'staff', permissions: ['resellers.manage'] }, _csrfNonce: 'http-test-nonce' };
    req.sessionID = 'http-test-session';
    req.adminUser = req.session.adminUser;
    res.locals.adminUser = req.adminUser;
    next();
  });
  app.use(attachCsrfToken);
  app.use(adminRoutes);
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).send(err.code || 'error'));
  const server = app.listen(0, '127.0.0.1');
  try {
    const port = await new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, path: '/admin/reseller-commerce/settings', method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '0' } }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(response.status, 403);
    assert.match(response.body, /CSRF_INVALID/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
