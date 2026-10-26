'use strict';

/** Phase 06 live MySQL 8.0 test; required in CI, explicitly skipped when no local MySQL service exists. */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
if (REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
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
const { migrateUp, migrateDown } = require('../src/db/migrator');
const repo = require('../src/repositories/phase06Repository');
const customerRepo = require('../src/repositories/customerRepository');
const phase08 = require('../src/repositories/phase08Repository');
const reason = 'SKIPPED locally: no local mysqld/docker; required on GitHub Actions mysql:8.0 service';

describe('Phase 06 — Live MySQL 8.0 schema, product, stock ledger & purchase receipts', { skip: !MYSQL_HOST && reason }, () => {
  let pool;
  let db;
  let productId;
  let supplierId;
  let purchaseId;
  let purchaseItemId;

  before(async () => {
    if (!MYSQL_HOST) return;
    pool = getPool();
    db = createQueryClient(pool);
    await migrateDown(pool, { steps: 10 });
    await migrateUp(pool);
    const category = await db.execute("INSERT INTO categories (name_bn,name_en,slug,status) VALUES ('পরীক্ষা','Test','phase06-mysql-test',1)");
    const supplier = await repo.createSupplier({ name:'Phase 06 MySQL Supplier',supplier_code:'P06-MYSQL-SUP',phone:'+8801700000001' },{id:null});
    supplierId = supplier.id;
    const product = await repo.createProduct({ sku:'P06-MYSQL-001',name_bn:'মাইএসকিউএল পণ্য',name_en:'MySQL Product',slug:'phase06-mysql-product',category_id:category.insertId,regular_price_bdt:'120.00',sale_price_bdt:'100.00',cost_price_bdt:'50.00',opening_stock:4,low_stock_threshold:1 });
    productId = product.id;
    const purchase = await repo.createPurchase({ supplier_id:supplierId,lines:[{product_id:productId,ordered_qty:5,unit_cost_bdt:'48.25'}] });
    purchaseId = purchase.id;
    const line = await db.queryOne('SELECT id FROM purchase_items WHERE purchase_id=?',[purchaseId]);
    purchaseItemId = Number(line.id);
  });

  after(async () => { if (MYSQL_HOST) await closePool(); });

  test('draft PO does not alter on-hand; unique receipt and partial receipt move stock in an InnoDB transaction', async () => {
    if (!MYSQL_HOST) return;
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),4);
    const receipt = await repo.receivePurchase(purchaseId,{idempotency_key:'p06-mysql-receipt-1',lines:[{purchase_item_id:purchaseItemId,received_qty:3}]});
    assert.equal(receipt.status,'partially_received');
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),7);
    const replay = await repo.receivePurchase(purchaseId,{idempotency_key:'p06-mysql-receipt-1',lines:[{purchase_item_id:purchaseItemId,received_qty:3}]});
    assert.equal(replay.replayed,true);
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM purchase_receipts WHERE idempotency_key=?',['p06-mysql-receipt-1'])).n),1);
    await assert.rejects(() => repo.receivePurchase(purchaseId,{idempotency_key:'p06-mysql-receipt-1',lines:[{purchase_item_id:purchaseItemId,received_qty:2}]}),(err)=>err.code==='IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  test('Phase 07 customer registration, authentication, address ownership and cart merge use MySQL', async () => {
    if (!MYSQL_HOST) return;
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const customer = await customerRepo.registerCustomer({ name: 'Phase 07 Customer', phone: '017' + suffix.slice(-8), email: `p07-${suffix}@example.invalid`, password: 'secure-passphrase-2026' });
    assert.equal((await customerRepo.authenticateCustomer(customer.phone, 'secure-passphrase-2026')).id, customer.id);
    assert.equal(await customerRepo.authenticateCustomer(customer.phone, 'wrong-password'), null);
    const addressId = await customerRepo.saveAddress(customer.id, { label:'Home', recipient_name:'P07 Recipient', recipient_phone:customer.phone, division:'Dhaka', district:'Dhaka', upazila:'Dhanmondi', street_address:'Example address 1', is_default:'1' });
    assert.equal((await customerRepo.listAddresses(customer.id)).find((row) => Number(row.id) === addressId).is_default, 1);
    await customerRepo.deleteAddress(customer.id, addressId);
    await assert.rejects(() => customerRepo.deleteAddress(customer.id, addressId), (err) => err.code === 'NOT_FOUND');
    await customerRepo.mergeCart(customer.id, [{ product_id:productId, qty:2 }, { product_id:productId, qty:3 }]);
    const cartRow = await db.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id IS NULL', [customer.id, productId]);
    assert.equal(Number(cartRow.quantity), 5);
  });

  test('Phase 08 transactional order history, reservation release, refund idempotency and concurrent cap', async () => {
    if (!MYSQL_HOST) return;
    const suffix = Date.now();
    const order = await db.execute("INSERT INTO orders (invoice_no,customer_name,customer_phone,shipping_address,total_paisa,paid_paisa,cod_due_paisa,order_status) VALUES (?, 'P08 Test Customer', '01712345678', 'CI fixture address', 5000, 5000, 0, 'pending')", [`P08-${suffix}`]);
    const orderId = order.insertId;
    await db.execute('INSERT INTO order_items (order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES (?,?,?,2500,2,5000)', [orderId,productId,'P08 reservation fixture']);
    const confirmKey = `p08-confirm-${orderId}`;
    const confirmed = await Promise.all([phase08.transitionOrder(orderId,'confirmed','Customer confirmation',{id:null},confirmKey),phase08.transitionOrder(orderId,'confirmed','Customer confirmation',{id:null},confirmKey)]);
    assert.equal(confirmed.filter(x=>x.replayed).length,1);
    assert.equal(Number((await db.queryOne('SELECT stock_reserved FROM products WHERE id=?',[productId])).stock_reserved),2);
    await assert.rejects(()=>phase08.transitionOrder(orderId,'shipped','Skip processing',{id:null},`p08-invalid-${orderId}`),(err)=>err.code==='CONFLICT');
    await phase08.transitionOrder(orderId,'processing','Preparing order',{id:null},`p08-processing-${orderId}`);
    await phase08.transitionOrder(orderId,'cancelled','Customer requested cancellation',{id:null},`p08-cancel-${orderId}`);
    assert.equal(Number((await db.queryOne('SELECT stock_reserved FROM products WHERE id=?',[productId])).stock_reserved),0);
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),7);
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM order_status_history WHERE order_id=?',[orderId])).n),3);
    const refundKey=`p08-refund-${orderId}`;
    const refunds=await Promise.all([phase08.requestRefund(orderId,3000,'Cancelled paid order',refundKey),phase08.requestRefund(orderId,3000,'Cancelled paid order',refundKey)]);
    assert.equal(refunds.filter(x=>x.replayed).length,1);
    assert.equal(refunds[0].status,'requested');
    await assert.rejects(()=>phase08.requestRefund(orderId,3000,'Exceeds recorded payment',`p08-over-${orderId}`),(err)=>err.code==='VALIDATION_ERROR');
    const decision=await phase08.transitionRefund(refunds[0].id,'approved','Evidence reviewed',{id:null},`p08-approve-${orderId}`);
    assert.equal(decision.status,'approved');
    assert.equal((await phase08.transitionRefund(refunds[0].id,'approved','Evidence reviewed',{id:null},`p08-approve-${orderId}`)).replayed,true);
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM refund_status_history WHERE refund_id=?',[refunds[0].id])).n),2);

    const capped=await db.execute("INSERT INTO orders (invoice_no,customer_name,customer_phone,shipping_address,total_paisa,paid_paisa,order_status) VALUES (?, 'P08 Cap Customer', '01712345678', 'CI fixture address', 5000, 5000, 'cancelled')", [`P08CAP-${suffix}`]);
    const attempts=await Promise.allSettled([phase08.requestRefund(capped.insertId,3000,'Parallel request A',`p08-cap-a-${capped.insertId}`),phase08.requestRefund(capped.insertId,3000,'Parallel request B',`p08-cap-b-${capped.insertId}`)]);
    assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
    assert.equal(Number((await db.queryOne('SELECT COALESCE(SUM(amount_paisa),0) AS n FROM refunds WHERE order_id=?',[capped.insertId])).n),3000);

    const shipped=await db.execute("INSERT INTO orders (invoice_no,customer_name,customer_phone,shipping_address,total_paisa,order_status) VALUES (?, 'P08 Ship Customer', '01712345678', 'CI fixture address', 1000, 'pending')",[`P08SHIP-${suffix}`]);
    await db.execute('INSERT INTO order_items (order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES (?,?,?,1000,1,1000)',[shipped.insertId,productId,'P08 shipment fixture']);
    await phase08.transitionOrder(shipped.insertId,'confirmed','Confirm shipment order',{id:null},`p08-ship-confirm-${shipped.insertId}`);
    await phase08.transitionOrder(shipped.insertId,'processing','Pack shipment',{id:null},`p08-ship-processing-${shipped.insertId}`);
    const shipKey=`p08-ship-${shipped.insertId}`;
    await phase08.transitionOrder(shipped.insertId,'shipped','Courier handoff',{id:null},shipKey);
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),6);
    assert.equal(Number((await db.queryOne('SELECT stock_reserved FROM products WHERE id=?',[productId])).stock_reserved),0);
    assert.equal((await phase08.transitionOrder(shipped.insertId,'shipped','Courier handoff',{id:null},shipKey)).replayed,true);
    await phase08.transitionOrder(shipped.insertId,'delivered','Delivery confirmed',{id:null},`p08-deliver-${shipped.insertId}`);
    await phase08.transitionOrder(shipped.insertId,'return_requested','Customer reported return',{id:null},`p08-return-request-${shipped.insertId}`);
    await phase08.transitionOrder(shipped.insertId,'returned','Item received and inspected',{id:null},`p08-returned-${shipped.insertId}`);
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),7);
    assert.equal((await db.queryOne('SELECT status FROM stock_reservations WHERE reservation_key=?',[`order:${shipped.insertId}`])).status,'returned');
  });

  test('Phase 08 OTP binding, expiry, replay/cooldown and consented incomplete-checkout lifecycle', async () => {
    if (!MYSQL_HOST) return;
    const suffix=Date.now();
    const order=await db.execute("INSERT INTO orders (invoice_no,customer_name,customer_phone,shipping_address,total_paisa,paid_paisa,order_status) VALUES (?, 'OTP Test Customer', '01712345678', 'CI fixture address', 1000, 0, 'pending')",[`P08OTP-${suffix}`]);
    const otp=await phase08.createOrderOtp('01712345678',{orderId:order.insertId,policy:{enabled:true,expirySeconds:300,maxAttempts:3,cooldownSeconds:30,maxPerHour:5}});
    assert.equal(otp.deliveryRequired,true);
    const wrong=otp.code==='000000'?'000001':'000000';
    assert.equal(await phase08.verifyOrderOtp('01712345678',wrong,{orderId:order.insertId}),false);
    assert.equal(await phase08.verifyOrderOtp('01712345678',otp.code,{orderId:order.insertId}),true);
    assert.equal(await phase08.verifyOrderOtp('01712345678',otp.code,{orderId:order.insertId}),false,'verified code cannot be replayed');
    await assert.rejects(()=>phase08.createOrderOtp('01712345678',{orderId:order.insertId,policy:{enabled:true,expirySeconds:300,maxAttempts:3,cooldownSeconds:30}}),(err)=>err.code==='CONFLICT','cooldown limits repeated issue');
    await db.execute('INSERT INTO order_otps (phone,order_id,otp_hash,attempts,max_attempts,expires_at) VALUES (?,?,?,?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND))',['01712345678',order.insertId,phase08.otpDigest('01712345678','123456'),0,3]);
    assert.equal(await phase08.verifyOrderOtp('01712345678','123456',{orderId:order.insertId}),false,'expired code is rejected');
    assert.equal((await db.queryOne('SELECT otp_status FROM orders WHERE id=?',[order.insertId])).otp_status,'verified');
    const otpRow=await db.queryOne('SELECT id FROM order_otps WHERE order_id=? AND verified_at IS NOT NULL ORDER BY id DESC LIMIT 1',[order.insertId]);
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type='order_otp' AND entity_id=?",[String(otpRow.id)])).n),1);

    const cappedOrder=await db.execute("INSERT INTO orders (invoice_no,customer_name,customer_phone,shipping_address,total_paisa,order_status) VALUES (?, 'OTP Cap Customer', '01812345678', 'CI fixture address', 1000, 'pending')",[`P08OTPCAP-${suffix}`]);
    const singleTry=await phase08.createOrderOtp('01812345678',{orderId:cappedOrder.insertId,policy:{enabled:true,expirySeconds:300,maxAttempts:1,cooldownSeconds:30,maxPerHour:1}});
    const wrongTry=singleTry.code==='000000'?'000001':'000000';
    assert.equal(await phase08.verifyOrderOtp('01812345678',wrongTry,{orderId:cappedOrder.insertId}),false);
    assert.equal(await phase08.verifyOrderOtp('01812345678',singleTry.code,{orderId:cappedOrder.insertId}),false,'attempt cap is enforced');
    await assert.rejects(()=>phase08.createOrderOtp('01812345678',{orderId:cappedOrder.insertId,policy:{enabled:true,expirySeconds:300,maxAttempts:1,cooldownSeconds:30,maxPerHour:1}}),(err)=>err.code==='CONFLICT','hourly issue cap is enforced');
    const sid=`otp-session-binding-${suffix}-abcdef`;
    const sessionOtp=await phase08.createOrderOtp('01912345678',{sessionSid:sid,policy:{enabled:true,expirySeconds:300,maxAttempts:3,cooldownSeconds:30,maxPerHour:3}});
    assert.equal(await phase08.verifyOrderOtp('01912345678',sessionOtp.code,{sessionSid:`wrong-${sid}`}),false);
    assert.equal(await phase08.verifyOrderOtp('01912345678',sessionOtp.code,{sessionSid:sid}),true);

    assert.deepEqual(await phase08.recordIncompleteCheckout({consent:false}),{recorded:false,reason:'consent_required'});
    const capture={consent:true,notificationConsent:false,sessionSid:`phase08-session-${suffix}-abcdef`,phone:'01712345678',name:'Consent Test',cart:[{product_id:productId,qty:2,price:99999}]};
    const saved=await phase08.recordIncompleteCheckout(capture);
    const dupe=await phase08.recordIncompleteCheckout(capture);
    assert.equal(saved.recorded,true);
    assert.equal(dupe.id,saved.id);
    assert.equal(dupe.duplicate,true);
    assert.ok((await phase08.listIncompleteCheckouts({search:'01712345678',status:'abandoned'})).rows.some(row=>Number(row.id)===saved.id));
    assert.equal(Number((await db.queryOne('SELECT notification_allowed FROM incomplete_orders WHERE id=?',[saved.id])).notification_allowed),0);
    await phase08.transitionIncompleteCheckout(saved.id,'contacted','Manual admin review',{id:null});
    await phase08.transitionIncompleteCheckout(saved.id,'withdrawn','Customer withdrew consent',{id:null});
    const erased=await db.queryOne('SELECT phone,customer_name,cart_json,consent_withdrawn_at,notification_allowed FROM incomplete_orders WHERE id=?',[saved.id]);
    assert.equal(erased.phone,'');assert.equal(erased.customer_name,'');assert.equal(erased.cart_json,null);assert.ok(erased.consent_withdrawn_at);assert.equal(Number(erased.notification_allowed),0);
    assert.equal((await phase08.recordIncompleteCheckout(capture)).recorded,false,'withdrawn consent cannot be silently reactivated');

    const recoveryCapture={...capture,sessionSid:`phase08-recovery-session-${suffix}-abcdef`};
    const recoverable=await phase08.recordIncompleteCheckout(recoveryCapture);
    await phase08.transitionIncompleteCheckout(recoverable.id,'recovery_started','Customer explicitly requested assistance',{id:null});
    const recoveredOrder=await db.execute("INSERT INTO orders (invoice_no,idempotency_key,customer_name,customer_phone,shipping_address,total_paisa,order_status) VALUES (?,?,'Consent Test','01712345678','CI fixture address',2000,'pending')",[`P08REC-${suffix}`,`incomplete:${recoverable.id}`]);
    const marked=await phase08.transitionIncompleteCheckout(recoverable.id,'recovered','Order placed with recovery idempotency key',{id:null},recoveredOrder.insertId);
    assert.equal(marked.status,'recovered');
    await assert.rejects(()=>db.execute("INSERT INTO orders (invoice_no,idempotency_key,customer_name,customer_phone,shipping_address,total_paisa,order_status) VALUES (?,?,'Consent Test','01712345678','CI fixture address',2000,'pending')",[`P08REDUP-${suffix}`,`incomplete:${recoverable.id}`]),(err)=>err.code==='DB_DUPLICATE_ENTRY');
  });

  test('concurrent warehouse adjustments serialize and the ledger balance remains exact', async () => {
    if (!MYSQL_HOST) return;
    await Promise.all([
      repo.adjustStock({product_id:productId,stock_pool:'warehouse',qty_delta:1,reason:'Concurrent receiving recount'}),
      repo.adjustStock({product_id:productId,stock_pool:'warehouse',qty_delta:2,reason:'Concurrent receiving recount'}),
    ]);
    const product = await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId]);
    const ledger = await db.queryOne("SELECT balance_after FROM stock_ledger WHERE product_id=? AND stock_pool='warehouse' ORDER BY id DESC LIMIT 1",[productId]);
    assert.equal(Number(product.stock_on_hand),10);
    assert.equal(Number(ledger.balance_after),10);
    assert.ok(supplierId && purchaseId);
  });
});
