'use strict';

process.env.DB_CLIENT = 'mysql';
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('../src/db/mysqlPool');
const { loadMigrationPairs } = require('../src/db/migrator');
const courier = require('../src/repositories/courierCodRepository');
const settlement = require('../src/repositories/partnerSettlementRepository');
const reversals = require('../src/repositories/financialReversalRepository');
const vendorOrders = require('../src/repositories/vendorOrderRepository');

function withFakeTransaction(t, tx) {
  const original = mysql.withTransaction;
  mysql.withTransaction = async (work) => work(tx);
  t.after(() => { mysql.withTransaction = original; });
}

test('migration supplies COD reconciliation, sub-order, wallet and immutable snapshot ledger columns', () => {
  const migration = loadMigrationPairs().find((pair) => pair.version === '0023');
  assert.ok(migration);
  for (const token of ['courier_cod_collections', 'collected_amount_paisa', 'net_remitted_paisa', 'bank_trans_ref',
    'vendor_sub_orders', 'cod_due_paisa', 'order_status_history', 'vendor_order_status_history', 'partner_wallets', 'vendor_wallets', 'partner_transactions',
    'vendor_transactions', 'order_price_snapshots', 'financial_reversals']) assert.ok(migration.upSql.includes(token), token);
  assert.match(migration.upSql, /trg_order_price_snapshot_no_delete/);
  assert.match(migration.upSql, /trg_order_price_snapshot_no_update/);
});

test('COD collection reconciles exact collection, records discrepancy shortfall and pays only after all COD shipments reconcile', async (t) => {
  const executed = [];
  let collection = null;
  let aggregate = { shipment_count: 1, reconciled_count: 1, due_paisa: 10000, collected_paisa: 10000 };
  const tx = {
    async queryOne(sql) {
      if (sql.includes('shipment_count')) return aggregate;
      if (sql.includes('FROM fulfillment_shipments fs') && sql.includes('JOIN vendor_sub_orders')) return {
        id: 12, vendor_sub_order_id: 7, cod_due_paisa: 10000, courier_code: 'steadfast', tracking_id: 'CN-7',
        order_id: 4, total_paisa: 10000, order_cod_due_paisa: 10000, payment_method: 'cod', payment_status: 'unpaid',
      };
      if (sql.includes('FROM courier_cod_collections WHERE shipment_id=')) return collection;
      if (sql.includes('SELECT COUNT(*) AS n FROM vendor_sub_orders')) return { n: 0 };
      return null;
    },
    async execute(sql, params) {
      executed.push({ sql, params });
      if (sql.startsWith('INSERT INTO courier_cod_collections')) collection = { id: 19, reconciliation_status: params[12], collected_amount_paisa: params[4] };
      if (sql.startsWith('UPDATE courier_cod_collections')) collection = { id: 19, reconciliation_status: params[10], collected_amount_paisa: params[2] };
      return { insertId: 19, affectedRows: 1 };
    },
  };
  withFakeTransaction(t, tx);
  aggregate = { shipment_count: 1, reconciled_count: 1, due_paisa: 10000, collected_paisa: 10000 };
  const matched = await courier.reconcileCourierCollection({ shipmentId: 12, collectedAmountPaisa: 10000,
    remittanceRef: 'REM-1', bankTransRef: 'BANK-1', courierName: 'Steadfast', consignmentId: 'CN-7', actor: { id: 3 } });
  assert.equal(matched.status, 'reconciled');
  assert.equal(matched.orderPaid, true);
  assert.ok(executed.some(({ sql }) => sql.includes("UPDATE orders SET payment_status='paid'")));
  assert.equal(collection.reconciliation_status, 'reconciled');

  collection = null;
  executed.length = 0;
  aggregate = { shipment_count: 1, reconciled_count: 1, due_paisa: 10000, collected_paisa: 7000 };
  const shortfall = await courier.reconcileCourierCollection({ shipmentId: 12, collectedAmountPaisa: 7000,
    remittanceRef: 'REM-SHORT', actor: { id: 3 } });
  assert.equal(shortfall.status, 'discrepancy');
  assert.equal(shortfall.orderPaid, false);
  assert.ok(!executed.some(({ sql }) => sql.includes("UPDATE orders SET payment_status='paid'")));
});

