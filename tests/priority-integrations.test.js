'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMigrationPairs } = require('../src/db/migrator');

const root = path.join(__dirname, '..');

test('priority integrations migration defines storefront and credential fields with reversible schema changes', () => {
  const pair = loadMigrationPairs().find((item) => item.version === '0014');
  assert.ok(pair, '0014 migration pair must load');
  const base = fs.readFileSync(path.join(root, 'src/db/migrations/0003_orders_payments_and_operations.up.sql'), 'utf8');
  for (const field of ['badge', 'created_at', 'image_url', 'link_url', 'sort_order', 'status']) assert.match(pair.upSql + base, new RegExp('`' + field + '`'));
  for (const field of ['gateway_type', 'account_number', 'api_key', 'secret_key', 'instructions', 'sandbox', 'updated_at']) assert.match(pair.upSql + fs.readFileSync(path.join(root, 'src/db/migrations/0003_orders_payments_and_operations.up.sql'), 'utf8'), new RegExp('`' + field + '`'));
  for (const field of ['base_url', 'api_key', 'secret_key', 'sandbox', 'status', 'updated_at']) assert.match(pair.upSql + fs.readFileSync(path.join(root, 'src/db/migrations/0003_orders_payments_and_operations.up.sql'), 'utf8'), new RegExp('`' + field + '`'));
  assert.match(pair.downSql, /DROP COLUMN `badge`/);
  const clientIdMigration = loadMigrationPairs().find((item) => item.version === '0015');
  assert.ok(clientIdMigration, '0015 migration pair must load');
  assert.match(clientIdMigration.upSql, /`client_id`/);
  assert.match(clientIdMigration.downSql, /DROP COLUMN `client_id`/);
});

test('priority settings routes use asynchronous MySQL operations and retain SQLite fallback paths', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/adminSettings.js'), 'utf8');
  assert.match(source, /integrationsClient\(\)\.queryAll\('SELECT id,title,subtitle,badge,position,image_url AS image,link_url AS link/);
  assert.match(source, /integrationsClient\(\)\.execute\('INSERT INTO banners/);
  assert.match(source, /upload\.single\('image_file'\)/);
  assert.match(source, /upload\.validateUploadedImageFile/);
  assert.match(source, /router\.post\('\/admin\/banner\/update\/:id'/);
  assert.match(source, /router\.post\('\/admin\/paymentgeteway\/update\/:id'/);
  assert.match(source, /router\.post\('\/admin\/courierapi\/update\/:id'/);
  assert.match(source, /WHERE gateway_type=\?/);
  assert.match(source, /INSERT INTO courier_apis \(name,code,base_url,api_key,secret_key,client_id,status,sandbox\)/);
  assert.match(source, /db\.all\('SELECT \* FROM banners/);
  const checkout = fs.readFileSync(path.join(root, 'src/repositories/checkoutRepository.js'), 'utf8');
  assert.match(checkout, /gateway_type='manual'/);
  assert.match(checkout, /payment_method,payment_status/);
  const checkoutView = fs.readFileSync(path.join(root, 'views/store/checkout.ejs'), 'utf8');
  assert.match(checkoutView, /gateways\.forEach/);
  const crudView = fs.readFileSync(path.join(root, 'views/admin/crud-module.ejs'), 'utf8');
  assert.match(crudView, /data-record='/);
  assert.match(crudView, /id="crudEditModal"/);
  assert.match(crudView, /bootstrap\.Modal\.getOrCreateInstance\(editModal\)\.show\(\)/);
});

test('dashboard provider widgets return graceful HTTP 200 unconfigured payloads asynchronously', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/adminDashboard.js'), 'utf8');
  assert.match(source, /success: true, configured: false, balance: 0, message/);
  assert.match(source, /API credentials not yet configured/);
  for (const route of ['/admin/smsgeteway/balance', '/admin/bdcourier/my-plan', '/admin/steadfast/dashboard-widget']) {
    assert.ok(source.includes(route));
  }
  assert.doesNotMatch(source, /res\.status\(503\)/);
});
