'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMysqlUpdates, applySqliteUpdates } = require('../scripts/apply-approved-business-launch');

test('applyMysqlUpdates executes schema-conforming queries against MariaDB/MySQL products schema', async () => {
  const executedStatements = [];
  const queryLogs = [];

  const mockTx = {
    async queryOne(sql, params = []) {
      queryLogs.push({ sql, params });

      // 1. Categories
      if (sql.includes('FROM categories')) {
        assert.ok(!sql.includes('`name`'), 'Must not select non-existent column "name" on categories');
        return { id: 10, slug: 'fruits-and-vegetables' };
      }
      // 2. Subcategories
      if (sql.includes('FROM subcategories')) {
        return { id: 25, slug: 'fruits-and-vegetables-fresh-fruits' };
      }
      // 3. Products: Lychee
      if (sql.includes("slug='deshi-lychee-fresh-pack'") || sql.includes("slug='product-5-v675ce0b6f0c36f53'")) {
        // Strict schema check: MUST NOT query column 'name' or 'image' or 'gallery'
        assert.ok(!sql.includes(' name,'), 'Must not query non-existent column "name" in products SELECT');
        assert.ok(!sql.includes(' name '), 'Must not query non-existent column "name" in products WHERE');
        assert.ok(!sql.includes('name LIKE'), 'Must not query non-existent column "name" in products WHERE');
        assert.ok(sql.includes('name_bn'), 'Must query valid column name_bn');
        return {
          id: 5,
          slug: 'product-5-v675ce0b6f0c36f53',
          category_id: 5,
          subcategory_id: null,
          name_bn: 'দেশি লিচু ফ্রেশ প্যাক',
          name_en: 'Deshi Lychee Fresh Pack'
        };
      }
      // 4. Products: Chopper
      if (sql.includes("slug='food-chopper'")) {
        // Strict schema check: MUST NOT query column 'image' or 'gallery' or 'name'
        assert.ok(!sql.includes(' image,'), 'Must not query non-existent column "image" in products SELECT');
        assert.ok(!sql.includes(' gallery,'), 'Must not query non-existent column "gallery" in products SELECT');
        assert.ok(!sql.includes(' name,'), 'Must not query non-existent column "name" in products SELECT');
        assert.ok(sql.includes('image_url'), 'Must query valid column image_url');
        assert.ok(sql.includes('gallery_json'), 'Must query valid column gallery_json');
        return {
          id: 12,
          slug: 'food-chopper',
          image_url: '/uploads/product/lychee-fresh.jpg',
          gallery_json: JSON.stringify(['/uploads/product/lychee-fresh.jpg', '/uploads/custom/chopper-1.jpeg', '/uploads/custom/chopper-2.jpeg']),
          name_bn: 'রান্নাঘরের সরঞ্জামের জন্য ইউএসবি পোর্টেবল ফুড চপার',
          name_en: 'USB Portable Food Chopper'
        };
      }
      return null;
    },

    async execute(sql, params = []) {
      executedStatements.push({ sql, params });

      // Validate UPDATE products statements
      if (sql.includes('UPDATE products')) {
        assert.ok(!sql.includes('image='), 'Must not update non-existent column "image"');
        assert.ok(!sql.includes('gallery='), 'Must not update non-existent column "gallery"');
        // Check price and stock are untouched
        assert.ok(!sql.includes('regular_price_paisa'), 'Must not touch regular_price_paisa');
        assert.ok(!sql.includes('sale_price_paisa'), 'Must not touch sale_price_paisa');
        assert.ok(!sql.includes('stock_on_hand'), 'Must not touch stock_on_hand');
        assert.ok(!sql.includes('unit_label'), 'Must not touch unit_label');
      }

      // Validate INSERT INTO settings
      if (sql.includes('INSERT INTO settings')) {
        assert.ok(sql.includes('setting_key'), 'Settings insert must use setting_key');
        assert.ok(sql.includes('setting_value'), 'Settings insert must use setting_value');
        assert.ok(sql.includes('ON DUPLICATE KEY UPDATE'), 'Settings insert must be idempotent');
      }

      return { affectedRows: 1 };
    }
  };

  const mockTransactionRunner = async (workFn) => {
    return workFn(mockTx);
  };

  const report = await applyMysqlUpdates({ transaction: mockTransactionRunner });

  // 1. Verify products updated report
  assert.equal(report.productsUpdated.length, 2);

  // Product 1: Lychee
  const lycheeReport = report.productsUpdated.find((p) => p.newSlug === 'deshi-lychee-fresh-pack');
  assert.ok(lycheeReport);
  assert.equal(lycheeReport.id, 5);
  assert.equal(lycheeReport.newCategoryId, 10);
  assert.equal(lycheeReport.newCategorySlug, 'fruits-and-vegetables');
  assert.equal(lycheeReport.subcategoryAssigned, true);

  // Product 2: Chopper
  const chopperReport = report.productsUpdated.find((p) => p.slug === 'food-chopper');
  assert.ok(chopperReport);
  assert.equal(chopperReport.id, 12);
  assert.equal(chopperReport.removedImage, '/uploads/product/lychee-fresh.jpg');
  assert.equal(chopperReport.preservedImageUrl, '/uploads/custom/chopper-1.jpeg');
  assert.deepEqual(chopperReport.preservedGallery, ['/uploads/custom/chopper-1.jpeg', '/uploads/custom/chopper-2.jpeg']);

  // 2. Verify settings updated report
  assert.equal(report.settingsUpdated.length, 6);
  const settingsMap = Object.fromEntries(report.settingsUpdated.map((s) => [s.key, s.value]));
  assert.equal(settingsMap.phone, '01973437395');
  assert.equal(settingsMap.site_phone, '01973437395');
  assert.equal(settingsMap.whatsapp, '01973437395');
  assert.equal(settingsMap.site_whatsapp, '01973437395');
  assert.equal(settingsMap.address, '85/9 Eid gha mathe, kajla noton rasta, Jatrabari, Dhaka-1362');
  assert.equal(settingsMap.site_address, '85/9 Eid gha mathe, kajla noton rasta, Jatrabari, Dhaka-1362');
});

