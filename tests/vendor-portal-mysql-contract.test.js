'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const portal = require('../src/repositories/vendorPortalRepository');
const { loadMigrationPairs } = require('../src/db/migrator');
const root = path.join(__dirname, '..');

test('vendor portal MySQL migration adds vendor actor history without borrowing admin actor ids', () => {
  const migration = loadMigrationPairs().find(x => x.version === '0011');
  assert.ok(migration);
  assert.match(migration.upSql, /vendor_order_item_history/);
  assert.match(migration.upSql, /vendor_id/);
  assert.match(migration.upSql, /vendor_order_status_history/);
  assert.match(migration.downSql, /DROP COLUMN `fulfillment_status`/);
});

test('vendor fulfillment machine has only forward transitions and rejects unsupported states before DB access', async () => {
  assert.deepEqual(portal.NEXT, { pending: 'processing', processing: 'ready', ready: 'dispatched' });
  for (const target of ['pending','delivered','cancelled','']) assert.throws(() => portal.validateTransitionTarget(target), { code: 'VALIDATION_ERROR' });
  assert.equal(portal.validateTransitionTarget('dispatched'), 'dispatched');
  assert.equal(portal.paisa('15.25', 'price'), 1525);
  assert.equal(portal.paisa('1', 'price'), 100);
  assert.throws(() => portal.paisa('1.234', 'price'), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => portal.transitionOrderItem(1, 1, 'ready'), /requires MySQL/);
});

test('vendor repository queries enforce vendor ownership on product and order-item reads and writes', () => {
  const source = fs.readFileSync(path.join(root, 'src/repositories/vendorPortalRepository.js'), 'utf8');
  assert.match(source, /WHERE p\.vendor_id=\?/);
  assert.match(source, /WHERE i\.vendor_id=\?/);
  assert.match(source, /WHERE i\.id=\? AND i\.vendor_id=\?/);
  assert.match(source, /WHERE id=\? AND vendor_id=\?/);
  assert.match(source, /UPDATE order_items SET fulfillment_status=\? WHERE id=\? AND vendor_id=\? AND fulfillment_status=\?/);
  assert.match(source, /withTransaction\(/);
});

test('vendor route preserves CSRF and keeps legacy parent-order mutation fail-closed', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/vendorPanel.js'), 'utf8');
  assert.match(source, /router\.post\('\/vendor\/order-items\/:itemId\/fulfillment', requireCsrf/);
  assert.match(source, /router\.post\('\/vendor\/orders\/mark-ready\/:orderId', requireCsrf/);
  const legacy = source.slice(source.indexOf("router.post('/vendor/orders/mark-ready"));
  assert.match(legacy, /fail closed|বন্ধ রয়েছে/);
  assert.doesNotMatch(legacy, /UPDATE orders/);
});
