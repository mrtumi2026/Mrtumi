'use strict';

/** Regressions found by the launch QA round: payments, mixed orders, staff access, own password. */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
if (process.env.MYSQL_TEST_REQUIRED === 'true' && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
process.env.NODE_ENV = 'test';
process.env.LOG_SILENT = 'true';
if (MYSQL_HOST) {
  process.env.DB_CLIENT = 'mysql';
  process.env.DB_HOST = MYSQL_HOST;
  process.env.DB_PORT = String(process.env.MYSQL_TEST_PORT || 3306);
  process.env.DB_NAME = process.env.MYSQL_TEST_DB || 'mrtumi_test';
  process.env.DB_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test';
  process.env.DB_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw';
}
const { getPool, createQueryClient, closePool } = require('../src/db/mysqlPool');
const { resetDisposableMysqlDatabase } = require('../scripts/qa/mysql-test-database');
const accessRepo = require('../src/repositories/adminAccessRepository');
const manualPayments = require('../src/repositories/adminManualPaymentRepository');
const settlements = require('../src/repositories/partnerSettlementRepository');
const phase08 = require('../src/repositories/phase08Repository');
const { createErrorHandler } = require('../src/middleware/errorHandler');
const { AuthorizationError } = require('../src/utils/errors');
const SKIP = 'SKIPPED locally: no local mysqld/docker; required on GitHub Actions mysql:8.0 service';
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

describe('QA v3.6.1 — screens and error pages', () => {
  test('the product wishlist button is not hijacked by the add-to-cart script', () => {
    assert.match(read('public/frontEnd/js/storefront.js'), /e\.submitter && e\.submitter\.id === 'prodWishlistBtn'\) return;/);
    assert.doesNotMatch(read('src/routes/customerAccount.js'), /\?\?\?\?|p\.status = 'active' AND p\.is_archived/);
  });

  test('client error pages are readable, keep the status code and escape the message', () => {
    let status; let body;
    const res = { headersSent: false, status(code) { status = code; return this; }, send(value) { body = value; return this; } };
    createErrorHandler()(new AuthorizationError('<script>x</script>'), { method: 'GET', path: '/admin/x', originalUrl: '/admin/x', headers: { accept: 'text/html' }, get: () => 'text/html', accepts: () => 'html' }, res, () => {});
    assert.equal(status, 403);
    assert.match(body, /&lt;script&gt;/);
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /href="\/admin\/login"/);
  });
});

