'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB_PATH = path.join(os.tmpdir(), `mrtumi.phase06.${process.pid}.test.db`);
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = TEST_DB_PATH;
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_SILENT = 'true';

const db = require('../src/db/database');
const repo = require('../src/repositories/phase06Repository');
const { ValidationError, AppError } = require('../src/utils/errors');

before(() => {
  db.initializeDatabase();
  db.run("INSERT INTO categories (name, slug, status) VALUES (?, ?, 1)", 'Test groceries', 'phase06-test-grocery');
});
after(() => {
  try { db.rawDb.close(); } catch (_e) {}
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(TEST_DB_PATH + ext); } catch (_e) {}
  }
});

describe('Phase 06 — Product, Inventory Ledger, Supplier & Purchase Receiving', () => {
  test('product creation uses unique SKU, validates money and writes opening stock ledger once', async () => {
    const created = await repo.createProduct({
      sku: 'P06-TEST-001', name_bn: 'পরীক্ষা পণ্য', name_en: 'Test Product', slug: 'phase06-test-product',
      category_id: 1, regular_price_bdt: '120.00', sale_price_bdt: '100.50', cost_price_bdt: '70.25',
      unit_label: '1 pc', opening_stock: '8', low_stock_threshold: '3'
    }, { id: 7 });
    assert.ok(created.id > 0);
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', created.id).stock, 8);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=? AND movement_type='opening'", created.id).n, 1);
    await assert.rejects(() => repo.createProduct({
      sku: 'P06-TEST-001', name_bn: 'দ্বিতীয়', slug: 'phase06-test-product-2', category_id: 1,
      regular_price_bdt: '1', sale_price_bdt: '1', cost_price_bdt: '0'
    }), /SKU already exists/);
    await assert.rejects(() => repo.createProduct({
      sku: 'P06-BAD-001', name_bn: 'Invalid', slug: 'phase06-test-invalid-price', category_id: 1,
      regular_price_bdt: '1.001', sale_price_bdt: '2', cost_price_bdt: '0'
    }), ValidationError);
  });

  test('product catalog edits preserve stock and are transactionally audited with validation and rollback', async () => {
    const product = db.get("SELECT id FROM products WHERE code='P06-TEST-001'");
    const stockBefore = db.get('SELECT stock,stock_reserved,vendor_stock_on_hand FROM products WHERE id=?', product.id);
    const ledgerBefore = Number(db.get('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?', product.id).n);
    const input = {
      name_bn:'সম্পাদিত পণ্য', name_en:'Edited product', slug:'phase06-test-product-edited', product_type:'grocery',
      category_id:1, brand_id:'', unit_label:'500 g', regular_price_bdt:'130.00', sale_price_bdt:'115.25', cost_price_bdt:'70.25',
      wholesale_price_bdt:'90.00', wholesale_min_qty:'5', low_stock_threshold:'4', image_url:'/uploads/custom/edited.webp',
      short_desc_bn:'নতুন সংক্ষিপ্ত বিবরণ', short_desc_en:'New short description', description_bn:'বাংলা বিবরণ', description_en:'English description',
    };
    const updated = await repo.updateProduct(product.id, input, { id:7, ip:'192.0.2.10' });
    assert.equal(updated.sku, 'P06-TEST-001', 'SKU remains a stable product identifier');
    const persisted = db.get('SELECT name,name_en,slug,old_price,new_price,purchase_price,stock,stock_reserved,vendor_stock_on_hand,unit FROM products WHERE id=?', product.id);
    assert.deepEqual(persisted, {
      name:'সম্পাদিত পণ্য', name_en:'Edited product', slug:'phase06-test-product-edited', old_price:130, new_price:115.25,
      purchase_price:70.25, stock:stockBefore.stock, stock_reserved:stockBefore.stock_reserved,
      vendor_stock_on_hand:stockBefore.vendor_stock_on_hand, unit:'500 g',
    });
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?', product.id).n), ledgerBefore, 'catalog edit must not append or overwrite stock movements');
    const audit = db.get("SELECT actor_id,before_json,after_json FROM audit_logs WHERE action='product.update' AND entity_id=? ORDER BY id DESC LIMIT 1", String(product.id));
    assert.equal(audit.actor_id, 7);
    assert.equal(JSON.parse(audit.before_json).name_bn, 'পরীক্ষা পণ্য');
    assert.equal(JSON.parse(audit.after_json).nameBn, 'সম্পাদিত পণ্য');

    await assert.rejects(() => repo.updateProduct(product.id, { ...input, slug:'phase06-test-product-edited', regular_price_bdt:'10', sale_price_bdt:'12' }), ValidationError);
    await assert.rejects(() => repo.updateProduct(product.id, { ...input, slug:'!!!' }), ValidationError);
    await assert.rejects(() => repo.updateProduct(999999, input), (err) => err.code === 'NOT_FOUND');
    const second = await repo.createProduct({ sku:'P06-EDIT-OTHER', name_bn:'অন্য পণ্য', slug:'phase06-edit-other', category_id:1,
      regular_price_bdt:'20', sale_price_bdt:'20', cost_price_bdt:'10' });
    await assert.rejects(() => repo.updateProduct(product.id, { ...input, slug:'phase06-edit-other' }), (err) => err.code === 'DUPLICATE_PRODUCT_SLUG');
    assert.ok(second.id > 0);

    db.rawDb.exec("CREATE TRIGGER p06_fail_product_update BEFORE INSERT ON audit_logs WHEN NEW.action='product.update' BEGIN SELECT RAISE(ABORT,'fixture product audit failure'); END");
    try {
      await assert.rejects(() => repo.updateProduct(product.id, { ...input, name_en:'Must roll back' }));
    } finally {
      db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_product_update');
    }
    assert.equal(db.get('SELECT name_en FROM products WHERE id=?', product.id).name_en, 'Edited product', 'audit failure must roll product changes back');
  });

  test('variant catalog create/update preserves SKU and inventory, uses paisa, soft-disables without deleting, and rolls audit failures back', async () => {
    const product = db.get("SELECT id FROM products WHERE code='P06-TEST-001'");
    const created = await repo.createProductVariant(product.id, { variant_sku:'P06-TEST-001-500G',size_label:'500 g',color_label:'Green',price_bdt:'123.45' }, { id:7 });
    assert.ok(created.id > 0);
    assert.equal(created.pricePaisa,12345);
    assert.equal(created.stockOnHand,0);
    assert.equal(Number(db.get('SELECT price FROM product_variants WHERE id=?',created.id).price),123.45);
    const auditCreate = db.get("SELECT actor_id,after_json FROM audit_logs WHERE action='product.variant.create' AND entity_id=?",String(created.id));
    assert.equal(auditCreate.actor_id,7);
    assert.equal(JSON.parse(auditCreate.after_json).variantSku,'P06-TEST-001-500G');
    await assert.rejects(() => repo.createProductVariant(product.id,{variant_sku:'P06-TEST-001-500G',size_label:'1 kg',price_bdt:'1.00'}),(err)=>err.code==='CONFLICT');
    await assert.rejects(() => repo.createProductVariant(product.id,{variant_sku:'P06-TEST-INVALID',price_bdt:'1.001'}),ValidationError);
    await assert.rejects(() => repo.updateProductVariant(product.id,created.id,{size_label:'1 kg',color_label:'Blue',price_bdt:'0.00'}),ValidationError,'partial updates cannot silently activate or reset omitted fields');

    db.run('UPDATE product_variants SET stock_on_hand=?,stock_reserved=? WHERE id=?',8,3,created.id);
    const updated = await repo.updateProductVariant(product.id,created.id,{size_label:'1 kg',color_label:'Blue',price_bdt:'0.00',status:'0'},{id:7});
    assert.deepEqual([updated.variantSku,updated.sizeLabel,updated.colorLabel,updated.pricePaisa,updated.stockOnHand,updated.stockReserved,updated.status],
      ['P06-TEST-001-500G','1 kg','Blue',0,8,3,0]);
    const persisted = db.get('SELECT variant_sku,size_label,color_label,ROUND(price*100) AS price_paisa,stock_on_hand,stock_reserved,status FROM product_variants WHERE id=?',created.id);
    assert.deepEqual(persisted,{variant_sku:'P06-TEST-001-500G',size_label:'1 kg',color_label:'Blue',price_paisa:0,stock_on_hand:8,stock_reserved:3,status:0});
    const auditUpdate = db.get("SELECT before_json,after_json FROM audit_logs WHERE action='product.variant.update' AND entity_id=? ORDER BY id DESC LIMIT 1",String(created.id));
    assert.equal(JSON.parse(auditUpdate.before_json).variant_sku,'P06-TEST-001-500G');
    assert.equal(JSON.parse(auditUpdate.after_json).stockReserved,3);

    db.rawDb.exec("CREATE TRIGGER p06_fail_variant_update BEFORE INSERT ON audit_logs WHEN NEW.action='product.variant.update' BEGIN SELECT RAISE(ABORT,'fixture variant audit failure'); END");
    try {
      await assert.rejects(() => repo.updateProductVariant(product.id,created.id,{size_label:'Must roll back',color_label:'Blue',price_bdt:'2.00',status:'1'}));
    } finally { db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_variant_update'); }
    assert.equal(db.get('SELECT size_label FROM product_variants WHERE id=?',created.id).size_label,'1 kg');

    db.rawDb.exec("CREATE TRIGGER p06_fail_variant_create BEFORE INSERT ON audit_logs WHEN NEW.action='product.variant.create' BEGIN SELECT RAISE(ABORT,'fixture variant audit failure'); END");
    try {
      await assert.rejects(() => repo.createProductVariant(product.id,{variant_sku:'P06-TEST-ROLLBACK',price_bdt:'2.00'}));
    } finally { db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_variant_create'); }
    assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM product_variants WHERE variant_sku='P06-TEST-ROLLBACK'").n),0);
  });

  test('gallery reorder accepts only the complete current product image set and rolls back with audit failures', async () => {
    const product = db.get("SELECT id FROM products WHERE code='P06-TEST-001'");
    const first='/uploads/product/lychee-fresh.jpg';
    const second='/uploads/product/lychee-box.jpg';
    db.run('UPDATE products SET image=?,gallery=? WHERE id=?',first,JSON.stringify([first,second]),product.id);
    const beforeFiles=[first,second].map((image)=>path.join(__dirname,'..','public',image.slice(1)));
    assert.ok(beforeFiles.every((file)=>fs.existsSync(file)));
    assert.deepEqual((await repo.getProductGalleryForEdit(product.id)).paths,[first,second]);
    await assert.rejects(()=>repo.updateProductGallery(999999,{gallery_paths:[first]}),(err)=>err.code==='NOT_FOUND');
    await assert.rejects(()=>repo.updateProductGallery(product.id,{gallery_paths:[first,'/uploads/product/../secret.jpg']}),ValidationError);
    await assert.rejects(()=>repo.updateProductGallery(product.id,{gallery_paths:[first,'/uploads/product/mango-organic.jpg']}),ValidationError,'a valid image not assigned to this product is rejected');
    await assert.rejects(()=>repo.updateProductGallery(product.id,{gallery_paths:[first]}),ValidationError,'reorder must be a complete list');

    const updated=await repo.updateProductGallery(product.id,{gallery_paths:[second,first]},{id:7,ip:'192.0.2.7'});
    assert.deepEqual(updated.galleryPaths,[second,first]);
    assert.deepEqual(db.get('SELECT image AS image_url,gallery AS gallery_json FROM products WHERE id=?',product.id),
      {image_url:second,gallery_json:JSON.stringify([second,first])});
    const audit=db.get("SELECT actor_id,before_json,after_json FROM audit_logs WHERE action='product.gallery.reorder' AND entity_id=? ORDER BY id DESC LIMIT 1",String(product.id));
    assert.equal(audit.actor_id,7);
    assert.deepEqual(JSON.parse(audit.before_json).galleryPaths,[first,second]);
    assert.deepEqual(JSON.parse(audit.after_json).galleryPaths,[second,first]);
    assert.ok(beforeFiles.every((file)=>fs.existsSync(file)),'gallery reorder never removes shared image files');

    db.rawDb.exec("CREATE TRIGGER p06_fail_gallery_audit BEFORE INSERT ON audit_logs WHEN NEW.action='product.gallery.reorder' BEGIN SELECT RAISE(ABORT,'fixture gallery audit failure'); END");
    try { await assert.rejects(()=>repo.updateProductGallery(product.id,{gallery_paths:[first,second]})); }
    finally { db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_gallery_audit'); }
    assert.deepEqual(db.get('SELECT image AS image_url,gallery AS gallery_json FROM products WHERE id=?',product.id),
      {image_url:second,gallery_json:JSON.stringify([second,first])},'audit failure rolls gallery fields back atomically');
    db.run('UPDATE products SET gallery=? WHERE id=?',JSON.stringify(['https://example.invalid/private?token=hidden']),product.id);
    const blocked=await repo.getProductGalleryForEdit(product.id);
    assert.equal(blocked.blockedCount,1);
    assert.deepEqual(blocked.paths,[second],'only independently validated current paths are returned; the unsafe legacy URL itself is not exposed');
    await assert.rejects(()=>repo.updateProductGallery(product.id,{gallery_paths:[first]}),ValidationError);
    db.run('UPDATE products SET image=?,gallery=? WHERE id=?',first,JSON.stringify([first,second]),product.id);
  });

  test('supplier creation validates fields and atomically records its audit event', async () => {
    const input = { name:'Verified supplier', supplier_code:'P06-SUP-AUDIT', phone:'+8801712345678', email:'supplier-audit@example.com', tax_or_trade_id:'BD-TIN-123' };
    const created = await repo.createSupplier(input, { id:7, ip:'192.0.2.8' });
    assert.ok(created.id > 0);
    const persisted = db.get('SELECT name,supplier_code,email,tax_or_trade_id FROM suppliers WHERE id=?',created.id);
    assert.deepEqual(persisted,{name:'Verified supplier',supplier_code:'P06-SUP-AUDIT',email:'supplier-audit@example.com',tax_or_trade_id:'BD-TIN-123'});
    const audit = db.get("SELECT actor_id,after_json FROM audit_logs WHERE action='supplier.create' AND entity_id=?",String(created.id));
    assert.equal(audit.actor_id,7);
    assert.equal(JSON.parse(audit.after_json).name,input.name);
    await assert.rejects(() => repo.createSupplier({...input,supplier_code:'P06-SUP-INVALID',email:'bad-email'}),ValidationError);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM suppliers WHERE supplier_code='P06-SUP-INVALID'").n,0);

    db.rawDb.exec("CREATE TRIGGER p06_fail_supplier_audit BEFORE INSERT ON audit_logs WHEN NEW.action='supplier.create' BEGIN SELECT RAISE(ABORT,'fixture supplier audit failure'); END");
    try {
      await assert.rejects(() => repo.createSupplier({...input,supplier_code:'P06-SUP-ROLLBACK'}));
    } finally {
      db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_supplier_audit');
    }
    assert.equal(db.get("SELECT COUNT(*) AS n FROM suppliers WHERE supplier_code='P06-SUP-ROLLBACK'").n,0,'audit failure must roll back supplier insert');
  });

  test('supplier edit and activation lifecycle preserves purchase history and balances with atomic audit rollback', async () => {
    const suffix=`${process.pid}-${Date.now()}`;
    const supplier=await repo.createSupplier({name:'Lifecycle supplier',supplier_code:`P06-LIFE-${suffix}`,phone:'+8801712345678',email:'lifecycle@example.com'}, {id:7});
    const product=db.get("SELECT id FROM products WHERE code='P06-TEST-001'");
    const purchase=await repo.createPurchase({supplier_id:supplier.id,reference_no:`P06-LIFE-PO-${suffix}`,lines:[{product_id:product.id,ordered_qty:2,unit_cost_bdt:'4.25'}]},{id:7});
    const balanceBefore=db.get('SELECT balance_due FROM suppliers WHERE id=?',supplier.id).balance_due;
    const fields={supplier_code:`P06-LIFE-${suffix}`,name:'Lifecycle supplier updated',company:'Updated company',contact_person:'Buyer',phone:'+8801712345679',
      email:'updated@example.com',address:'New address',tax_or_trade_id:'BD-LIFE-1',notes:'Contact note',status:'0'};
    const inactive=await repo.updateSupplier(supplier.id,fields,{id:7,ip:'192.0.2.10'});
    assert.equal(inactive.status,0);
    assert.equal(db.get('SELECT status FROM suppliers WHERE id=?',supplier.id).status,0);
    assert.equal(db.get('SELECT id FROM purchases WHERE id=? AND supplier_id=?',purchase.id,supplier.id).id,purchase.id,'deactivation retains purchase FK/history');
    assert.equal(db.get('SELECT balance_due FROM suppliers WHERE id=?',supplier.id).balance_due,balanceBefore,'supplier availability does not mutate financial balance');
    await assert.rejects(()=>repo.createPurchase({supplier_id:supplier.id,lines:[{product_id:product.id,ordered_qty:1,unit_cost_bdt:'1.00'}]}),(err)=>err.statusCode===404,'inactive suppliers cannot be used for new orders');
    const active=await repo.updateSupplier(supplier.id,{...fields,status:'1'},{id:7});
    assert.equal(active.status,1,'supplier can be reactivated without changing linked history');
    assert.equal(db.get('SELECT status FROM suppliers WHERE id=?',supplier.id).status,1);
    const events=db.all("SELECT actor_id,before_json,after_json FROM audit_logs WHERE action='supplier.update' AND entity_id=? ORDER BY id",String(supplier.id));
    assert.equal(events.length,2);
    assert.equal(JSON.parse(events[0].before_json).status,1);
    assert.equal(JSON.parse(events[0].after_json).status,0);
    assert.equal(JSON.parse(events[1].before_json).status,0);
    assert.equal(JSON.parse(events[1].after_json).status,1);
    await assert.rejects(()=>repo.updateSupplier(supplier.id,{...fields,email:'invalid'}, {id:7}),ValidationError);
    await assert.rejects(()=>repo.updateSupplier(supplier.id,{...fields,status:'2'}, {id:7}),ValidationError);
    const duplicate=await repo.createSupplier({name:'Second lifecycle supplier',supplier_code:`P06-OTHER-${suffix}`,phone:'+8801712345680'});
    await assert.rejects(()=>repo.updateSupplier(duplicate.id,{...fields,supplier_code:`P06-LIFE-${suffix}`,status:'1'}),(err)=>err.statusCode===409);

    db.rawDb.exec("CREATE TRIGGER p06_fail_supplier_update_audit BEFORE INSERT ON audit_logs WHEN NEW.action='supplier.update' BEGIN SELECT RAISE(ABORT,'fixture supplier update audit failure'); END");
    try { await assert.rejects(()=>repo.updateSupplier(supplier.id,{...fields,name:'Must roll back',status:'0'},{id:7})); }
    finally { db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_supplier_update_audit'); }
    assert.deepEqual(db.get('SELECT name,status FROM suppliers WHERE id=?',supplier.id),{name:'Lifecycle supplier updated',status:1},'audit failure rolls supplier edit/status back');
    assert.equal(db.get('SELECT id FROM purchases WHERE id=? AND supplier_id=?',purchase.id,supplier.id).id,purchase.id);
  });

  test('authorized adjustments are reasoned, ledger-backed, audited atomically and cannot make stock negative', async () => {
    const product = db.get("SELECT id FROM products WHERE code='P06-TEST-001'");
    const result = await repo.adjustStock({ product_id: product.id, stock_pool: 'warehouse', qty_delta: -2, reason: 'Damaged during count' }, { id: 7, ip:'192.0.2.2' });
    assert.equal(result.balanceAfter, 6);
    assert.equal(db.get("SELECT reason FROM stock_ledger WHERE product_id=? AND movement_type='adjustment' ORDER BY id DESC LIMIT 1", product.id).reason, 'Damaged during count');
    const audit = db.get("SELECT actor_id,after_json FROM audit_logs WHERE action='inventory.adjust' AND entity_id=? ORDER BY id DESC LIMIT 1", String(product.id));
    assert.equal(audit.actor_id, 7);
    assert.deepEqual(JSON.parse(audit.after_json), { ...result, reason:'Damaged during count' });
    await assert.rejects(() => repo.adjustStock({ product_id: product.id, qty_delta: -99, reason: 'Invalid correction' }), AppError);
    await assert.rejects(() => repo.adjustStock({ product_id: product.id, stock_pool:'unknown', qty_delta: 1, reason:'Wrong pool' }), ValidationError);
    await assert.rejects(() => repo.adjustStock({ product_id: product.id, qty_delta: 1, reason: '' }), ValidationError);

    const ledgerBefore=Number(db.get("SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=? AND movement_type='adjustment'",product.id).n);
    const auditBefore=Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='inventory.adjust' AND entity_id=?",String(product.id)).n);
    db.rawDb.exec("CREATE TRIGGER p06_fail_inventory_audit BEFORE INSERT ON audit_logs WHEN NEW.action='inventory.adjust' BEGIN SELECT RAISE(ABORT,'fixture inventory audit failure'); END");
    try {
      await assert.rejects(() => repo.adjustStock({ product_id:product.id,qty_delta:1,reason:'Audit rollback fixture' },{id:7}));
    } finally {
      db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_inventory_audit');
    }
    assert.equal(Number(db.get('SELECT stock FROM products WHERE id=?',product.id).stock),6,'audit failure rolls stock back');
    assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=? AND movement_type='adjustment'",product.id).n),ledgerBefore,'audit failure rolls ledger back');
    assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='inventory.adjust' AND entity_id=?",String(product.id)).n),auditBefore,'failed audit is not partially recorded');
  });

  test('purchase order creation leaves stock unchanged; partial and duplicate-safe receipts update stock atomically', async () => {
    const supplier = await repo.createSupplier({ name: 'Phase 06 Supplier', supplier_code: 'P06-SUP-01', phone: '+8801712345678', email: 'supplier@example.com' }, { id: 7 });
    const product = await repo.createProduct({
      sku: 'P06-TEST-002', name_bn: 'পারচেজ পরীক্ষার পণ্য', name_en: 'Receipt Test', slug: 'phase06-receipt-product',
      category_id: 1, regular_price_bdt: '10', sale_price_bdt: '10', cost_price_bdt: '5', opening_stock: '2'
    });
    const failedReference=`P06-PO-AUDIT-ROLLBACK-${process.pid}-${Date.now()}`;
    const purchaseAuditBefore=Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='purchase.create'").n);
    db.rawDb.exec("CREATE TRIGGER p06_fail_purchase_create_audit BEFORE INSERT ON audit_logs WHEN NEW.action='purchase.create' BEGIN SELECT RAISE(ABORT,'fixture purchase create audit failure'); END");
    try { await assert.rejects(()=>repo.createPurchase({supplier_id:supplier.id,reference_no:failedReference,lines:[{product_id:product.id,ordered_qty:2,unit_cost_bdt:'4.50'}]},{id:7})); }
    finally { db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_purchase_create_audit'); }
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM purchases WHERE reference_no=?',failedReference).n),0,'purchase audit failure rolls draft order back');
    assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='purchase.create'").n),purchaseAuditBefore,'failed draft leaves no purchase audit row');
    const po = await repo.createPurchase({ supplier_id: supplier.id, lines: [{ product_id: product.id, ordered_qty: 5, unit_cost_bdt: '4.50' }] }, { id: 7 });
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 2, 'draft PO must not increase stock');
    const item = db.get('SELECT id FROM purchase_items WHERE purchase_id=?', po.id);
    const first = await repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-1', lines: [{ purchase_item_id: item.id, received_qty: 3 }] }, { id: 7 });
    assert.equal(first.status, 'partially_received');
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 5);
    const replay = await repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-1', lines: [{ purchase_item_id: item.id, received_qty: 3 }] }, { id: 7 });
    assert.equal(replay.replayed, true);
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 5, 'duplicate receipt must not double stock');
    assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='purchase.receive' AND entity_id=?",String(po.id)).n),2,'accepted receipt and replay each leave an audit record');
    await assert.rejects(() => repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-1', lines: [{ purchase_item_id: item.id, received_qty: 2 }] }), (err) => err.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    const ledgerBeforeFailedReceipt=Number(db.get('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?',product.id).n);
    const receiptRowsBeforeFailedReceipt=Number(db.get('SELECT COUNT(*) AS n FROM purchase_receipts WHERE purchase_id=?',po.id).n);
    const auditRowsBeforeFailedReceipt=Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='purchase.receive' AND entity_id=?",String(po.id)).n);
    db.rawDb.exec("CREATE TRIGGER p06_fail_purchase_receipt_audit BEFORE INSERT ON audit_logs WHEN NEW.action='purchase.receive' BEGIN SELECT RAISE(ABORT,'fixture receipt audit failure'); END");
    try { await assert.rejects(()=>repo.receivePurchase(po.id,{idempotency_key:'p06-receipt-part-2',lines:[{purchase_item_id:item.id,received_qty:2}]},{id:7})); }
    finally { db.rawDb.exec('DROP TRIGGER IF EXISTS p06_fail_purchase_receipt_audit'); }
    assert.equal(Number(db.get('SELECT stock FROM products WHERE id=?',product.id).stock),5,'audit failure rolls receipt stock back');
    assert.equal(Number(db.get('SELECT received_qty FROM purchase_items WHERE id=?',item.id).received_qty),3,'audit failure rolls received quantity back');
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?',product.id).n),ledgerBeforeFailedReceipt,'audit failure rolls receipt ledger back');
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM purchase_receipts WHERE purchase_id=?',po.id).n),receiptRowsBeforeFailedReceipt,'audit failure rolls receipt record back');
    assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='purchase.receive' AND entity_id=?",String(po.id)).n),auditRowsBeforeFailedReceipt,'failed receipt does not leave an audit row');
    const final = await repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-2', lines: [{ purchase_item_id: item.id, received_qty: 2 }] }, { id: 7 });
    assert.equal(final.status, 'received');
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 7);
    const finalReplay=await repo.receivePurchase(po.id,{idempotency_key:'p06-receipt-part-2',lines:[{purchase_item_id:item.id,received_qty:2}]},{id:7});
    assert.equal(finalReplay.replayed,true,'a final receipt replays after the PO reaches received state');
    assert.equal(db.get('SELECT stock FROM products WHERE id=?',product.id).stock,7,'final receipt replay cannot add stock again');

    const stockBefore=Number(db.get('SELECT stock FROM products WHERE id=?',product.id).stock);
    const ledgerBefore=Number(db.get('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?',product.id).n);
    const auditBefore=Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type IN ('purchase','supplier') AND entity_id IN (?,?)",String(po.id),String(supplier.id)).n);
    const history=await repo.getSupplierPurchaseHistory(supplier.id);
    assert.equal(history.supplier.id,supplier.id);
    assert.equal(history.purchases.length,1);
    assert.equal(history.purchases[0].referenceNo,po.referenceNo);
    assert.equal(history.purchases[0].status,'received');
    assert.equal(history.purchases[0].lineCount,1);
    assert.equal(history.purchases[0].orderedQty,5);
    assert.equal(history.purchases[0].receivedQty,5);
    assert.deepEqual(history.purchases[0].lines.map(({sku,orderedQty,receivedQty})=>({sku,orderedQty,receivedQty})),[
      {sku:'P06-TEST-002',orderedQty:5,receivedQty:5},
    ]);
    assert.equal(history.purchases[0].receipts.length,2);
    assert.deepEqual(history.purchases[0].receipts.map((row)=>row.totalQty).sort(),[2,3]);
    assert.equal(Object.keys(history.purchases[0]).some((key)=>/payable|balance|paid|cost|amount/i.test(key)),false,'history API does not invent or expose supplier settlement calculations');
    assert.equal(Number(db.get('SELECT stock FROM products WHERE id=?',product.id).stock),stockBefore,'read-only history cannot change stock');
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?',product.id).n),ledgerBefore,'read-only history cannot add ledger events');
    assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type IN ('purchase','supplier') AND entity_id IN (?,?)",String(po.id),String(supplier.id)).n),auditBefore,'read-only history cannot add audit events');
    const laterPage=await repo.getSupplierPurchaseHistory(supplier.id,2);
    assert.deepEqual(laterPage.purchases,[]);
    assert.equal(laterPage.hasPreviousPurchases,true);
    assert.equal(laterPage.page,2);
    await assert.rejects(()=>repo.getSupplierPurchaseHistory(supplier.id,'0'),ValidationError,'invalid history pages are rejected');
    await assert.rejects(()=>repo.getSupplierPurchaseHistory(999999999),(err)=>err.statusCode===404,'missing suppliers return not found');
  });

  test('archiving preserves product identity and safe upload rejects SVG signatures', async () => {
    const product = db.get("SELECT id FROM products WHERE code='P06-TEST-001'");
    await repo.archiveProduct(product.id, true, { id: 7 });
    assert.equal(db.get('SELECT is_archived FROM products WHERE id=?', product.id).is_archived, 1);
    await repo.archiveProduct(product.id, false, { id: 7 });
    assert.equal(db.get('SELECT is_archived FROM products WHERE id=?', product.id).is_archived, 0);
    const upload = require('../src/middleware/upload');
    const fake = path.join(os.tmpdir(), `mrtumi-svg-signature-${process.pid}.upload`);
    fs.writeFileSync(fake, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    try { assert.equal(upload.hasValidRasterMagicBytes(fake), false); } finally { fs.unlinkSync(fake); }
  });
});