test('vendor sub-orders enforce independent forward transitions and documented terminal/return paths', () => {
  assert.deepEqual(vendorOrders.TRANSITIONS.order_placed, ['vendor_accepted', 'cancelled']);
  assert.ok(vendorOrders.TRANSITIONS.in_transit.includes('delivered'));
  assert.ok(vendorOrders.TRANSITIONS.delivered.includes('return_requested'));
  assert.ok(vendorOrders.TRANSITIONS.return_requested.includes('returned'));
  assert.deepEqual(vendorOrders.TRANSITIONS.cancelled, []);
});

test('a delivered vendor sub-order enters pending settlement without waiting for a delayed sibling', async (t) => {
  const calls = [];
  const tx = {
    async queryOne(sql) {
      if (sql.includes('SELECT so.*,o.order_status')) return { id: 7, order_id: 2, vendor_id: 8, status: 'in_transit', parent_status: 'processing', payment_method: 'cod', payment_status: 'unpaid', cod_due_paisa: 500 };
      if (sql.includes('FROM fulfillment_shipments WHERE vendor_sub_order_id')) return { id: 12 };
      if (sql.includes('snapshot_vendor_paisa')) return { id: 7, order_id: 2, vendor_id: 8, status: 'delivered', vendor_entitlement_paisa: 500, marketplace_fee_paisa: 0, reseller_id: null, snapshot_vendor_paisa: 500, reseller_paisa: 0, marketplace_paisa: 0 };
      if (sql.includes('FROM vendor_transactions WHERE idempotency_key')) return null;
      if (sql.includes('COUNT(*) AS n FROM vendor_sub_orders')) return { n: 1 };
      return null;
    },
    async execute(sql, params = []) { calls.push({ sql, params }); return { insertId: 1, affectedRows: 1 }; },
  };
  withFakeTransaction(t, tx);
  const result = await vendorOrders.transitionSubOrder({ subOrderId: 7, toStatus: 'delivered', actor: { vendorId: 8 } });
  assert.equal(result.to, 'delivered');
  assert.ok(calls.some(({ sql }) => sql.includes('UPDATE vendor_wallets SET pending_settlement=pending_settlement+')));
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO order_status_history(order_id,vendor_sub_order_id')));
  assert.ok(!calls.some(({ sql }) => sql.includes("UPDATE orders SET order_status='delivered'")), 'the delayed sibling keeps the parent order open');
});

test('matured settlement release is idempotent across repeated runs', async (t) => {
  const partner = { pending: 0, available: 0 };
  const vendor = { pending: 0, available: 0 };
  const partnerLedger = new Map();
  const vendorLedger = new Map();
  const marketplaceLedger = new Map();
  const tx = {
    async queryAll(sql) {
      if (sql.includes('SELECT so.id FROM vendor_sub_orders')) return [{ id: 7 }];
      return [];
    },
    async queryOne(sql, params = []) {
      if (sql.includes('FROM vendor_sub_orders so') && sql.includes('snapshot_vendor_paisa')) return {
        id: 7, order_id: 2, vendor_id: 8, status: 'delivered', vendor_entitlement_paisa: 700,
        marketplace_fee_paisa: 100, reseller_id: 9, snapshot_vendor_paisa: 700, reseller_paisa: 300, marketplace_paisa: 100,
      };
      if (sql.includes('FROM partner_transactions') && sql.includes('idempotency_key')) return partnerLedger.get(params[0]) || null;
      if (sql.includes('FROM vendor_transactions') && sql.includes('idempotency_key')) return vendorLedger.get(params[0]) || null;
      if (sql.includes('FROM marketplace_revenue_ledger')) return marketplaceLedger.get(params[0]) || null;
      if (sql.includes('FROM partner_wallets')) return { pending_balance: partner.pending };
      if (sql.includes('FROM vendor_wallets')) return { pending_settlement: vendor.pending };
      return null;
    },
    async execute(sql, params = []) {
      if (sql.includes('UPDATE partner_wallets SET pending_balance=pending_balance+')) partner.pending += Number(params[0]);
      if (sql.includes('UPDATE vendor_wallets SET pending_settlement=pending_settlement+')) vendor.pending += Number(params[0]);
      if (sql.includes('UPDATE partner_wallets SET pending_balance=pending_balance-')) { partner.pending -= Number(params[0]); partner.available += Number(params[1]); }
      if (sql.includes('UPDATE vendor_wallets SET pending_settlement=pending_settlement-')) { vendor.pending -= Number(params[0]); vendor.available += Number(params[1]); }
      if (sql.includes('INSERT INTO partner_transactions')) partnerLedger.set(params[2], { id: 1, amount_paisa: Number(params[3]) });
      if (sql.includes('INSERT INTO vendor_transactions')) vendorLedger.set(params[2], { id: 1, amount_paisa: Number(params[3]) });
      if (sql.includes('INSERT INTO marketplace_revenue_ledger')) marketplaceLedger.set(params[1], { id: 1, amount_paisa: Number(params[2]) });
      return { insertId: 1, affectedRows: 1 };
    },
  };
  withFakeTransaction(t, tx);
  const first = await settlement.processMaturedSettlements({ returnWindowDays: 7, actor: { id: 1 } });
  const second = await settlement.processMaturedSettlements({ returnWindowDays: 7, actor: { id: 1 } });
  assert.equal(first.releasedCount, 1);
  assert.equal(second.releasedCount, 0);
  assert.deepEqual(partner, { pending: 0, available: 300 });
  assert.deepEqual(vendor, { pending: 0, available: 700 });
  assert.equal(partnerLedger.get('settle:reseller:7').amount_paisa, 300);
  assert.equal(vendorLedger.get('settle:vendor:7').amount_paisa, 700);
  assert.equal(marketplaceLedger.get('settle:marketplace:7').amount_paisa, 100);
});

test('partial item return reverses only the selected item snapshot and consumes pending wallet funds first', async (t) => {
  const calls = [];
  const tx = {
    async queryOne(sql, params = []) {
      if (sql.includes('FROM financial_reversals WHERE idempotency_key')) return null;
      if (sql.includes('FROM order_items oi') && sql.includes('order_price_snapshots')) return {
        id: 41, order_id: 2, qty: 3, vendor_id: 8, reseller_id: 9, snapshot_vendor_id: 8, snapshot_reseller_id: 9,
        vendor_entitlement_unit_paisa: 100, reseller_margin_unit_paisa: 40, vendor_sub_order_id: 7,
      };
      if (sql.includes('SUM(quantity) AS reversed_qty')) return { reversed_qty: 0 };
      if (sql.includes("FROM partner_transactions WHERE sub_order_id")) return { has_earning: 1, released: 0 };
      if (sql.includes("FROM vendor_transactions WHERE sub_order_id")) return { has_earning: 1, released: 0 };
      if (sql.includes('FROM partner_wallets')) return { pending_balance: 10, available_balance: 100 };
      if (sql.includes('FROM vendor_wallets')) return { pending_settlement: 100, available_balance: 500 };
      return null;
    },
    async execute(sql, params = []) { calls.push({ sql, params }); return { insertId: 88, affectedRows: 1 }; },
  };
  withFakeTransaction(t, tx);
  const result = await reversals.reverseOrderItem({ orderItemId: 41, quantity: 1, reason: 'item_refund',
    idempotencyKey: 'refund:order-item:41:1', actor: { userId: 5 } });
  assert.equal(result.vendorAmountPaisa, 100);
  assert.equal(result.resellerAmountPaisa, 40);
  assert.equal(result.vendorWalletDebitedPaisa, 100);
  assert.equal(result.resellerWalletDebitedPaisa, 40);
  const partnerWalletUpdate = calls.find(({ sql }) => sql.includes('UPDATE partner_wallets SET pending_balance=pending_balance-'));
  assert.deepEqual(partnerWalletUpdate.params, [10, 30, 9]);
  const partnerLedger = calls.filter(({ sql }) => sql.includes('INSERT INTO partner_transactions'));
  assert.deepEqual(partnerLedger.map(({ params }) => Number(params[3])), [-10, -30]);
  assert.ok(calls.some(({ sql, params }) => sql.includes('financial_reversals') && params[0] === 41));
  assert.ok(!calls.some(({ params }) => params.includes(42)), 'unreturned sibling item was not mutated');
});
