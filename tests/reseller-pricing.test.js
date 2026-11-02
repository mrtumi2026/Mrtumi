'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateResellerPricing, MODES } = require('../src/services/resellerPricing');
const { splitSqlStatements, loadMigrationPairs } = require('../src/db/migrator');

const calc = (overrides = {}) => calculateResellerPricing({
  mode: MODES.RESELLER, quantity: 1, officialUnitPricePaisa: 60000,
  resellerSellingUnitPaisa: 65000, vendorEntitlementUnitPaisa: 50000,
  platformFeeUnitPaisa: 3000, adjustmentUnitPaisa: 0, ...overrides,
});

test('reseller-set-price calculation keeps fee and vendor entitlement separate', () => {
  const result = calc({ quantity: 2 });
  assert.equal(result.productAmountPaisa, 130000);
  assert.equal(result.vendorEntitlementPaisa, 100000);
  assert.equal(result.platformFeePaisa, 6000);
  assert.equal(result.resellerEarningPaisa, 24000);
});

test('marketplace-official mode fixes customer price and derives configured commission', () => {
  const result = calc({ mode: MODES.OFFICIAL, resellerSellingUnitPaisa: 90000, resellerCommissionBps: 833 });
  assert.equal(result.customerUnitPricePaisa, 60000);
  assert.equal(result.resellerCommissionPaisa, 4998);
  assert.equal(result.platformRevenuePaisa, 2002);
});

test('pricing rejects below-entitlement prices, negative profit and out-of-range values', () => {
  assert.throws(() => calc({ resellerSellingUnitPaisa: 49999 }), /below the vendor entitlement/);
  assert.throws(() => calc({ resellerSellingUnitPaisa: 51000 }), /negative reseller earning/);
  assert.throws(() => calc({ resellerSellingUnitPaisa: 65000, minimumSellingUnitPaisa: 66000 }), /outside the configured range/);
  assert.throws(() => calc({ mode: MODES.OFFICIAL, resellerCommissionBps: 9000 }), /does not cover/);
});

test('pricing guards integers, quantity and overflow', () => {
  assert.throws(() => calc({ quantity: 0 }), /Quantity/);
  assert.throws(() => calc({ resellerSellingUnitPaisa: 10.5 }), /valid non-negative amount/);
  assert.throws(() => calc({ quantity: 100000, resellerSellingUnitPaisa: Number.MAX_SAFE_INTEGER }), /supported range/);
});

test('reseller schema migration is paired, versioned and SQL-splittable', () => {
  const files = loadMigrationPairs(path.join(__dirname, '..', 'src/db/migrations'));
  const migration = files.find((item) => item.version === '0021');
  assert.ok(migration);
  const statements = splitSqlStatements(migration.upSql);
  assert.ok(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS `reseller_order_price_snapshots`')));
  assert.ok(statements.some((sql) => sql.includes('CREATE TRIGGER `trg_reseller_price_snapshot_no_update`')));
  assert.match(migration.upSql, /UNIQUE KEY `uq_cod_collection_idempotency`/);
  assert.match(migration.upSql, /UNIQUE KEY `uq_vendor_sub_order_parent_vendor`/);
});