test('applyMysqlUpdates rolls back completely on any query or transaction error', async () => {
  let rollbackCalled = false;
  let commitCalled = false;

  const failingTxRunner = async (workFn) => {
    try {
      await workFn({
        async queryOne(sql) {
          if (sql.includes('FROM products')) {
            const err = new Error('Simulated ER_BAD_FIELD_ERROR');
            err.code = 'ER_BAD_FIELD_ERROR';
            throw err;
          }
          return { id: 1 };
        },
        async execute() {
          return { affectedRows: 1 };
        }
      });
      commitCalled = true;
    } catch (err) {
      rollbackCalled = true;
      throw err;
    }
  };

  await assert.rejects(
    async () => {
      await applyMysqlUpdates({ transaction: failingTxRunner });
    },
    (err) => {
      assert.equal(err.code, 'ER_BAD_FIELD_ERROR');
      return true;
    }
  );

  assert.equal(rollbackCalled, true, 'Transaction must trigger rollback upon error');
  assert.equal(commitCalled, false, 'Transaction must never commit upon error');
});

test('applyMysqlUpdates is fully idempotent when run repeatedly', async () => {
  const executedUpdates = [];

  const idempotentTx = {
    async queryOne(sql) {
      if (sql.includes('FROM categories')) return { id: 10, slug: 'fruits-and-vegetables' };
      if (sql.includes('FROM subcategories')) return { id: 25, slug: 'fruits-and-vegetables-fresh-fruits' };
      // After first run, slug is already deshi-lychee-fresh-pack and category is already 10
      if (sql.includes("slug='deshi-lychee-fresh-pack'")) {
        return {
          id: 5,
          slug: 'deshi-lychee-fresh-pack',
          category_id: 10,
          subcategory_id: 25,
          name_bn: 'দেশি লিচু ফ্রেশ প্যাক',
          name_en: 'Deshi Lychee Fresh Pack'
        };
      }
      // Chopper already has clean gallery
      if (sql.includes("slug='food-chopper'")) {
        return {
          id: 12,
          slug: 'food-chopper',
          image_url: '/uploads/custom/chopper-1.jpeg',
          gallery_json: JSON.stringify(['/uploads/custom/chopper-1.jpeg', '/uploads/custom/chopper-2.jpeg']),
          name_bn: 'রান্নাঘরের সরঞ্জামের জন্য ইউএসবি পোর্টেবল ফুড চপার',
          name_en: 'USB Portable Food Chopper'
        };
      }
      return null;
    },
    async execute(sql, params) {
      executedUpdates.push({ sql, params });
      return { affectedRows: 1 };
    }
  };

  const txRunner = async (workFn) => workFn(idempotentTx);

  const report1 = await applyMysqlUpdates({ transaction: txRunner });
  const report2 = await applyMysqlUpdates({ transaction: txRunner });

  assert.deepEqual(report1.productsUpdated, report2.productsUpdated);
  assert.deepEqual(report1.settingsUpdated, report2.settingsUpdated);
});

test('applySqliteUpdates succeeds and writes settings without throwing', async () => {
  const report = await applySqliteUpdates();
  assert.ok(Array.isArray(report.productsUpdated));
  assert.ok(Array.isArray(report.settingsUpdated));
  assert.equal(report.settingsUpdated.length, 6);
});
