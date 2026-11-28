'use strict';

/** Real admin delete: removes what is safe to remove, keeps what money or stock depends on. */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
if (REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
process.env.NODE_ENV = 'test'; process.env.LOG_SILENT = 'true';
if (MYSQL_HOST) { process.env.DB_CLIENT = 'mysql'; process.env.DB_HOST = MYSQL_HOST; process.env.DB_PORT = String(process.env.MYSQL_TEST_PORT || 3306); process.env.DB_NAME = process.env.MYSQL_TEST_DB || 'mrtumi_test'; process.env.DB_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test'; process.env.DB_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw'; }
const { getPool, createQueryClient, closePool } = require('../src/db/mysqlPool');
const { resetDisposableMysqlDatabase } = require('../scripts/qa/mysql-test-database');
const remove = require('../src/repositories/adminDeleteRepository');
const { localizeError } = require('../src/utils/bnErrors');

describe('admin delete buttons (MySQL)', { skip: !MYSQL_HOST && !REQUIRED ? 'no local MySQL' : false }, () => {
  let db; let productId; let seq = 0;
  const actor = { id: null, ip: '127.0.0.1', userAgent: 'test' };
  before(async () => {
    if (!MYSQL_HOST) return;
    const pool = getPool(); db = createQueryClient(pool); await resetDisposableMysqlDatabase(pool);
    productId = Number((await db.execute("INSERT INTO products (sku,slug,name_bn,name_en,regular_price_paisa,sale_price_paisa,stock_on_hand,stock_reserved,approval_status,status) VALUES ('DEL-1','del-1','পণ্য','Item',10000,8000,5,0,'approved',1)")).insertId);
  });
  after(async () => { if (MYSQL_HOST) await closePool(); });

  const rows = async (table, where, params) => Number((await db.queryOne(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params)).n);
  async function makeOrder(status, paid = 0) {
    seq += 1;
    const id = Number((await db.execute("INSERT INTO orders (invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,payment_status) VALUES (?,'Del Customer','01712345678','Test address',5000,5000,?,0,?,'unpaid')", [`DEL-${seq}`, paid, status])).insertId);
    await db.execute("INSERT INTO order_items (order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES (?,?,'Item',5000,1,5000)", [id, productId]);
    return id;
  }

  test('an unpaid cancelled order is deleted with its lines and leaves an audit record', async (t) => {
    if (!MYSQL_HOST) return t.skip();
    const id = await makeOrder('cancelled');
    await db.execute("INSERT INTO order_payments (order_id,gateway_code,provider_trx_id,sender_number,amount_paisa,payment_purpose,status) VALUES (?,'bkash','FAKE1','01700000000',5000,'full','rejected')", [id]);
    await remove.deleteOrder(id, actor);
    assert.equal(await rows('orders', 'id=?', [id]), 0);
    assert.equal(await rows('order_items', 'order_id=?', [id]), 0);
    assert.equal(await rows('order_payments', 'order_id=?', [id]), 0);
    assert.equal(await rows('audit_logs', "action='order.delete' AND entity_id=?", [String(id)]), 1);
  });

  test('orders that money or stock depends on stay, with a reason in both languages', async (t) => {
    if (!MYSQL_HOST) return t.skip();
    const live = await makeOrder('pending');
    const paid = await makeOrder('cancelled', 5000);
    const refunded = await makeOrder('cancelled');
    await db.execute("INSERT INTO refunds (order_id,invoice_no,amount_paisa,reason,request_key,method,status) VALUES (?,'X',100,'test','del-refund-1','wallet','requested')", [refunded]);
    const claimed = await makeOrder('cancelled');
    await db.execute("INSERT INTO order_payments (order_id,gateway_code,provider_trx_id,sender_number,amount_paisa,payment_purpose,status) VALUES (?,'bkash','REAL1','01700000000',5000,'full','pending')", [claimed]);
    for (const id of [live, paid, refunded, claimed]) {
      await assert.rejects(remove.deleteOrder(id, actor), (error) => {
        assert.equal(error.statusCode, 409);
        assert.notEqual(localizeError(error.message, 'bn'), error.message, `Bangla wording missing for: ${error.message}`);
        return true;
      });
      assert.equal(await rows('orders', 'id=?', [id]), 1);
      assert.equal(await rows('order_items', 'order_id=?', [id]), 1);
    }
  });

  test('supplier and purchase: delete when unused, otherwise deactivate or keep', async (t) => {
    if (!MYSQL_HOST) return t.skip();
    const unused = Number((await db.execute("INSERT INTO suppliers (name,phone,status) VALUES ('Unused','01711111111',1)")).insertId);
    assert.deepEqual(await remove.deleteSupplier(unused, actor), { deleted: true });
    const used = Number((await db.execute("INSERT INTO suppliers (name,phone,status) VALUES ('Used','01722222222',1)")).insertId);
    const makePurchase = async (ref, received) => {
      const id = Number((await db.execute("INSERT INTO purchases (reference_no,supplier_id,subtotal_paisa,total_cost_paisa,paid_amount_paisa,receive_status,purchase_date) VALUES (?,?,1000,1000,0,'draft',CURRENT_DATE)", [ref, used])).insertId);
      await db.execute('INSERT INTO purchase_items (purchase_id,product_id,ordered_qty,received_qty,unit_cost_paisa,line_total_paisa) VALUES (?,?,2,?,500,1000)', [id, productId, received]);
      return id;
    };
    const draft = await makePurchase('PO-DEL-1', 0);
    const received = await makePurchase('PO-DEL-2', 1);
    assert.deepEqual(await remove.deleteSupplier(used, actor), { deleted: false, deactivated: true });
    assert.equal(await rows('suppliers', 'id=? AND status=0', [used]), 1);
    await assert.rejects(remove.deletePurchase(received, actor), { statusCode: 409 });
    assert.equal(await rows('purchases', 'id=?', [received]), 1);
    await remove.deletePurchase(draft, actor);
    assert.equal(await rows('purchases', 'id=?', [draft]), 0);
    assert.equal(await rows('purchase_items', 'purchase_id=?', [draft]), 0);
  });

  test('refund requests, checkout records, messages, reviews and blocks can be removed; approved refunds cannot', async (t) => {
    if (!MYSQL_HOST) return t.skip();
    const order = await makeOrder('delivered', 5000);
    const refund = async (key, status) => Number((await db.execute("INSERT INTO refunds (order_id,invoice_no,amount_paisa,reason,request_key,method,status) VALUES (?,'R',100,'test',?,'wallet',?)", [order, key, status])).insertId);
    const requested = await refund('del-refund-2', 'requested');
    const done = await refund('del-refund-3', 'succeeded');
    await remove.deleteRefundRequest(requested, actor);
    await assert.rejects(remove.deleteRefundRequest(done, actor), { statusCode: 409 });
    assert.equal(await rows('refunds', 'order_id=?', [order]), 1);

    const checkout = Number((await db.execute("INSERT INTO incomplete_orders (session_sid,dedupe_key,customer_name,phone,cart_json,consent_given,status) VALUES ('s','del-dedupe','N','01700000000','[]',1,'abandoned')")).insertId);
    await remove.deleteIncompleteCheckout(checkout, actor);
    assert.equal(await rows('incomplete_orders', 'id=?', [checkout]), 0);

    const complaint = Number((await db.execute("INSERT INTO complaints (name,phone,details,status) VALUES ('N','01700000000','abc','pending')")).insertId);
    const message = Number((await db.execute("INSERT INTO contact_messages (name,phone,subject,message,status) VALUES ('N','01700000000','s','m','new')")).insertId);
    const review = Number((await db.execute("INSERT INTO reviews (product_id,customer_name,rating,comment,status) VALUES (?,'N',1,'spam','pending')", [productId])).insertId);
    const block = Number((await db.execute("INSERT INTO ip_blocks (target_type,ip_or_phone,reason) VALUES ('phone','01733333333','mistake')")).insertId);
    for (const [fn, table, id] of [['deleteComplaint', 'complaints', complaint], ['deleteContactMessage', 'contact_messages', message], ['deleteReview', 'reviews', review], ['deleteIpBlock', 'ip_blocks', block]]) {
      await remove[fn](id, actor);
      assert.equal(await rows(table, 'id=?', [id]), 0, table);
      await assert.rejects(remove[fn](id, actor), { statusCode: 404 });
    }
  });
});
