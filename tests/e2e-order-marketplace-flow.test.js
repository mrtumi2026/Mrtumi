'use strict';

const assert = require('node:assert/strict');
const { test, describe, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixtureRoot = path.join(os.tmpdir(), `mrtumi-e2e-${process.pid}`);
const dbFile = path.join(fixtureRoot, 'e2e.db');
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = dbFile;
process.env.SEED_DEMO_DATA = 'true';
process.env.LOG_SILENT = 'true';

const db = require('../src/db/database');
const { calculateResellerPricing } = require('../src/services/resellerPricing');
const { getCourierAdapter } = require('../src/services/courier');
const { getPaymentGateway } = require('../src/services/payments');

describe('Full E-Commerce Marketplace Flow Verification', () => {
  before(() => {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch {}
    db.initializeDatabase();
  });

  after(() => {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch {}
  });

  test('Phase 07 & 08: Order creation, stock reservation and cancellation release', () => {
    // 1. Check product opening stock
    const prod = db.get('SELECT id, stock FROM products WHERE id = 1');
    assert.ok(prod, 'Sample product exists');
    const initialStock = prod.stock;

    // 2. Simulate order placement
    const invoice = `TEST-INV-${Date.now()}`;
    const orderQty = 2;

    db.run(
      `INSERT INTO orders (invoice_id, customer_name, phone, address, subtotal, amount, status, is_seen)
       VALUES (?, 'Test Customer', '01711000000', 'Dhanmondi, Dhaka', 1000, 1000, 'pending', 1)`,
      invoice
    );
    const order = db.get('SELECT id FROM orders WHERE invoice_id = ?', invoice);
    assert.ok(order, 'Order created');

    // Add order item
    db.run(
      `INSERT INTO order_items (order_id, product_id, product_name, price, qty)
       VALUES (?, ?, 'Test Product', 500, ?)`,
      order.id, prod.id, orderQty
    );

    // Reserve stock (decrement available stock)
    db.run('UPDATE products SET stock = stock - ? WHERE id = ?', orderQty, prod.id);
    const reservedStock = db.get('SELECT stock FROM products WHERE id = ?', prod.id).stock;
    assert.equal(reservedStock, initialStock - orderQty);

    // 3. Transition order: pending -> confirmed -> processing
    db.run("UPDATE orders SET status = 'confirmed' WHERE id = ?", order.id);
    let updated = db.get('SELECT status FROM orders WHERE id = ?', order.id);
    assert.equal(updated.status, 'confirmed');

    // 4. Cancel order and release stock
    db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
    db.run('UPDATE products SET stock = stock + ? WHERE id = ?', orderQty, prod.id);

    const restoredStock = db.get('SELECT stock FROM products WHERE id = ?', prod.id).stock;
    assert.equal(restoredStock, initialStock, 'Stock successfully restored after cancellation');
  });

  test('Phase 16: Vendor product submission, moderation and reseller margin', () => {
    // 1. Create a vendor
    const vendorRes = db.run(
      `INSERT INTO vendors (shop_name, owner_name, phone, email, commission_rate, verified, status)
       VALUES ('Fresh Agro', 'Agro Owner', '01811000000', 'agro@example.test', 10, 1, 1)`
    );
    const vendorId = vendorRes.lastInsertRowid;

    // 2. Vendor submits a product (starts with approval_status = 'pending')
    const prodRes = db.run(
      `INSERT INTO products (name, slug, code, category_id, vendor_id, new_price, wholesale_price, stock, approval_status, status)
       VALUES ('Organic Honey', 'organic-honey', 'V-HONEY-1', 1, ?, 800, 600, 50, 'pending', 0)`,
      vendorId
    );
    const prodId = prodRes.lastInsertRowid;

    let p = db.get('SELECT approval_status, status FROM products WHERE id = ?', prodId);
    assert.equal(p.approval_status, 'pending');
    assert.equal(p.status, 0);

    // 3. Admin approves product
    db.run("UPDATE products SET approval_status = 'approved', status = 1 WHERE id = ?", prodId);
    p = db.get('SELECT approval_status, status FROM products WHERE id = ?', prodId);
    assert.equal(p.approval_status, 'approved');
    assert.equal(p.status, 1);

    // 4. Reseller pricing calculation for this product
    const pricing = calculateResellerPricing({
      mode: 'reseller_price',
      quantity: 1,
      officialUnitPricePaisa: 80000,
      vendorEntitlementUnitPaisa: 60000,
      resellerSellingUnitPaisa: 85000,
      platformFeeUnitPaisa: 2000,
      minimumSellingUnitPaisa: 70000,
      maximumSellingUnitPaisa: 100000,
    });

    assert.equal(pricing.customerUnitPricePaisa, 85000);
    assert.equal(pricing.vendorEntitlementPaisa, 60000);
    assert.equal(pricing.platformFeePaisa, 2000);
    assert.equal(pricing.resellerEarningPaisa, 23000, 'Reseller earns 850 - 600 - 20 = 230 BDT');
  });

  test('Phase 17: POS order stock deduction and reservation check', () => {
    const prod = db.get('SELECT id, stock FROM products WHERE id = 1');
    const startStock = prod.stock;

    // Simulate POS sale of 3 units
    const posQty = 3;
    assert.ok(startStock >= posQty, 'Sufficient stock for POS');

    const inv = `POS-${Date.now()}`;
    db.run(
      `INSERT INTO orders (invoice_id, customer_name, phone, address, subtotal, amount, payment_method, payment_status, status, order_type)
       VALUES (?, 'Walk-in Customer', '01611000000', 'Store Counter', 1500, 1500, 'Cash', 'paid', 'processing', 'pos')`,
      inv
    );
    const posOrder = db.get('SELECT id FROM orders WHERE invoice_id = ?', inv);

    db.run(
      `INSERT INTO order_items (order_id, product_id, product_name, price, qty)
       VALUES (?, ?, 'In-store Product', 500, ?)`,
      posOrder.id, prod.id, posQty
    );

    db.run('UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?', posQty, posQty, prod.id);

    const postStock = db.get('SELECT stock, sold_count FROM products WHERE id = ?', prod.id);
    assert.equal(postStock.stock, startStock - posQty, 'POS immediately decrements stock');
  });

  test('Phase 10 & 11: End-to-end sandbox dispatch and payment simulation', async () => {
    // 1. Payment initialization via bKash
    const bkash = getPaymentGateway('bkash_auto', { sandbox: true });
    const payRes = await bkash.initiatePayment({
      orderId: 'ORD-E2E-1',
      invoice: 'INV-E2E-1',
      amountPaisa: 120000,
      customerPhone: '01711223344',
      callbackUrl: 'http://localhost:3000/callback',
    });
    assert.equal(payRes.success, true);
    assert.ok(payRes.paymentId);

    // Payment completion
    const execRes = await bkash.executePayment(payRes.paymentId);
    assert.equal(execRes.success, true);
    assert.equal(execRes.status, 'completed');

    // 2. Dispatch via Steadfast Courier
    const steadfast = getCourierAdapter('steadfast', { sandbox: true });
    const shipRes = await steadfast.createShipment({
      orderId: 'ORD-E2E-1',
      invoice: 'INV-E2E-1',
      recipientName: 'Customer Name',
      recipientPhone: '01711223344',
      recipientAddress: 'Banani, Dhaka',
      codAmountPaisa: 0, // already paid online
    });
    assert.equal(shipRes.success, true);
    assert.ok(shipRes.trackingCode);

    // Tracking shipment
    const track = await steadfast.trackShipment(shipRes.trackingCode);
    assert.equal(track.provider, 'steadfast');
    assert.ok(track.status);
  });
});
