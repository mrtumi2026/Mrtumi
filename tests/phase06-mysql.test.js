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
