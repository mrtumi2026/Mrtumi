'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateSafeProductSlug, SAFE_SLUG } = require('../src/utils/slug');
const { loadMigrationPairs } = require('../src/db/migrator');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('product slug generation is always ASCII-safe for Bengali, punctuation and damaged encodings', () => {
  const cases = [
    ['আপেল', 'Fresh Apple', 'SKU-42', 5],
    ['???', '???', 'SKU/5 ?#', 5],
    ['', '', '', 9],
    ['নতুন পণ্য', 'Café & Gift', null, 12],
    ['a?b #c%', 'English Product', null, null],
  ];
  for (const args of cases) {
    const slug = generateSafeProductSlug(...args);
    assert.match(slug, SAFE_SLUG);
    assert.ok(/^[\x00-\x7f]+$/.test(slug));
    assert.doesNotMatch(slug, /[?%#\s/]/);
  }
  assert.match(generateSafeProductSlug('বাংলা নাম', 'English Name', 'SKU-5', 5), /^english-name-/);
  assert.match(generateSafeProductSlug('???', '', '', 5), /^product-5$/);
});

test('vendor, admin and phase06 product writes use the centralized slug generator', () => {
  assert.match(read('src/routes/vendorPanel.js'), /generateSafeProductSlug/);
  assert.match(read('src/repositories/vendorPortalRepository.js'), /generateSafeProductSlug/);
  assert.match(read('src/routes/adminCatalog.js'), /generateSafeProductSlug/);
  assert.match(read('src/repositories/phase06Repository.js'), /generateSafeProductSlug/);
  assert.doesNotMatch(read('src/repositories/vendorPortalRepository.js'), /function slugify\(/);
});

test('product links fall back to product IDs when persisted slugs are unsafe', () => {
  const card = read('views/store/partials/product-card.ejs');
  assert.equal((card.match(/!String\(p\.slug\)\.includes\('\?'\)/g) || []).length, 2);
  for (const file of ['views/store/cart.ejs', 'views/admin/products.ejs', 'views/vendor/products.ejs']) {
    assert.match(read(file), /!String\((?:p|it)\.slug\)\.includes\('\?'\)/);
  }
  assert.match(read('public/frontEnd/js/storefront.js'), /function productPath\(product\)/);
  assert.match(read('src/routes/storefront.js'), /function safeProductPath\(product\)/);
});

test('0022 migration repairs the reported question-mark slugs and all non-ASCII URL segments', () => {
  const pairs = loadMigrationPairs(path.join(__dirname, '..', 'src/db/migrations'));
  const migration = pairs.find((item) => item.version === '0022');
  assert.ok(migration);
  assert.match(migration.upSql, /WHERE `slug` LIKE '%\?%' OR `slug` = '' OR `slug` IS NULL/);
  assert.ok(migration.upSql.includes("WHERE `slug` NOT REGEXP '^[A-Za-z0-9-]+$'"));
  assert.match(migration.downSql, /Irreversible data repair/);
});
