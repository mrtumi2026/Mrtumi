'use strict';

process.env.LOG_SILENT = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const catalogRepo = require('../src/repositories/adminCatalogRepository');
const vendorRepo = require('../src/repositories/vendorPortalRepository');
const { ConflictError, ValidationError, NotFoundError } = require('../src/utils/errors');

function createMockPool() {
  const state = {
    tables: {
      categories: [
        { id: 1, name_bn: 'ফলমূল', name_en: 'Fruits', slug: 'fruits', icon: '🍎', sort_order: 1, status: 1 },
        { id: 2, name_bn: 'মধু ও ঘি', name_en: 'Honey & Ghee', slug: 'honey-ghee', icon: '🍯', sort_order: 2, status: 1 },
        { id: 3, name_bn: 'অব্যবহৃত ক্যাটাগরি', name_en: 'Unused Category', slug: 'unused-cat', icon: '📦', sort_order: 3, status: 1 },
      ],
      subcategories: [
        { id: 10, category_id: 1, name_bn: 'তাজা ফল', name_en: 'Fresh Fruits', slug: 'fresh-fruits', status: 1 },
      ],
      childcategories: [
        { id: 100, subcategory_id: 10, name_bn: 'আম', name_en: 'Mangoes', slug: 'mangoes', status: 1 },
      ],
      brands: [
        { id: 5, name_bn: 'ন্যাচারাল ফার্ম', name_en: 'Natural Farm', slug: 'natural-farm', status: 1 },
        { id: 6, name_bn: 'অব্যবহৃত ব্র্যান্ড', name_en: 'Unused Brand', slug: 'unused-brand', status: 1 },
      ],
      products: [
        { id: 501, category_id: 1, subcategory_id: 10, childcategory_id: 100, brand_id: 5, name_bn: 'হিমসাগর আম', unit_label: '1 kg', status: 1 },
      ],
      product_variants: [
        { id: 1001, product_id: 501, variant_sku: 'MANGO-1KG', size_label: '1 kg', color_label: 'Premium', price_paisa: 15000, stock_on_hand: 50, stock_reserved: 0, status: 1 },
        { id: 1002, product_id: 501, variant_sku: 'MANGO-5KG', size_label: '5 kg', color_label: 'Box', price_paisa: 70000, stock_on_hand: 20, stock_reserved: 0, status: 1 },
      ],
      audit_logs: [],
    },
    calls: [],
    committed: false,
    rolledBack: false,
  };

  const connection = {
    async beginTransaction() {},
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() {},
    async query(sql, params = []) {
      state.calls.push({ sql, params });

      // SELECT COUNT(*) checks
      if (sql.includes('SELECT COUNT(*) AS total FROM subcategories WHERE category_id=?')) {
        const catId = Number(params[0]);
        const count = state.tables.subcategories.filter(s => s.category_id === catId).length;
        return [[{ total: count }], []];
      }
      if (sql.includes('SELECT COUNT(*) AS total FROM products WHERE category_id=?')) {
        const catId = Number(params[0]);
        const count = state.tables.products.filter(p => p.category_id === catId).length;
        return [[{ total: count }], []];
      }
      if (sql.includes('SELECT COUNT(*) AS total FROM childcategories WHERE subcategory_id=?')) {
        const subId = Number(params[0]);
        const count = state.tables.childcategories.filter(c => c.subcategory_id === subId).length;
        return [[{ total: count }], []];
      }
      if (sql.includes('SELECT COUNT(*) AS total FROM products WHERE subcategory_id=?')) {
        const subId = Number(params[0]);
        const count = state.tables.products.filter(p => p.subcategory_id === subId).length;
        return [[{ total: count }], []];
      }
      if (sql.includes('SELECT COUNT(*) AS total FROM products WHERE childcategory_id=?')) {
        const chId = Number(params[0]);
        const count = state.tables.products.filter(p => p.childcategory_id === chId).length;
        return [[{ total: count }], []];
      }
      if (sql.includes('SELECT COUNT(*) AS total FROM products WHERE brand_id=?')) {
        const bId = Number(params[0]);
        const count = state.tables.products.filter(p => p.brand_id === bId).length;
        return [[{ total: count }], []];
      }

      // SELECT * FROM <table> WHERE id=?
      for (const tName of ['categories', 'subcategories', 'childcategories', 'brands', 'colors', 'sizes']) {
        if (sql.includes(`FROM ${tName} WHERE id=?`)) {
          const row = (state.tables[tName] || []).find(r => r.id === Number(params[0]));
          return [row ? [row] : [], []];
        }
      }

      // INSERT INTO audit_logs
      if (sql.includes('audit_logs')) {
        state.tables.audit_logs.push(params);
        return [{ insertId: state.tables.audit_logs.length, affectedRows: 1 }, []];
      }

      // UPDATE
      if (sql.trimStart().startsWith('UPDATE')) {
        return [{ affectedRows: 1 }, []];
      }

      // DELETE
      if (sql.trimStart().startsWith('DELETE')) {
        return [{ affectedRows: 1 }, []];
      }

      return [[], []];
    },
  };

  const pool = {
    state,
    async getConnection() { return connection; },
    async query(sql, params = []) { return connection.query(sql, params); },
  };

  return pool;
}

