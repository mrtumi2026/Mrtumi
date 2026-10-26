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

  test('authorized adjustments are reasoned, ledger-backed and cannot make stock negative', async () => {
    const product = db.get("SELECT id FROM products WHERE code='P06-TEST-001'");
    const result = await repo.adjustStock({ product_id: product.id, stock_pool: 'warehouse', qty_delta: -2, reason: 'Damaged during count' }, { id: 7 });
    assert.equal(result.balanceAfter, 6);
    assert.equal(db.get("SELECT reason FROM stock_ledger WHERE product_id=? AND movement_type='adjustment' ORDER BY id DESC LIMIT 1", product.id).reason, 'Damaged during count');
    await assert.rejects(() => repo.adjustStock({ product_id: product.id, qty_delta: -99, reason: 'Invalid correction' }), AppError);
    await assert.rejects(() => repo.adjustStock({ product_id: product.id, qty_delta: 1, reason: '' }), ValidationError);
  });

  test('purchase order creation leaves stock unchanged; partial and duplicate-safe receipts update stock atomically', async () => {
    const supplier = await repo.createSupplier({ name: 'Phase 06 Supplier', supplier_code: 'P06-SUP-01', phone: '+8801712345678', email: 'supplier@example.com' }, { id: 7 });
    const product = await repo.createProduct({
      sku: 'P06-TEST-002', name_bn: 'পারচেজ পরীক্ষার পণ্য', name_en: 'Receipt Test', slug: 'phase06-receipt-product',
      category_id: 1, regular_price_bdt: '10', sale_price_bdt: '10', cost_price_bdt: '5', opening_stock: '2'
    });
    const po = await repo.createPurchase({ supplier_id: supplier.id, lines: [{ product_id: product.id, ordered_qty: 5, unit_cost_bdt: '4.50' }] }, { id: 7 });
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 2, 'draft PO must not increase stock');
    const item = db.get('SELECT id FROM purchase_items WHERE purchase_id=?', po.id);
    const first = await repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-1', lines: [{ purchase_item_id: item.id, received_qty: 3 }] }, { id: 7 });
    assert.equal(first.status, 'partially_received');
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 5);
    const replay = await repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-1', lines: [{ purchase_item_id: item.id, received_qty: 3 }] }, { id: 7 });
    assert.equal(replay.replayed, true);
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 5, 'duplicate receipt must not double stock');
    await assert.rejects(() => repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-1', lines: [{ purchase_item_id: item.id, received_qty: 2 }] }), (err) => err.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    const final = await repo.receivePurchase(po.id, { idempotency_key: 'p06-receipt-part-2', lines: [{ purchase_item_id: item.id, received_qty: 2 }] }, { id: 7 });
    assert.equal(final.status, 'received');
    assert.equal(db.get('SELECT stock FROM products WHERE id=?', product.id).stock, 7);
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
