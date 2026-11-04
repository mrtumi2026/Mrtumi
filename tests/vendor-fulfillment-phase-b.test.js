'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMigrationPairs } = require('../src/db/migrator');
const repo = require('../src/repositories/vendorOrderRepository');
const bn = require('../src/i18n/locales/bn');
const en = require('../src/i18n/locales/en');
const root = path.join(__dirname, '..');

test('Phase B migration adds nullable delivery ownership and auditable booking/handover events without rewriting history', () => {
  const migration=loadMigrationPairs().find((pair)=>pair.version==='0027');
  assert.ok(migration);
  assert.match(migration.upSql,/ADD COLUMN `delivery_mode` VARCHAR\(24\) DEFAULT NULL/);
  assert.match(migration.upSql,/ADD COLUMN `booking_status` VARCHAR\(24\) DEFAULT NULL/);
  assert.match(migration.upSql,/MODIFY COLUMN `tracking_id` VARCHAR\(120\) DEFAULT NULL/);
  assert.match(migration.upSql,/CREATE TABLE IF NOT EXISTS `fulfillment_shipment_events`/);
  for(const column of ['event_type','actor_type','vendor_id','user_id','courier_code','tracking_reference','result_code','created_at'])assert.match(migration.upSql,new RegExp('`'+column+'`'));
  assert.match(migration.downSql,/DROP TABLE IF EXISTS `fulfillment_shipment_events`/);
  assert.match(migration.downSql,/DROP COLUMN `delivery_mode`/);
  assert.doesNotMatch(migration.upSql,/UPDATE `?(orders|order_items|vendor_sub_orders)`?/i);
});

test('Phase B only permits forward vendor preparation actions; transit and delivery require recorded privileged events', () => {
  assert.deepEqual(repo.TRANSITIONS.order_placed,['vendor_accepted','cancelled']);
  assert.deepEqual(repo.TRANSITIONS.vendor_accepted,['processing','cancelled']);
  assert.deepEqual(repo.TRANSITIONS.processing,['packed','cancelled']);
  assert.deepEqual(repo.TRANSITIONS.packed,['ready_for_pickup','cancelled']);
  assert.deepEqual(repo.TRANSITIONS.ready_for_pickup,[]);
  assert.ok(repo.TRANSITIONS.in_transit.includes('delivered'));
  assert.ok(repo.TRANSITIONS.failed_delivery.includes('ready_for_pickup'));
  assert.match(repo.transitionSubOrder.toString(),/Only an authorized platform administrator may confirm this shipment event/);
});

test('Vendor Panel presents separate localized parent/sub-order, booking, handover and legacy labels without raw status output', () => {
  const view=fs.readFileSync(path.join(root,'views/vendor/orders.ejs'),'utf8');
  assert.match(view,/orderStatus\.'\+String\(ol\.order_status/);
  assert.match(view,/vendorFulfillment\.'\+subKey/);
  assert.match(view,/ol\.booking_status/);
  assert.match(view,/ol\.picked_up_at/);
  assert.doesNotMatch(view,/<%=\s*ol\.(?:order_status|vendor_sub_order_status|fulfillment_status)\s*%>/);
  const repository=fs.readFileSync(path.join(root,'src/repositories/vendorOrderRepository.js'),'utf8');
  assert.doesNotMatch(repository,/UPDATE\s+order_items/i,'sub-order flow never mass-converts legacy item fulfillment records');
  for(const key of ['order_placed','vendor_accepted','processing','packed','ready_for_pickup','bookingSucceeded','bookingFailed','confirmHandover']){
    assert.ok(bn.vendorFulfillment[key],`Bangla label ${key}`);
    assert.ok(en.vendorFulfillment[key],`English label ${key}`);
  }
});

test('Vendor and admin shipment routes retain CSRF, vendor ownership, and orders.manage authorization', () => {
  const vendor=fs.readFileSync(path.join(root,'src/routes/vendorPanel.js'),'utf8');
  const admin=fs.readFileSync(path.join(root,'src/routes/adminOrders.js'),'utf8');
  assert.match(vendor,/\/vendor\/sub-orders\/:subOrderId\/booking-result', requireCsrf/);
  assert.match(vendor,/\/vendor\/sub-orders\/:subOrderId\/handover', requireCsrf/);
  assert.match(vendor,/actor:\{vendorId:req\.session\.vendorUser\.id\}/);
  assert.match(admin,/\/admin\/fulfillment\/sub-orders\/:subOrderId\/handover', requirePermission\('orders\.manage'\), requireCsrf/);
  assert.match(admin,/platformAdmin: true/);
});