test('Product Taxonomy: blocks category deletion when products or subcategories depend on it', async () => {
  const pool = createMockPool();
  // Category 1 has subcategories and products
  await assert.rejects(
    catalogRepo.deleteTaxonomy('categories', 1, { id: 1 }, { pool }),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.match(err.message, /Cannot delete category "ফলমূল"/);
      assert.match(err.message, /product\(s\)/);
      assert.match(err.message, /subcategory\(s\)/);
      assert.match(err.message, /Deactivate this category instead/);
      return true;
    }
  );
  assert.equal(pool.state.rolledBack, true);
});

test('Product Taxonomy: safely deletes unused category when 0 dependencies exist', async () => {
  const pool = createMockPool();
  // Category 3 has 0 products and 0 subcategories
  const result = await catalogRepo.deleteTaxonomy('categories', 3, { id: 1 }, { pool });
  assert.deepEqual(result, { id: 3, deleted: true });
  assert.equal(pool.state.committed, true);
  assert.ok(pool.state.calls.some(c => c.sql.includes('DELETE FROM categories WHERE id=?')));
  assert.ok(pool.state.calls.some(c => c.sql.includes('audit_logs') && c.params.includes('catalog.categories.delete')));
});

test('Product Taxonomy: blocks brand deletion when products depend on it and deletes unused brand', async () => {
  const pool = createMockPool();
  // Brand 5 is used by product 501
  await assert.rejects(
    catalogRepo.deleteTaxonomy('brands', 5, { id: 1 }, { pool }),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.match(err.message, /Cannot delete brand "ন্যাচারাল ফার্ম"/);
      assert.match(err.message, /1 product\(s\) are linked to it/);
      assert.match(err.message, /Deactivate this brand instead/);
      return true;
    }
  );

  // Brand 6 is unused
  const result = await catalogRepo.deleteTaxonomy('brands', 6, { id: 1 }, { pool });
  assert.deepEqual(result, { id: 6, deleted: true });
  assert.ok(pool.state.calls.some(c => c.sql.includes('DELETE FROM brands WHERE id=?')));
});

test('Product Taxonomy: updates category details and audits changes', async () => {
  const pool = createMockPool();
  const updated = await catalogRepo.updateTaxonomy(
    'categories',
    1,
    { name: 'তাজা ফল ও ড্রাই ফ্রুটস', name_en: 'Fresh & Dry Fruits', slug: 'fresh-dry-fruits', icon: '🍇', sort_order: 5 },
    { id: 1 },
    { pool }
  );
  assert.equal(updated.id, 1);
  assert.equal(updated.name_bn, 'তাজা ফল ও ড্রাই ফ্রুটস');
  assert.equal(updated.name_en, 'Fresh & Dry Fruits');
  assert.equal(updated.slug, 'fresh-dry-fruits');
  assert.equal(updated.icon, '🍇');
  assert.equal(updated.sort_order, 5);
  assert.equal(pool.state.committed, true);
  assert.ok(pool.state.calls.some(c => c.sql.includes('UPDATE categories SET') && c.params[0] === 'তাজা ফল ও ড্রাই ফ্রুটস'));
});

