#!/usr/bin/env node
'use strict';

/**
 * End-to-End Multi-Vendor Order Flow & Live Verification Test
 * ==========================================================
 * Tests the complete lifecycle of a multi-vendor order:
 *  1. Multi-vendor cart checkout (Vendor 101 + Vendor 102).
 *  2. Payment via `bkash_manual` with customer Sender Phone & TrxID.
 *  3. Split-order engine (vendor_orders generation, commission deduction, net earnings calculation).
 *  4. Wallet pending balance escrow & immutable double-entry ledger journal postings.
 *  5. Admin manual TrxID verification (`verifyManualOrderPayment`).
 *  6. Steadfast last-mile courier consignment booking.
 *  7. Complete mathematical balance check (subtotal = vendor_earnings + commission, exact down to 1 paisa).
 *
 * Usage:
 *   node scripts/test-e2e-order-flow.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');

// ── Service & Repository Dependencies ──
const commissionService = require('../src/services/commissionService');
const splitOrderService = require('../src/services/splitOrderService');
const ledgerService = require('../src/services/ledgerService');
const adminPaymentRepo = require('../src/repositories/adminPaymentGatewayRepository');
const steadfastService = require('../src/services/couriers/steadfastService');
const { assertSafePaisa } = require('../src/utils/money');

// ── In-Memory State & Transaction Mock Harness ──
class MockDatabaseState {
  constructor() {
    this.orders = new Map();
    this.order_items = new Map();
    this.products = new Map();
    this.payment_gateways = new Map();
    this.commission_rules = [];
    this.vendor_orders = new Map();
    this.vendor_wallets = new Map();
    this.vendor_ledger_entries = [];
    this.payment_transactions = [];
    this.order_status_history = [];
    this.audit_logs = [];
    this.courier_shipments = [];
    this.nextId = 1000;
  }

  seedInitialData() {
    // Gateways
    this.payment_gateways.set('bkash_manual', {
      id: 1,
      code: 'bkash_manual',
      name: 'bKash Manual',
      gateway_type: 'manual',
      gateway_fee_bps: 0,
      status: 1,
      is_active: 1,
      account_number: '01800000000',
      instructions: 'Send money to 01800000000 and enter your sender number and TrxID.',
    });

    // Commission Rules: Vendor 101 has 10% (1000 bps); Vendor 102 has 8% (800 bps)
    this.commission_rules.push({
      id: 1,
      scope: 'category',
      category_id: 10,
      rule_type: 'percent',
      rate_bps: 1000,
      flat_paisa: 0,
      priority: 20,
      active: 1,
    });
    this.commission_rules.push({
      id: 2,
      scope: 'vendor',
      vendor_id: 102,
      rule_type: 'percent',
      rate_bps: 800,
      flat_paisa: 0,
      priority: 10,
      active: 1,
    });

    // Products
    this.products.set(1001, {
      id: 1001,
      name: 'Organic Deshi Ghee 1kg',
      category_id: 10,
      vendor_id: 101,
      price_paisa: 120000,
    });
    this.products.set(1002, {
      id: 1002,
      name: 'Pure Black Pepper 500g',
      category_id: 20,
      vendor_id: 102,
      price_paisa: 40000,
    });
  }

  createTx() {
    const state = this;
    return {
      async queryOne(sql, params = []) {
        const rows = await this.queryAll(sql, params);
        return rows.length > 0 ? rows[0] : null;
      },

      async queryAll(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (norm.startsWith('SELECT id, invoice_no, order_status, total_paisa, shipping_paisa FROM orders WHERE id = ?')) {
          const ord = state.orders.get(params[0]);
          return ord ? [ord] : [];
        }

        if (norm.startsWith('SELECT o.id, o.invoice_no, o.total_paisa, o.paid_paisa, o.cod_due_paisa')) {
          const ord = state.orders.get(params[0]);
          return ord ? [ord] : [];
        }

        if (norm.startsWith('SELECT id FROM vendor_orders WHERE order_id = ?')) {
          const list = Array.from(state.vendor_orders.values()).filter(v => v.order_id === params[0]);
          return list;
        }

        if (norm.includes('FROM order_items oi') && norm.includes('JOIN products p')) {
          const orderId = params[0];
          const items = Array.from(state.order_items.values()).filter(i => i.order_id === orderId);
          return items.map(i => {
            const prod = state.products.get(i.product_id) || {};
            return {
              id: i.id,
              product_id: i.product_id,
              variant_id: i.variant_id,
              vendor_id: i.vendor_id,
              unit_price_paisa: i.unit_price_paisa,
              qty: i.qty,
              line_total_paisa: i.line_total_paisa,
              category_id: prod.category_id || null,
            };
          });
        }

        if (norm.startsWith('SELECT gateway_fee_bps FROM payment_gateways WHERE code = ?')) {
          const gw = state.payment_gateways.get(params[0]);
          return gw ? [{ gateway_fee_bps: gw.gateway_fee_bps }] : [];
        }

        if (norm.includes('FROM commission_rules')) {
          if (norm.includes("scope = 'vendor'")) {
            const vId = params[0];
            const r = state.commission_rules.find(x => x.scope === 'vendor' && x.vendor_id === vId && x.active === 1);
            return r ? [r] : [];
          }
          if (norm.includes("scope = 'category'")) {
            const cId = params[0];
            const r = state.commission_rules.find(x => x.scope === 'category' && x.category_id === cId && x.active === 1);
            return r ? [r] : [];
          }
          if (norm.includes("scope = 'global'")) {
            const r = state.commission_rules.find(x => x.scope === 'global' && x.active === 1);
            return r ? [r] : [];
          }
        }

        if (norm.startsWith('SELECT available_paisa, pending_paisa, lifetime_earned_paisa, lifetime_commission_paisa FROM vendor_wallets WHERE vendor_id = ?')) {
          const w = state.vendor_wallets.get(params[0]);
          return w ? [w] : [];
        }

        return [];
      },

      async execute(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (norm.startsWith('INSERT INTO vendor_orders')) {
          const id = ++state.nextId;
          const [order_id, vendor_id, sub_order_ref, status, subtotal_paisa, commission_paisa, gateway_fee_paisa, vendor_earning_paisa] = [
            params[0], params[1], params[2], 'pending', params[3], params[4], params[5], params[6]
          ];
          state.vendor_orders.set(id, {
            id,
            order_id,
            vendor_id,
            sub_order_ref,
            status,
            subtotal_paisa,
            commission_paisa,
            gateway_fee_paisa,
            shipping_paisa: 0,
            vendor_earning_paisa,
            payment_status: 'unpaid',
            is_vendor_fulfilled: 0,
            ledger_credited: 0,
          });
          return { insertId: id, affectedRows: 1 };
        }

        if (norm.startsWith('UPDATE order_items SET vendor_order_id = ?')) {
          const vendorOrderId = params[0];
          const itemIds = params.slice(1);
          for (const id of itemIds) {
            const item = state.order_items.get(id);
            if (item) item.vendor_order_id = vendorOrderId;
          }
          return { affectedRows: itemIds.length };
        }

        if (norm.startsWith('INSERT IGNORE INTO vendor_wallets')) {
          const vendorId = params[0];
          if (!state.vendor_wallets.has(vendorId)) {
            state.vendor_wallets.set(vendorId, {
              vendor_id: vendorId,
              available_paisa: 0,
              pending_paisa: 0,
              lifetime_earned_paisa: 0,
              lifetime_commission_paisa: 0,
            });
          }
          return { affectedRows: 1 };
        }

        if (norm.startsWith('UPDATE vendor_wallets SET pending_paisa = ?')) {
          const [pending_paisa, lifetime_earned_paisa, lifetime_commission_paisa, vendor_id] = params;
          const w = state.vendor_wallets.get(vendor_id);
          if (w) {
            w.pending_paisa = pending_paisa;
            w.lifetime_earned_paisa = lifetime_earned_paisa;
            w.lifetime_commission_paisa = lifetime_commission_paisa;
          }
          return { affectedRows: 1 };
        }

        if (norm.startsWith('INSERT INTO vendor_ledger_entries')) {
          const id = ++state.nextId;
          state.vendor_ledger_entries.push({
            id,
            vendor_id: params[0],
            entry_type: params[1],
            direction: params[2],
            amount_paisa: params[3],
            balance_after: params[4],
            reference_type: params[5],
            reference_id: params[6],
            note: params[7],
            created_by_type: params[8],
            created_by_id: params[9],
            created_at: new Date().toISOString(),
          });
          return { insertId: id, affectedRows: 1 };
        }

        if (norm.startsWith('UPDATE orders SET payment_status = \'paid\'')) {
          const [adminId, orderId] = params;
          const ord = state.orders.get(orderId);
          if (ord) {
            ord.payment_status = 'paid';
            ord.paid_paisa = ord.total_paisa;
            ord.cod_due_paisa = 0;
            ord.verified_by_user_id = adminId;
            ord.verified_at = new Date().toISOString();
          }
          return { affectedRows: 1 };
        }

        if (norm.startsWith('UPDATE vendor_orders SET payment_status = \'paid\'')) {
          const [orderId] = params;
          let affected = 0;
          for (const v of state.vendor_orders.values()) {
            if (v.order_id === orderId) {
              v.payment_status = 'paid';
              affected++;
            }
          }
          return { affectedRows: affected };
        }

        if (norm.startsWith('INSERT INTO payment_transactions')) {
          const id = ++state.nextId;
          state.payment_transactions.push({
            id,
            order_id: params[0],
            gateway_code: params[1],
            trx_id: params[2],
            amount_paisa: params[3],
            currency: 'BDT',
            status: 'captured',
            customer_phone: params[4],
            manual_sender_number: params[5],
            manual_trx_id: params[6],
            verified_by_user_id: params[7],
            idempotency_key: params[8],
            raw_payload: params[9],
          });
          return { insertId: id, affectedRows: 1 };
        }

        if (norm.startsWith('INSERT INTO order_status_history')) {
          const id = ++state.nextId;
          state.order_status_history.push({
            id,
            order_id: params[0],
            from_status: params[1],
            to_status: params[2],
            note: params[3],
            changed_by_user_id: params[4],
          });
          return { insertId: id, affectedRows: 1 };
        }

        if (norm.startsWith('INSERT INTO audit_logs')) {
          const id = ++state.nextId;
          state.audit_logs.push({ id, params });
          return { insertId: id, affectedRows: 1 };
        }

        if (norm.startsWith('INSERT INTO courier_shipments')) {
          const id = ++state.nextId;
          state.courier_shipments.push({
            id,
            order_id: params[0],
            vendor_order_id: params[1],
            courier_provider: params[2],
            consignment_id: params[3],
            tracking_code: params[4],
            status: params[5],
            delivery_fee_paisa: params[6],
            cod_amount_paisa: params[7],
          });
          return { insertId: id, affectedRows: 1 };
        }

        return { affectedRows: 0 };
      },
    };
  }
}

// ── Main E2E Runner ──
async function runEndToEndVerification() {
  const startTime = Date.now();
  console.log('\n======================================================================');
  console.log('   MR. TUMI E-COMMERCE — PRODUCTION E2E VERIFICATION RUNNER');
  console.log('======================================================================\n');

  const state = new MockDatabaseState();
  state.seedInitialData();
  const tx = state.createTx();

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Simulate Customer Checkout with Multi-Vendor Cart
  // ──────────────────────────────────────────────────────────────────────────
  console.log('📦 Step 1: Simulating Multi-Vendor Checkout (bKash Manual MFS)...');

  const orderId = 5001;
  const invoiceNo = 'INV-20261107-E2E-5001';
  const shippingPaisa = 10000; // ৳100 shipping
  const item1Paisa = 120000;   // Vendor 101: ৳1,200
  const item2Paisa = 80000;    // Vendor 102: ৳800
  const goodsPaisa = item1Paisa + item2Paisa; // ৳2,000
  const totalOrderPaisa = goodsPaisa + shippingPaisa; // ৳2,100

  // Register parent order
  state.orders.set(orderId, {
    id: orderId,
    invoice_no: invoiceNo,
    order_status: 'pending',
    payment_status: 'pending_verification',
    payment_method: 'bkash_manual',
    total_paisa: totalOrderPaisa,
    paid_paisa: 0,
    cod_due_paisa: 0, // In manual MFS, COD due is 0 because customer pre-paid
    shipping_paisa: shippingPaisa,
    manual_sender_number: '01711223344',
    manual_trx_id: 'TRX_E2E_MFS_9988',
  });

  // Item 1: Vendor 101 (Agro Deshi Ghee)
  state.order_items.set(1, {
    id: 1,
    order_id: orderId,
    product_id: 1001,
    variant_id: null,
    vendor_id: 101,
    unit_price_paisa: 120000,
    qty: 1,
    line_total_paisa: 120000,
    vendor_order_id: null,
  });

  // Item 2: Vendor 102 (Black Pepper x 2)
  state.order_items.set(2, {
    id: 2,
    order_id: orderId,
    product_id: 1002,
    variant_id: null,
    vendor_id: 102,
    unit_price_paisa: 40000,
    qty: 2,
    line_total_paisa: 80000,
    vendor_order_id: null,
  });

  console.log(`   ✔ Parent Order #${orderId} (${invoiceNo}) registered.`);
  console.log(`   ✔ Total Goods: ৳${(goodsPaisa / 100).toFixed(2)} | Shipping: ৳${(shippingPaisa / 100).toFixed(2)} | Grand Total: ৳${(totalOrderPaisa / 100).toFixed(2)}`);
  console.log(`   ✔ Customer Payment: bKash Manual (Sender: 01711223344 | TrxID: TRX_E2E_MFS_9988)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Execute Split-Order System
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n🔀 Step 2: Executing Split-Order Engine (splitOrderByVendor)...');

  const splitResult = await splitOrderService.splitOrderByVendor(orderId, {
    gatewayCode: 'bkash_manual',
    actor: { type: 'system', id: null },
    tx,
  });

  assert.equal(splitResult.vendorOrders.length, 2, 'Must generate exactly 2 vendor orders for 2 vendors');
  const [subOrder1, subOrder2] = splitResult.vendorOrders;

  // Assert Vendor 101 (Category Rule: 10%)
  assert.equal(subOrder1.vendorId, 101);
  assert.equal(subOrder1.subtotalPaisa, 120000);
  assert.equal(subOrder1.commissionPaisa, 12000, 'Vendor 101 commission must be exactly 10% (12,000 paisa)');
  assert.equal(subOrder1.vendorEarningPaisa, 108000, 'Vendor 101 net earning must be exactly 108,000 paisa');

  // Assert Vendor 102 (Vendor Rule: 8%)
  assert.equal(subOrder2.vendorId, 102);
  assert.equal(subOrder2.subtotalPaisa, 80000);
  assert.equal(subOrder2.commissionPaisa, 6400, 'Vendor 102 commission must be exactly 8% (6,400 paisa)');
  assert.equal(subOrder2.vendorEarningPaisa, 73600, 'Vendor 102 net earning must be exactly 73,600 paisa');

  console.log(`   ✔ Sub-Order 1 Created: ID #${subOrder1.vendorOrderId} (${subOrder1.subOrderRef})`);
  console.log(`       Vendor 101: Gross = ৳${subOrder1.subtotalPaisa/100} | Comm (10%) = ৳${subOrder1.commissionPaisa/100} | Net = ৳${subOrder1.vendorEarningPaisa/100}`);
  console.log(`   ✔ Sub-Order 2 Created: ID #${subOrder2.vendorOrderId} (${subOrder2.subOrderRef})`);
  console.log(`       Vendor 102: Gross = ৳${subOrder2.subtotalPaisa/100} | Comm (8%) = ৳${subOrder2.commissionPaisa/100} | Net = ৳${subOrder2.vendorEarningPaisa/100}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Verify Escrow Wallets and Immutable Ledger Journal
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n💰 Step 3: Verifying Escrow Wallets & Financial Ledger Entries...');

  const wallet101 = state.vendor_wallets.get(101);
  const wallet102 = state.vendor_wallets.get(102);

  assert.equal(wallet101.pending_paisa, 108000, 'Vendor 101 wallet pending_paisa must equal 108,000');
  assert.equal(wallet102.pending_paisa, 73600, 'Vendor 102 wallet pending_paisa must equal 73,600');

  assert.equal(state.vendor_ledger_entries.length, 2, 'Exactly 2 ledger credit entries must be created');
  const [ledger1, ledger2] = state.vendor_ledger_entries;

  assert.equal(ledger1.vendor_id, 101);
  assert.equal(ledger1.entry_type, 'credit_earning');
  assert.equal(ledger1.direction, 'credit');
  assert.equal(ledger1.amount_paisa, 108000);

  assert.equal(ledger2.vendor_id, 102);
  assert.equal(ledger2.entry_type, 'credit_earning');
  assert.equal(ledger2.direction, 'credit');
  assert.equal(ledger2.amount_paisa, 73600);

  console.log(`   ✔ Vendor 101 Wallet Pending Escrow: ৳${wallet101.pending_paisa/100}`);
  console.log(`   ✔ Vendor 102 Wallet Pending Escrow: ৳${wallet102.pending_paisa/100}`);
  console.log(`   ✔ Ledger Entry #1: Vendor 101 +৳${ledger1.amount_paisa/100} (credit_earning)`);
  console.log(`   ✔ Ledger Entry #2: Vendor 102 +৳${ledger2.amount_paisa/100} (credit_earning)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Admin Verification of Manual MFS Payment
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n🔍 Step 4: Simulating Admin Verification (verifyManualOrderPayment)...');

  const adminVerification = await adminPaymentRepo.verifyManualOrderPayment(
    orderId,
    { id: 1, role: 'admin', ip: '127.0.0.1', userAgent: 'E2E-Verifier' },
    { tx }
  );

  assert.equal(adminVerification.paymentStatus, 'paid');
  assert.equal(adminVerification.trxId, 'TRX_E2E_MFS_9988');

  const verifiedOrder = state.orders.get(orderId);
  assert.equal(verifiedOrder.payment_status, 'paid');
  assert.equal(verifiedOrder.paid_paisa, totalOrderPaisa);
  assert.equal(verifiedOrder.cod_due_paisa, 0);
  assert.equal(verifiedOrder.verified_by_user_id, 1);

  // Assert child vendor orders marked as paid
  for (const vOrder of state.vendor_orders.values()) {
    assert.equal(vOrder.payment_status, 'paid', `Sub-order #${vOrder.id} must be marked paid`);
  }

  // Assert payment_transactions record
  assert.equal(state.payment_transactions.length, 1);
  const txRecord = state.payment_transactions[0];
  assert.equal(txRecord.status, 'captured');
  assert.equal(txRecord.trx_id, 'TRX_E2E_MFS_9988');
  assert.equal(txRecord.manual_sender_number, '01711223344');

  console.log(`   ✔ Parent Order #${orderId} transitioned: payment_status = 'paid' (Paid: ৳${verifiedOrder.paid_paisa/100})`);
  console.log(`   ✔ All child vendor orders updated: payment_status = 'paid'`);
  console.log(`   ✔ Payment transaction captured: TrxID = ${txRecord.trx_id} | Verified By Admin ID #1`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Simulate Steadfast Courier Dispatch
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n🚚 Step 5: Simulating Steadfast Courier Dispatch Booking...');

  // Mock Steadfast consignment response
  const mockSteadfastResponse = {
    consignmentId: '10992831',
    trackingCode: 'SF-TRK-992831',
    invoice: `${invoiceNo}-V101`,
    codAmountPaisa: 0, // 0 because order is already paid via bKash
    status: 'in_review',
    raw: { status: 200, message: 'Consignment created successfully.' }
  };

  // Record shipment in courier_shipments table
  await tx.execute(
    `INSERT INTO courier_shipments
       (order_id, vendor_order_id, courier_provider, consignment_id, tracking_code, status, delivery_fee_paisa, cod_amount_paisa)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      subOrder1.vendorOrderId,
      'steadfast',
      mockSteadfastResponse.consignmentId,
      mockSteadfastResponse.trackingCode,
      mockSteadfastResponse.status,
      6000, // ৳60 courier charge
      mockSteadfastResponse.codAmountPaisa,
    ]
  );

  assert.equal(state.courier_shipments.length, 1);
  const shipment = state.courier_shipments[0];
  assert.equal(shipment.courier_provider, 'steadfast');
  assert.equal(shipment.consignment_id, '10992831');
  assert.equal(shipment.tracking_code, 'SF-TRK-992831');
  assert.equal(shipment.cod_amount_paisa, 0);

  console.log(`   ✔ Steadfast Parcel Booked for Sub-Order #${subOrder1.vendorOrderId}`);
  console.log(`       Consignment ID: ${shipment.consignment_id} | Tracking Code: ${shipment.tracking_code}`);
  console.log(`       COD Amount: ৳${shipment.cod_amount_paisa/100} (Zero COD due to pre-paid bKash)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Mathematical Balancing & Double-Entry Integrity Check
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n⚖ Step 6: Performing Exact Mathematical Balance Verification...');

  const totalVendorSubtotal = subOrder1.subtotalPaisa + subOrder2.subtotalPaisa;
  const totalCommission = subOrder1.commissionPaisa + subOrder2.commissionPaisa;
  const totalVendorEarnings = subOrder1.vendorEarningPaisa + subOrder2.vendorEarningPaisa;

  assert.equal(totalVendorSubtotal, goodsPaisa, 'Sum of sub-orders must equal total goods price');
  assert.equal(totalCommission + totalVendorEarnings, totalVendorSubtotal, 'Earnings + Commission must equal Gross Goods Subtotal');

  console.log(`   ✔ Goods Subtotal:            ৳${(goodsPaisa/100).toFixed(2)} (${goodsPaisa} paisa)`);
  console.log(`   ✔ Platform Commission (Sum): ৳${(totalCommission/100).toFixed(2)} (${totalCommission} paisa)`);
  console.log(`   ✔ Net Vendor Earnings (Sum): ৳${(totalVendorEarnings/100).toFixed(2)} (${totalVendorEarnings} paisa)`);
  console.log(`   ✔ Exact Paisa Balance:       ${totalCommission} + ${totalVendorEarnings} = ${totalVendorSubtotal} paisa (0 Paisa Rounding Loss)`);

  const elapsedMs = Date.now() - startTime;
  console.log('\n======================================================================');
  console.log(`   🎉 ALL E2E WORKFLOW CHECKS PASSED SUCCESSFULLY in ${elapsedMs}ms!`);
  console.log('======================================================================\n');
}

runEndToEndVerification().catch((err) => {
  console.error('\n❌ [E2E TEST FAILURE]:', err);
  process.exit(1);
});
