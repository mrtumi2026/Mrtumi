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
const { migrateUp, migrateDown } = require('../src/db/migrator');
const vendorPortalRepo = require('../src/repositories/vendorPortalRepository');
describe('Vendor portal live MySQL/MariaDB repository integration', () => {
  let pool = null; let client = null;
  before(async () => { if (!MYSQL_HOST) return; pool=getPool(); client=createQueryClient(pool); await migrateDown(pool,{steps:11}); await migrateUp(pool); });
  after(async () => { if (MYSQL_HOST) await closePool(); });

  test('vendor products, cross-vendor denial, inventory audit, rollback, and mixed-vendor fulfillment', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const suffix = String(Date.now()).slice(-8);
    const passwordHash = await bcrypt.hash('VendorIntegrationPassword!2026', 10);
    const vendorA = await client.execute("INSERT INTO vendors(shop_name,owner_name,phone,email,password_hash,verified,status) VALUES(?,?,?,?,?,1,1)", [`Portal A ${suffix}`, 'Owner A', `013${suffix}111`, `portal-a-${suffix}@example.invalid`, passwordHash]);
    const vendorB = await client.execute("INSERT INTO vendors(shop_name,owner_name,phone,email,password_hash,verified,status) VALUES(?,?,?,?,?,1,1)", [`Portal B ${suffix}`, 'Owner B', `014${suffix}111`, `portal-b-${suffix}@example.invalid`, passwordHash]);
    const categoryId = (await client.execute('INSERT INTO categories(name_bn,name_en,slug,status) VALUES(?,?,?,1)', ['Vendor portal test', 'Vendor portal test', `vendor-portal-${suffix}`])).insertId;
    const category = { id: categoryId };
    const productA = await vendorPortalRepo.saveProduct(vendorA.insertId, { name: `Vendor A item ${suffix}`, category_id: category.id, old_price: '15.25', new_price: '12.50', stock: 8 });
    const productB = await vendorPortalRepo.saveProduct(vendorB.insertId, { name: `Vendor B item ${suffix}`, category_id: category.id, old_price: '8.00', new_price: '7.00', stock: 4 });
    assert.deepEqual((await vendorPortalRepo.listProducts(vendorA.insertId)).map(p => Number(p.id)), [productA]);
    await assert.rejects(() => vendorPortalRepo.saveProduct(vendorB.insertId, { name: 'Forbidden edit', category_id: category.id }, { id: productA }), { code: 'NOT_FOUND' });
    await vendorPortalRepo.adjustInventory(vendorA.insertId, productA, 11, 'Received vendor stock');
    const inventory = await client.queryOne('SELECT vendor_stock_on_hand FROM products WHERE id=? AND vendor_id=?', [productA, vendorA.insertId]);
    assert.equal(Number(inventory.vendor_stock_on_hand), 11);

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
    await client.execute('DELETE FROM vendor_product_history WHERE vendor_id IN (?,?)', [vendorA.insertId, vendorB.insertId]);
    await client.execute('DELETE FROM products WHERE id IN (?,?)', [productA, productB]);
    await client.execute('DELETE FROM vendors WHERE id IN (?,?)', [vendorA.insertId, vendorB.insertId]);
    await client.execute('DELETE FROM categories WHERE id=?', [categoryId]);
  });
});