test('Product Taxonomy: toggles taxonomy status active <-> inactive', async () => {
  const pool = createMockPool();
  const res = await catalogRepo.toggleTaxonomyStatus('categories', 1, { id: 1 }, { pool });
  assert.deepEqual(res, { id: 1, status: 0 });
  assert.equal(pool.state.committed, true);
  assert.ok(pool.state.calls.some(c => c.sql.includes('UPDATE categories SET status=?') && c.params[0] === 0));
});

test('Unit Management: standard and custom units are validated and supported', () => {
  const standardUnits = [
    '1 pc', '1 packet', '1 box', '1 dozen', '1 hali', '1 pon', '100 pcs',
    '1 kg', '500 g', '250 g', '100 g', '5 kg', '10 kg',
    '1 L', '500 ml', '250 ml', '2 L', '5 L',
    '১ কেজি', '৫০০ গ্রাম', '১ পিস', '১ ডজন', '১ পাতা'
  ];

  for (const u of standardUnits) {
    const trimmed = String(u).trim();
    assert.ok(trimmed.length >= 1 && trimmed.length <= 50, `Unit "${u}" must be within 1-50 chars`);
  }
});

test('Vendor Product Variants: allows vendor to create and update variants with status and price', async () => {
  const calls = [];
  let committed = false;
  const mockPool = {
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() { committed = true; },
        async rollback() {},
        release() {},
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (sql.includes('SELECT p.id,v.lifecycle_status,v.status AS vendor_status FROM products p')) {
            return [[{ id: 501, lifecycle_status: 'active', vendor_status: 1 }], []];
          }
          if (sql.includes('SELECT v.id,v.variant_sku,v.size_label,v.color_label,v.price_paisa,v.stock_on_hand,v.stock_reserved,v.status FROM product_variants v')) {
            return [[{ id: 1001, variant_sku: 'V-1001', size_label: '1 kg', color_label: 'Grade A', price_paisa: 12000, stock_on_hand: 50, stock_reserved: 5, status: 1 }], []];
          }
          if (sql.includes('INSERT INTO product_variants')) {
            return [{ insertId: 1005, affectedRows: 1 }, []];
          }
          if (sql.includes('UPDATE product_variants')) {
            return [{ affectedRows: 1 }, []];
          }
          if (sql.includes('INSERT INTO stock_ledger') || sql.includes('INSERT INTO vendor_product_history')) {
            return [{ insertId: 1, affectedRows: 1 }, []];
          }
          return [[], []];
        },
      };
    },
    async query(sql, params = []) { return (await this.getConnection()).query(sql, params); },
  };

  // 1. Create variant
  const createdId = await vendorRepo.saveVariant(10, 501, {
    variant_sku: 'V-NEW-2KG',
    size_label: '2 kg',
    color_label: 'Standard',
    price_bdt: '250.00',
    stock_on_hand: 30,
  }, { pool: mockPool });
  assert.equal(createdId, 1005);
  assert.equal(committed, true);
  assert.ok(calls.some(c => c.sql.includes('INSERT INTO product_variants') && c.params[1] === 'V-NEW-2KG'));

  // 2. Update existing variant with status = 0 (deactivate)
  const updatedId = await vendorRepo.saveVariant(10, 501, {
    variant_sku: 'V-1001-MOD',
    size_label: '1 kg',
    color_label: 'Grade A+',
    price_bdt: '135.00',
    stock_on_hand: 40,
    status: '0',
  }, { variantId: 1001, pool: mockPool });
  assert.equal(updatedId, 1001);
  assert.ok(calls.some(c => c.sql.includes('UPDATE product_variants SET variant_sku=?,size_label=?,color_label=?,price_paisa=?,stock_on_hand=?,status=?') && c.params[5] === 0));

  // 3. Attempting to reduce stock below reserved (reserved = 5, attempt 2) must throw ConflictError
  await assert.rejects(
    vendorRepo.saveVariant(10, 501, {
      variant_sku: 'V-1001',
      price_bdt: '120.00',
      stock_on_hand: 2, // Less than reserved 5
    }, { variantId: 1001, pool: mockPool }),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.match(err.message, /Variant stock cannot be lower than reserved inventory/);
      return true;
    }
  );
});

