'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY_SEEDS, seedCategories, slugifyEnglish } = require('../scripts/seed-categories');

test('bilingual category taxonomy has 15 unique categories and stable unique subcategory slugs', () => {
  assert.equal(CATEGORY_SEEDS.length, 15);
  assert.equal(new Set(CATEGORY_SEEDS.map((category) => category.slug)).size, 15);
  for (const category of CATEGORY_SEEDS) {
    assert.ok(category.nameEn && category.nameBn && category.icon);
    assert.ok(category.subcategories.length > 0);
    for (const [nameEn, nameBn] of category.subcategories) {
      assert.ok(nameEn && nameBn);
    }
  }
  const slugs = CATEGORY_SEEDS.flatMap((category) => category.subcategories.map(([nameEn]) => `${category.slug}-${slugifyEnglish(nameEn)}`));
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(slugs.every((slug) => /^[a-z0-9-]+$/.test(slug)));
  assert.equal(slugifyEnglish("Men's Shoes & Bags"), 'mens-shoes-and-bags');
});

test('category seed upserts all categories and subcategories inside one transaction', async () => {
  const statements = [];
  let transactionCalls = 0;
  const tx = {
    async execute(sql, params) { statements.push({ sql, params }); return { affectedRows: 1 }; },
    async queryOne(sql, params) {
      assert.match(sql, /SELECT `id` FROM `categories`/);
      return { id: CATEGORY_SEEDS.find((category) => category.slug === params[0]).slug };
    },
  };
  const transaction = async (work) => {
    transactionCalls += 1;
    return work(tx);
  };

  const firstRun = await seedCategories({ dbClient: 'mysql', transaction });
  const secondRun = await seedCategories({ dbClient: 'mysql', transaction });
  const expectedSubcategories = CATEGORY_SEEDS.reduce((total, category) => total + category.subcategories.length, 0);
  assert.deepEqual(firstRun, { categoryCount: 15, subcategoryCount: expectedSubcategories });
  assert.deepEqual(secondRun, firstRun);
  assert.equal(transactionCalls, 2);
  assert.equal(statements.filter(({ sql }) => sql.includes('INSERT INTO `categories`')).length, 30);
  assert.equal(statements.filter(({ sql }) => sql.includes('INSERT INTO `subcategories`')).length, expectedSubcategories * 2);
  assert.ok(statements.every(({ sql }) => /ON DUPLICATE KEY UPDATE/.test(sql)));
});

test('category seed refuses SQLite without opening a transaction', async () => {
  let transactionCalls = 0;
  await assert.rejects(
    seedCategories({ dbClient: 'sqlite', transaction: async () => { transactionCalls += 1; } }),
    /requires DB_CLIENT=mysql/
  );
  assert.equal(transactionCalls, 0);
});