describe('QA v3.6.1 — live MySQL regressions', { skip: !MYSQL_HOST && SKIP }, () => {
  let db;
  const unique = `qa361${Date.now()}`;
  before(async () => {
    if (!MYSQL_HOST) return;
    db = createQueryClient(getPool());
    await resetDisposableMysqlDatabase(getPool());
  });
  after(async () => { if (MYSQL_HOST) await closePool(); });

  const insert = async (sql, params) => (await db.execute(sql, params)).insertId;

  test('an admin changes only their own password, with the old one, and other sessions end', async () => {
    const roleId = await insert('INSERT INTO roles(name,slug,status) VALUES(?,?,1)', [unique, unique]);
    const userId = await insert('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',
      [roleId, 'QA Admin', `${unique}@example.invalid`, '', await bcrypt.hash('Old-password-123', 12), 'QA']);
    for (const sid of ['current', 'other']) {
      await db.execute("INSERT INTO web_sessions(sid,actor_type,actor_id,data_json,ip_address,expires_at) VALUES(?,'admin',?,'{}','',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))", [`${unique}-${sid}`, userId]);
    }
    const change = (body) => accessRepo.changeOwnPassword(body, { id: userId }, { sessionId: `${unique}-current` });
    const next = 'New-password-456';
    await assert.rejects(() => change({ currentPassword: 'wrong-password-1', newPassword: next, confirmPassword: next }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => change({ currentPassword: 'Old-password-123', newPassword: 'short', confirmPassword: 'short' }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => change({ currentPassword: 'Old-password-123', newPassword: next, confirmPassword: `${next}x` }), { code: 'VALIDATION_ERROR' });
    await change({ currentPassword: 'Old-password-123', newPassword: next, confirmPassword: next });
    const user = await db.queryOne('SELECT password_hash FROM users WHERE id=?', [userId]);
    assert.equal(await bcrypt.compare(next, user.password_hash), true);
    const sessions = await db.queryAll('SELECT sid FROM web_sessions WHERE actor_id=? AND actor_type=?', [userId, 'admin']);
    assert.deepEqual(sessions.map((s) => s.sid), [`${unique}-current`]);
    const log = await db.queryOne("SELECT after_json FROM audit_logs WHERE action='admin.password.changed' AND actor_id=?", [userId]);
    assert.doesNotMatch(String(log.after_json), /password-456/);
  });

  const makeOrder = async (suffix, { paymentMethod = 'cod', paymentStatus = 'unpaid', status = 'pending', total = 100000 } = {}) => insert(
    `INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,payment_method,payment_status,order_status,total_paisa,cod_due_paisa)
     VALUES(?,'QA','01700000000','QA address',?,?,?,?,?)`,
    [`${unique}-${suffix}`, paymentMethod, paymentStatus, status, total, paymentMethod === 'cod' ? total : 0]);

  test('the order-page verify button approves the pending manual payment', async () => {
    const orderId = await makeOrder('manual', { paymentMethod: 'bkash_manual', paymentStatus: 'pending_verification' });
    await insert("INSERT INTO order_payments(order_id,gateway_code,provider_trx_id,sender_number,amount_paisa,status) VALUES(?,'bkash_manual',?,'01700000000',100000,'pending_verification')", [orderId, unique]);
    const result = await manualPayments.approveOrderManualPayment(orderId, { id: null });
    assert.equal(result.status, 'verified');
    const order = await db.queryOne('SELECT payment_status,paid_paisa FROM orders WHERE id=?', [orderId]);
    assert.equal(order.payment_status, 'paid');
    assert.equal(Number(order.paid_paisa), 100000);
    await assert.rejects(() => manualPayments.approveOrderManualPayment(orderId, { id: null }), { code: 'CONFLICT' });
  });

  test('one transaction ID cannot be approved twice through different payment methods', async () => {
    const trx = `DUP${Date.now()}`;
    const ids = [];
    for (const [suffix, gateway, value] of [['dup-a', 'bkash_manual', trx], ['dup-b', 'rocket_manual', trx.toLowerCase()]]) {
      const orderId = await makeOrder(suffix, { paymentMethod: gateway, paymentStatus: 'pending_verification' });
      await insert("INSERT INTO order_payments(order_id,gateway_code,provider_trx_id,sender_number,amount_paisa,status) VALUES(?,?,?,'01700000000',100000,'pending_verification')", [orderId, gateway, value]);
      ids.push(orderId);
    }
    await manualPayments.approveOrderManualPayment(ids[0], { id: null });
    await assert.rejects(() => manualPayments.approveOrderManualPayment(ids[1], { id: null }), { code: 'CONFLICT' });
    const second = await db.queryOne('SELECT payment_status,paid_paisa FROM orders WHERE id=?', [ids[1]]);
    assert.equal(second.payment_status, 'pending_verification');
    assert.equal(Number(second.paid_paisa), 0);
  });

  test('a mixed order waits for every vendor parcel, then the admin can confirm the money', async () => {
    const category = await insert("INSERT INTO categories(name_bn,name_en,slug,status) VALUES('QA','QA',?,1)", [unique]);
    const product = await insert('INSERT INTO products(sku,name_bn,name_en,slug,category_id,status) VALUES(?,?,?,?,?,1)', [unique, 'QA', 'QA', unique, category]);
    const vendorId = await insert("INSERT INTO vendors(shop_name,owner_name,phone,password_hash) VALUES('QA shop','QA',?,'')", [unique.slice(-11)]);
    const orderId = await makeOrder('mixed', { status: 'shipped' });
    const item = () => insert("INSERT INTO order_items(order_id,product_id,product_name) VALUES(?,?,'QA item')", [orderId, product]);
    await item();
    const vendorItem = await item();
    const subId = await insert("INSERT INTO vendor_sub_orders(order_id,vendor_id,vendor_order_no,status,cod_due_paisa) VALUES(?,?,?,'ready_for_pickup',40000)", [orderId, vendorId, unique]);
    await insert('INSERT INTO vendor_sub_order_items(vendor_sub_order_id,order_item_id,quantity) VALUES(?,?,1)', [subId, vendorItem]);

    await assert.rejects(() => phase08.transitionOrder(orderId, 'delivered', 'QA delivery', { id: null }, `${unique}-early`), { code: 'CONFLICT' });

    const confirm = () => settlements.confirmDeliveredOrderPayment({ orderId, reference: 'QA-RECEIPT-1', actor: { id: null } });
    await db.execute("UPDATE vendor_sub_orders SET status='delivered',delivered_at=UTC_TIMESTAMP() WHERE id=?", [subId]);
    await db.execute("UPDATE orders SET order_status='delivered' WHERE id=?", [orderId]);
    await assert.rejects(confirm, { code: 'CONFLICT' }, 'courier money for the vendor parcel is still outstanding');

    const shipmentId = await insert("INSERT INTO fulfillment_shipments(vendor_sub_order_id,status,cod_due_paisa) VALUES(?,'delivered',40000)", [subId]);
    await insert(`INSERT INTO courier_cod_collections(shipment_id,idempotency_key,collected_amount_paisa,reconciliation_status) VALUES(?,?,40000,'reconciled')`, [shipmentId, `${unique}-cod`]);
    await confirm();
    const order = await db.queryOne('SELECT payment_status,paid_paisa FROM orders WHERE id=?', [orderId]);
    assert.equal(order.payment_status, 'paid');
    assert.equal(Number(order.paid_paisa), 100000);
  });
});
