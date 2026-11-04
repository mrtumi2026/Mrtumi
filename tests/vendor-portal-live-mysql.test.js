'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const SKIP_REASON = 'SKIPPED locally: no disposable MySQL/MariaDB service; required in exact database CI.';
if (REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
process.env.NODE_ENV = 'test'; process.env.LOG_SILENT = 'true';
if (MYSQL_HOST) { process.env.DB_CLIENT='mysql'; process.env.DB_HOST=MYSQL_HOST; process.env.DB_PORT=String(process.env.MYSQL_TEST_PORT||3306); process.env.DB_NAME=process.env.MYSQL_TEST_DB||'mrtumi_test'; process.env.DB_USER=process.env.MYSQL_TEST_USER||'mrtumi_test'; process.env.DB_PASSWORD=process.env.MYSQL_TEST_PASSWORD||'mrtumi_test_pw'; }
const { getPool, createQueryClient, closePool } = require('../src/db/mysqlPool');
const { resetDisposableMysqlDatabase } = require('../scripts/qa/mysql-test-database');
const vendorPortalRepo = require('../src/repositories/vendorPortalRepository');
describe('Vendor portal live MySQL/MariaDB repository integration', () => {
  let pool = null; let client = null;
  before(async () => { if (!MYSQL_HOST) return; pool=getPool(); client=createQueryClient(pool); await resetDisposableMysqlDatabase(pool); });
  after(async () => { if (MYSQL_HOST) await closePool(); });

  test('vendor products, cross-vendor denial, inventory audit, rollback, and mixed-vendor fulfillment', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const suffix = String(Date.now()).slice(-8);
    const passwordHash = await bcrypt.hash('VendorIntegrationPassword!2026', 10);
    const vendorA = await client.execute("INSERT INTO vendors(shop_name,owner_name,phone,email,password_hash,verified,status,lifecycle_status) VALUES(?,?,?,?,?,1,1,'active')", [`Portal A ${suffix}`, 'Owner A', `013${suffix}111`, `portal-a-${suffix}@example.invalid`, passwordHash]);
    const vendorB = await client.execute("INSERT INTO vendors(shop_name,owner_name,phone,email,password_hash,verified,status,lifecycle_status) VALUES(?,?,?,?,?,1,1,'active')", [`Portal B ${suffix}`, 'Owner B', `014${suffix}111`, `portal-b-${suffix}@example.invalid`, passwordHash]);
    const categoryId = (await client.execute('INSERT INTO categories(name_bn,name_en,slug,status) VALUES(?,?,?,1)', ['Vendor portal test', 'Vendor portal test', `vendor-portal-${suffix}`])).insertId;
    const category = { id: categoryId };
    const productA = await vendorPortalRepo.saveProduct(vendorA.insertId, { name: `Vendor A item ${suffix}`, category_id: category.id, old_price: '15.25', new_price: '12.50', stock: 8 });
    const productB = await vendorPortalRepo.saveProduct(vendorB.insertId, { name: `Vendor B item ${suffix}`, category_id: category.id, old_price: '8.00', new_price: '7.00', stock: 4 });
    assert.deepEqual((await vendorPortalRepo.listProducts(vendorA.insertId)).map(p => Number(p.id)), [productA]);
    await assert.rejects(() => vendorPortalRepo.saveProduct(vendorB.insertId, { name: 'Forbidden edit', category_id: category.id }, { id: productA }), { code: 'NOT_FOUND' });
    await vendorPortalRepo.adjustInventory(vendorA.insertId, productA, 11, 'Received vendor stock');
    const inventory = await client.queryOne('SELECT vendor_stock_on_hand FROM products WHERE id=? AND vendor_id=?', [productA, vendorA.insertId]);
    assert.equal(Number(inventory.vendor_stock_on_hand), 11);
    const variantId = await vendorPortalRepo.saveVariant(vendorA.insertId, productA, { variant_sku: `V${suffix}-A`, size_label: '500 g', color_label: 'Red', price_bdt: '12.34', stock_on_hand: 2 });
    assert.equal((await vendorPortalRepo.listVariants(vendorA.insertId, productA)).length, 1);
    assert.equal((await vendorPortalRepo.listVariants(vendorB.insertId, productA)).length, 0);
    await assert.rejects(() => vendorPortalRepo.saveVariant(vendorB.insertId, productA, { variant_sku: 'DENIED', price_bdt: '1', stock_on_hand: 0 }, { variantId }), { code: 'NOT_FOUND' });
    await vendorPortalRepo.saveVariant(vendorA.insertId, productA, { variant_sku: `V${suffix}-A`, size_label: '500 g', color_label: 'Red', price_bdt: '13.45', stock_on_hand: 3 }, { variantId });
    const variant = await client.queryOne('SELECT price_paisa,stock_on_hand FROM product_variants WHERE id=? AND product_id=?', [variantId, productA]);
    assert.deepEqual([Number(variant.price_paisa), Number(variant.stock_on_hand)], [1345, 3]);

    const order = await client.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,discount_paisa,shipping_paisa,total_paisa,payment_method,payment_status,order_status,order_channel) VALUES(?,?,?,'Test address',1950,0,0,1950,'cod','unpaid','pending','storefront')", [`VPORTAL-${suffix}`, 'Portal customer', `015${suffix}111`]);
    const itemA = await client.execute("INSERT INTO order_items(order_id,product_id,vendor_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES(?,?,?,'A line',1250,1,1250)", [order.insertId, productA, vendorA.insertId]);
    const itemB = await client.execute("INSERT INTO order_items(order_id,product_id,vendor_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES(?,?,?,'B line',700,1,700)", [order.insertId, productB, vendorB.insertId]);
    await assert.rejects(() => vendorPortalRepo.transitionOrderItem(vendorB.insertId, itemA.insertId, 'processing'), { code: 'NOT_FOUND' });
    const triggerName = `fail_vendor_history_${suffix}`;
    await client.execute(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON vendor_order_item_history FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional vendor history test failure'`);
    try { await assert.rejects(() => vendorPortalRepo.transitionOrderItem(vendorA.insertId, itemA.insertId, 'processing')); }
    finally { await client.execute(`DROP TRIGGER IF EXISTS ${triggerName}`); }
    const rolledBack = await client.queryOne('SELECT fulfillment_status FROM order_items WHERE id=?', [itemA.insertId]);
    assert.equal(rolledBack.fulfillment_status, 'pending', 'failed history insert rolls item transition back');
    const movedA = await vendorPortalRepo.transitionOrderItem(vendorA.insertId, itemA.insertId, 'processing');
    assert.equal(movedA.parentStatus, 'processing');
    await assert.rejects(() => vendorPortalRepo.transitionOrderItem(vendorA.insertId, itemA.insertId, 'dispatched'), { code: 'CONFLICT' });
    await vendorPortalRepo.transitionOrderItem(vendorB.insertId, itemB.insertId, 'processing');
    await vendorPortalRepo.transitionOrderItem(vendorA.insertId, itemA.insertId, 'ready');
    await vendorPortalRepo.transitionOrderItem(vendorA.insertId, itemA.insertId, 'dispatched');
    const stillProcessing = await client.queryOne('SELECT order_status FROM orders WHERE id=?', [order.insertId]);
    assert.equal(stillProcessing.order_status, 'processing', 'one vendor dispatching cannot mark the mixed-vendor order shipped');
    await vendorPortalRepo.transitionOrderItem(vendorB.insertId, itemB.insertId, 'ready');
    const shipped = await vendorPortalRepo.transitionOrderItem(vendorB.insertId, itemB.insertId, 'dispatched');
    assert.equal(shipped.parentStatus, 'shipped');
    const histories = await client.queryOne('SELECT COUNT(*) AS n FROM vendor_order_item_history WHERE order_id=?', [order.insertId]);
    assert.equal(Number(histories.n), 6);
    await client.execute('DELETE FROM vendor_order_status_history WHERE order_id=?', [order.insertId]);
    await client.execute('DELETE FROM vendor_order_item_history WHERE order_id=?', [order.insertId]);
    await client.execute('DELETE FROM order_items WHERE order_id=?', [order.insertId]);
    await client.execute('DELETE FROM orders WHERE id=?', [order.insertId]);
    await client.execute('DELETE FROM stock_ledger WHERE product_id IN (?,?)', [productA, productB]);
    await client.execute('DELETE FROM product_variants WHERE id=? AND product_id=?', [variantId, productA]);
    await client.execute('DELETE FROM vendor_product_history WHERE vendor_id IN (?,?)', [vendorA.insertId, vendorB.insertId]);
    await client.execute('DELETE FROM products WHERE id IN (?,?)', [productA, productB]);
    await client.execute('DELETE FROM vendors WHERE id IN (?,?)', [vendorA.insertId, vendorB.insertId]);
    await client.execute('DELETE FROM categories WHERE id=?', [categoryId]);
  });

  test('sub-order fulfillment separates booking from handover, enforces ownership, retries failures and synchronizes multi-vendor parent completion', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async (t) => {
    const repo=require('../src/repositories/vendorOrderRepository');
    const suffix=String(Date.now()).slice(-8);
    const passwordHash=await bcrypt.hash('VendorFulfillmentPassword!2026',10);
    const vendors=[]; const orders=[]; const subOrders=[]; let actorUserId=null;
    t.after(async()=>{
      for(const id of subOrders){
        await client.execute('DELETE FROM fulfillment_shipment_events WHERE shipment_id IN (SELECT id FROM fulfillment_shipments WHERE vendor_sub_order_id=?)',[id]);
        await client.execute('DELETE FROM fulfillment_shipments WHERE vendor_sub_order_id=?',[id]);
        await client.execute('DELETE FROM vendor_order_status_history WHERE vendor_sub_order_id=?',[id]);
        await client.execute('DELETE FROM order_status_history WHERE vendor_sub_order_id=?',[id]);
      }
      if(subOrders.length)await client.execute(`DELETE FROM vendor_sub_order_items WHERE vendor_sub_order_id IN (${subOrders.map(()=>'?').join(',')})`,subOrders);
      if(subOrders.length)await client.execute(`DELETE FROM vendor_sub_orders WHERE id IN (${subOrders.map(()=>'?').join(',')})`,subOrders);
      for(const id of orders){await client.execute('DELETE FROM order_status_history WHERE order_id=?',[id]);await client.execute('DELETE FROM orders WHERE id=?',[id]);}
      if(actorUserId)await client.execute('DELETE FROM users WHERE id=?',[actorUserId]);
      if(vendors.length)await client.execute(`DELETE FROM vendors WHERE id IN (${vendors.map(()=>'?').join(',')})`,vendors);
    });
    for(const [n,phone] of [['A',`016${suffix}221`],['B',`017${suffix}221`],['C',`018${suffix}221`]]){
      const result=await client.execute("INSERT INTO vendors(shop_name,owner_name,phone,email,password_hash,verified,status,lifecycle_status) VALUES(?,?,?,?,?,1,1,'active')",[`Fulfillment ${n} ${suffix}`,`Owner ${n}`,phone,`fulfillment-${n}-${suffix}@example.invalid`,passwordHash]);vendors.push(Number(result.insertId));
    }
    const actor=await client.execute('INSERT INTO users(name,email,password_hash,role_label,status) VALUES(?,?,?,\'Super Admin\',1)',[`Fulfillment admin ${suffix}`,`fulfillment-admin-${suffix}@example.invalid`,passwordHash]);actorUserId=Number(actor.insertId);
    const createOrder=async(tag)=>{
      const order=await client.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,cod_due_paisa,payment_method,payment_status,order_status,order_channel) VALUES(?, 'Fulfillment test','01600000000','Test address',0,0,0,'cod','unpaid','processing','storefront')",[`VFUL-${tag}-${suffix}`]);orders.push(Number(order.insertId));return Number(order.insertId);
    };
    const createSubOrder=async(orderId,vendorId,tag,status='order_placed')=>{
      const result=await client.execute('INSERT INTO vendor_sub_orders(order_id,vendor_id,vendor_order_no,status,vendor_entitlement_paisa,marketplace_fee_paisa,net_payable_paisa) VALUES(?,?,?,?,0,0,0)',[orderId,vendorId,`VFUL-${tag}-${suffix}`,status]);subOrders.push(Number(result.insertId));return Number(result.insertId);
    };
    const ready=async(id,vendorId)=>{
      for(const toStatus of ['vendor_accepted','processing','packed','ready_for_pickup'])await repo.transitionSubOrder({subOrderId:id,toStatus,actor:{vendorId}});
    };

    const oneOrder=await createOrder('single');
    const one=await createSubOrder(oneOrder,vendors[0],'single');
    await assert.rejects(()=>repo.transitionSubOrder({subOrderId:one,toStatus:'processing',actor:{vendorId:vendors[0]}}),{code:'CONFLICT'});
    await assert.rejects(()=>repo.transitionSubOrder({subOrderId:one,toStatus:'vendor_accepted',actor:{vendorId:vendors[1]}}),{code:'NOT_FOUND'});
    await ready(one,vendors[0]);
    await repo.setDeliveryMode({subOrderId:one,deliveryMode:'vendor_managed',actor:{userId:actorUserId,platformAdmin:true}});
    await repo.recordBookingResult({subOrderId:one,courierCode:'TEST-COURIER',trackingReference:'TEST-REF-1',resultCode:'failed',actor:{vendorId:vendors[0]}});
    await assert.rejects(()=>repo.recordPhysicalHandover({subOrderId:one,actor:{vendorId:vendors[0]}}),{code:'CONFLICT'});
    await repo.recordBookingResult({subOrderId:one,courierCode:'TEST-COURIER',trackingReference:'TEST-REF-1',resultCode:'succeeded',actor:{vendorId:vendors[0]}});
    let shipment=await client.queryOne('SELECT status,picked_up_at,booking_status FROM fulfillment_shipments WHERE vendor_sub_order_id=?',[one]);
    assert.equal(shipment.status,'ready_for_pickup','booking alone must leave shipment status ready for pickup');
    assert.equal(shipment.picked_up_at,null,'booking alone must not create a physical pickup timestamp');
    assert.equal(shipment.booking_status,'succeeded','booking outcome is persisted separately from physical pickup');
    await repo.recordPhysicalHandover({subOrderId:one,actor:{vendorId:vendors[0]}});
    await assert.rejects(()=>repo.transitionSubOrder({subOrderId:one,toStatus:'delivered',actor:{vendorId:vendors[0]}}),{code:'FORBIDDEN'});
    await repo.transitionSubOrder({subOrderId:one,toStatus:'delivered',actor:{userId:actorUserId,platformAdmin:true}});
    assert.equal((await client.queryOne('SELECT order_status FROM orders WHERE id=?',[oneOrder])).order_status,'delivered');

    const multiOrder=await createOrder('multi');
    const a=await createSubOrder(multiOrder,vendors[0],'multi-a');
    const b=await createSubOrder(multiOrder,vendors[1],'multi-b');
    const cancelled=await createSubOrder(multiOrder,vendors[2],'multi-c','cancelled');
    await ready(a,vendors[0]); await ready(b,vendors[1]);
    await repo.setDeliveryMode({subOrderId:a,deliveryMode:'platform_managed',actor:{userId:actorUserId,platformAdmin:true}});
    await repo.setDeliveryMode({subOrderId:b,deliveryMode:'vendor_managed',actor:{userId:actorUserId,platformAdmin:true}});
    await repo.recordBookingResult({subOrderId:a,courierCode:'TEST-PLATFORM',trackingReference:'TEST-REF-A',resultCode:'succeeded',actor:{userId:actorUserId,platformAdmin:true}});
    await repo.recordBookingResult({subOrderId:b,courierCode:'TEST-VENDOR',trackingReference:'TEST-REF-B',resultCode:'succeeded',actor:{vendorId:vendors[1]}});
    await assert.rejects(()=>repo.recordPhysicalHandover({subOrderId:a,actor:{vendorId:vendors[0]}}),{code:'FORBIDDEN'});
    await repo.recordPhysicalHandover({subOrderId:a,actor:{userId:actorUserId,platformAdmin:true}});
    await repo.recordPhysicalHandover({subOrderId:b,actor:{vendorId:vendors[1]}});
    assert.equal((await client.queryOne('SELECT order_status FROM orders WHERE id=?',[multiOrder])).order_status,'shipped','cancelled siblings are excluded; all remaining vendors have a handover');
    await repo.transitionSubOrder({subOrderId:a,toStatus:'delivered',actor:{userId:actorUserId,platformAdmin:true}});
    assert.equal((await client.queryOne('SELECT order_status FROM orders WHERE id=?',[multiOrder])).order_status,'shipped','one delivered shipment cannot complete a multi-vendor parent while another is open');
    await repo.transitionSubOrder({subOrderId:b,toStatus:'failed_delivery',actor:{userId:actorUserId,platformAdmin:true}});
    await repo.transitionSubOrder({subOrderId:b,toStatus:'ready_for_pickup',actor:{vendorId:vendors[1]}});
    await repo.recordBookingResult({subOrderId:b,courierCode:'TEST-VENDOR',trackingReference:'TEST-REF-B-RETRY',resultCode:'succeeded',actor:{vendorId:vendors[1]}});
    await repo.recordPhysicalHandover({subOrderId:b,actor:{vendorId:vendors[1]}});
    await repo.transitionSubOrder({subOrderId:b,toStatus:'delivered',actor:{userId:actorUserId,platformAdmin:true}});
    assert.equal((await client.queryOne('SELECT order_status FROM orders WHERE id=?',[multiOrder])).order_status,'delivered','parent completion follows every applicable sub-order delivery');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM fulfillment_shipments WHERE vendor_sub_order_id=?',[b])).n),2,'failed delivery retry creates a new shipment and preserves the original shipment');
    const events=await client.queryAll('SELECT event_type,actor_type FROM fulfillment_shipment_events WHERE shipment_id IN (SELECT id FROM fulfillment_shipments WHERE vendor_sub_order_id IN (?,?)) ORDER BY id',[a,b]);
    assert.ok(events.some((event)=>event.event_type==='physical_handover'&&event.actor_type==='admin'));
    assert.ok(events.some((event)=>event.event_type==='physical_handover'&&event.actor_type==='vendor'));
    assert.equal((await client.queryOne('SELECT status FROM vendor_sub_orders WHERE id=?',[cancelled])).status,'cancelled');
  });
});
