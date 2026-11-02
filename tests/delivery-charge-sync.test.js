'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { fallbackDeliveryLocations } = require('../src/repositories/checkoutRepository');

test('empty checkout delivery fallback uses current site settings and retains standard location labels', () => {
  const locations = fallbackDeliveryLocations({ inside_dhaka_charge: '75', outside_dhaka_charge: '135' });
  assert.deepEqual(locations.map(({ upazila, delivery_charge_paisa }) => [upazila, delivery_charge_paisa]), [
    ['ঢাকার ভিতরে (Inside Dhaka)', 7500],
    ['ঢাকার বাইরে (Outside Dhaka)', 13500],
    ['ঢাকা সাব-এরিয়া (Sub-Dhaka)', 8000],
  ]);
  assert.deepEqual(fallbackDeliveryLocations({}).map((location) => location.delivery_charge_paisa), [6000, 12000, 8000]);
});

test('delivery migration seeds the three standard areas idempotently', () => {
  const migration = read('src/db/migrations/0019_seed_default_delivery_locations.up.sql');
  for (const [division, district, label, paisa] of [
    ['Dhaka', 'Dhaka', 'ঢাকার ভিতরে (Inside Dhaka)', '6000'],
    ['All', 'All', 'ঢাকার বাইরে (Outside Dhaka)', '12000'],
    ['Sub-Dhaka', 'Gazipur/Savar/Narayanganj', 'ঢাকা সাব-এরিয়া (Sub-Dhaka)', '8000'],
  ]) {
    assert.ok(migration.includes(`'${division}','${district}','${label}',${paisa},1`));
  }
  assert.equal((migration.match(/WHERE NOT EXISTS/g) || []).length, 3);
});

test('admin shipping changes sync configured taka amounts to location paisa and quick order selects a default', () => {
  const route = read('src/routes/adminSettings.js');
  assert.match(route, /Math\.round\(amount \* 100\)/);
  assert.match(route, /UPDATE `delivery_locations` SET `delivery_charge_paisa` = \?/);
  assert.match(route, /syncDeliveryLocationCharges\(deliveryChargeUpdates\)/);
  const storefront = read('public/frontEnd/js/storefront.js');
  assert.match(storefront, /if \(locations\.length\) select\.value = String\(locations\[0\]\.id\)/);
  assert.match(storefront, /select\.dataset\.locationsLoaded = 'true';\s*window\.recalcQoTotal\(\);/);
});
