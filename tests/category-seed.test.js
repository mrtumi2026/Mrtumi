'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const MYSQL_REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const MYSQL_TEST_DB = process.env.MYSQL_TEST_DB || 'mrtumi_test';
if (MYSQL_REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
if (MYSQL_HOST && (!['127.0.0.1', 'localhost', '::1'].includes(MYSQL_HOST) || MYSQL_TEST_DB !== 'mrtumi_test')) {
  throw new Error('Category seed integration test is restricted to the disposable local mrtumi_test database.');
}
if (MYSQL_HOST) {
  process.env.DB_CLIENT = 'mysql';
  process.env.DB_HOST = MYSQL_HOST;
  process.env.DB_PORT = String(process.env.MYSQL_TEST_PORT || 3306);
  process.env.DB_NAME = MYSQL_TEST_DB;
  process.env.DB_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test';
  process.env.DB_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw';
}
const { CATEGORY_SEEDS, seedCategories, slugifyEnglish } = require('../scripts/seed-categories');
const mysql = require('../src/db/mysqlPool');
const { migrateUp, migrateDown } = require('../src/db/migrator');
const MYSQL_SKIP_REASON = 'SKIPPED locally: no disposable MySQL 8.0 service; executed in required MySQL/MariaDB CI.';

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

test('category seed script runs twice on disposable MySQL with exact bilingual counts and stable parent relationships', { skip: !MYSQL_HOST && MYSQL_SKIP_REASON }, async () => {
  assert.equal(MYSQL_TEST_DB, 'mrtumi_test', 'integration test must only target the dedicated disposable test database');
  const { execFileSync } = require('node:child_process');
  const pool = mysql.getPool();
  const categorySlugs = CATEGORY_SEEDS.map((category) => category.slug);
  const subcategorySlugs = CATEGORY_SEEDS.flatMap((category) => category.subcategories.map(([nameEn]) => `${category.slug}-${slugifyEnglish(nameEn)}`));
  const placeholders = (values) => values.map(() => '?').join(',');
  try {
    await migrateDown(pool, { steps: 12 });
    await migrateUp(pool);
    const db = mysql.createQueryClient(pool);
    const before = await db.queryOne('SELECT (SELECT COUNT(*) FROM categories) AS categories,(SELECT COUNT(*) FROM subcategories) AS subcategories');
    assert.deepEqual([Number(before.categories), Number(before.subcategories)], [0, 0], 'the disposable schema starts without taxonomy rows');
    const expectedSubcategoryCount = subcategorySlugs.length;
    const runScript = () => execFileSync(process.execPath, ['scripts/seed-categories.js'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120000 });
    const snapshot = async () => {
      const categories = await db.queryAll(`SELECT id,slug,name_en,name_bn,icon,sort_order,front_view,status FROM categories ORDER BY slug`);
      const subcategories = await db.queryAll(`SELECT id,category_id,slug,name_en,name_bn,status FROM subcategories ORDER BY slug`);
      return {
        categories: categories.map((row) => ({ ...row, id: Number(row.id), sort_order: Number(row.sort_order), front_view: Number(row.front_view), status: Number(row.status) })),
        subcategories: subcategories.map((row) => ({ ...row, id: Number(row.id), category_id: Number(row.category_id), status: Number(row.status) })),
      };
    };
    try {
      const firstOutput = runScript();
      assert.equal(firstOutput.trim(), `Seeded 15 categories and ${expectedSubcategoryCount} subcategories into MySQL.`);
      const firstSnapshot = await snapshot();
      assert.equal(firstSnapshot.categories.length, 15);
      assert.equal(firstSnapshot.subcategories.length, expectedSubcategoryCount);

      const categoryBySlug = new Map(firstSnapshot.categories.map((row) => [row.slug, row]));
      for (const [index, category] of CATEGORY_SEEDS.entries()) {
        const actual = categoryBySlug.get(category.slug);
        assert.ok(actual, `category ${category.slug} exists`);
        assert.deepEqual([actual.name_en, actual.name_bn, actual.icon, actual.sort_order, actual.front_view, actual.status], [category.nameEn, category.nameBn, category.icon, index + 1, 1, 1]);
        const expectedChildren = category.subcategories.map(([nameEn, nameBn]) => ({ name_en: nameEn, name_bn: nameBn, slug: `${category.slug}-${slugifyEnglish(nameEn)}` })).sort((a, b) => a.slug.localeCompare(b.slug));
        const actualChildren = firstSnapshot.subcategories.filter((row) => row.category_id === actual.id).map(({ name_en, name_bn, slug, status }) => ({ name_en, name_bn, slug, status })).sort((a, b) => a.slug.localeCompare(b.slug));
        assert.deepEqual(actualChildren, expectedChildren.map((row) => ({ ...row, status: 1 })), `subcategory names and category relationship match for ${category.slug}`);
      }

      const secondOutput = runScript();
      assert.equal(secondOutput.trim(), `Seeded 15 categories and ${expectedSubcategoryCount} subcategories into MySQL.`);
      const secondSnapshot = await snapshot();
      assert.deepEqual(secondSnapshot, firstSnapshot, 'second script run changes neither row counts, identities, names nor parent relationships');
    } finally {
      await mysql.withTransaction(async (tx) => {
        if (subcategorySlugs.length) await tx.execute(`DELETE FROM subcategories WHERE slug IN (${placeholders(subcategorySlugs)})`, subcategorySlugs);
        await tx.execute(`DELETE FROM categories WHERE slug IN (${placeholders(categorySlugs)})`, categorySlugs);
      }, { pool });
    }
  } finally {
    await mysql.closePool();
  }
});
