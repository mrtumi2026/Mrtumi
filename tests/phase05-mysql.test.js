'use strict';

/**
 * PHASE 05 — LIVE MYSQL 8.0 STOREFRONT REPOSITORY & END-TO-END HTTP SUITE
 *
 * Verifies that BOTH `src/repositories/storefrontRepository.js` AND the live
 * Express HTTP storefront (`server.js` booted with `DB_CLIENT=mysql`, where any
 * accidental SQLite call immediately throws `SQLITE_CALLER_NOT_MIGRATED`) run
 * 100% natively against real MySQL 8.0 (`InnoDB`, `utf8mb4_unicode_ci`, integer
 * `paisa` columns, `product_variants`, `ADR-006` warehouse vs vendor stock pools).
 *
 * Skips locally with explicit reason when `MYSQL_TEST_HOST` is not present;
 * strictly required (`MYSQL_TEST_REQUIRED=true`) in GitHub Actions `mysql:8.0` CI.
 */

const http = require('http');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const MYSQL_REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const MYSQL_HOST = (process.env.MYSQL_TEST_HOST || '').trim();

if (MYSQL_REQUIRED && !MYSQL_HOST) {
  throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
}

// Configure process.env BEFORE requiring `env.js` / `server.js` so the Express app
// boots in strict MySQL mode (`DB_CLIENT=mysql`) when `MYSQL_TEST_HOST` is available.
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

const { getPool, closePool, createQueryClient } = require('../src/db/mysqlPool');
const { migrateUp, migrateDown } = require('../src/db/migrator');
const storefrontRepo = require('../src/repositories/storefrontRepository');
const { bdtToPaisa } = require('../src/utils/money');

const SKIP_REASON =
  'SKIPPED locally: no local mysqld/docker in sandbox; runs against real mysql:8.0 service in GitHub Actions CI';

const mysqlCfg = { db: { client: 'mysql' } };

function httpRequest(baseUrl, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: options.headers || {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('Phase 05 — Real MySQL 8.0 Storefront Repository, Variants, Stock Pools & Live HTTP', () => {
  let pool = null;
  let client = null;
  let server = null;
  let baseUrl = '';
  let variant5KgId = null;
  let inhouseProdId = null;

  before(async () => {
    if (!MYSQL_HOST) return;
    pool = getPool();
    client = createQueryClient(pool);
    await migrateDown(pool, { steps: 10 });
    await migrateUp(pool);

    const catRes = await client.execute(
      "INSERT INTO `categories` (`name_bn`, `name_en`, `slug`, `icon`, `front_view`, `sort_order`, `status`) VALUES ('চাল ও ডাল', 'Rice & Lentils', 'rice-lentils', '🌾', 1, 1, 1)"
    );
    const catId = Number(catRes.insertId);

    const subRes = await client.execute(
      "INSERT INTO `subcategories` (`category_id`, `name_bn`, `name_en`, `slug`, `status`) VALUES (?, 'সুগন্ধি চাল', 'Aromatic Rice', 'aromatic-rice', 1)",
      [catId]
    );
    const subId = Number(subRes.insertId);

    const childRes = await client.execute(
      "INSERT INTO `childcategories` (`subcategory_id`, `name_bn`, `name_en`, `slug`, `status`) VALUES (?, 'চিনিগুঁড়া চাল', 'Chinigura Rice', 'chinigura-rice', 1)",
      [subId]
    );
    const childId = Number(childRes.insertId);

    const brandRes = await client.execute(
      "INSERT INTO `brands` (`name_bn`, `name_en`, `slug`, `status`) VALUES ('মি. তুমি সিলেক্ট', 'Mr. Tumi Select', 'mr-tumi-select', 1)"
    );
    const brandId = Number(brandRes.insertId);

    const vendorHash = bcrypt.hashSync('VendorPass#2026', 8);
    const verifiedVendorRes = await client.execute(
      "INSERT INTO `vendors` (`shop_name`, `owner_name`, `phone`, `password_hash`, `verified`, `status`) VALUES ('Dhaka Gift Craft', 'Karim', '01755000111', ?, 1, 1)",
      [vendorHash]
    );
    const verifiedVendorId = Number(verifiedVendorRes.insertId);

    // 1. In-house product with variants + gallery + approved wholesale + gift flag
    const inhouseProdRes = await client.execute(
      `INSERT INTO \`products\`
       (\`sku\`, \`barcode\`, \`slug\`, \`name_bn\`, \`name_en\`, \`category_id\`, \`subcategory_id\`, \`childcategory_id\`, \`brand_id\`,
        \`regular_price_paisa\`, \`sale_price_paisa\`, \`wholesale_price_paisa\`, \`wholesale_min_qty\`,
        \`stock_on_hand\`, \`stock_reserved\`, \`sold_count\`, \`unit_label\`, \`image_url\`, \`gallery_json\`,
        \`short_desc_bn\`, \`short_desc_en\`, \`is_flash_sale\`, \`is_hot_deal\`, \`is_wholesale\`, \`is_gift_eligible\`, \`approval_status\`, \`status\`)
       VALUES ('MT-RICE-01', '8941100001', 'chinigura-gift-pack', 'প্রিমিয়াম চিনিগুঁড়া চাল প্যাক', 'Premium Chinigura Rice Pack',
               ?, ?, ?, ?, ?, ?, ?, 6, 30, 5, 18, '2 kg', '/uploads/product/lychee-box.jpg', ?,
               'সুগন্ধি দিনাজপুরের চিনিগুঁড়া চাল', 'Aromatic Dinajpur Chinigura rice', 1, 1, 1, 1, 'approved', 1)`,
      [
        catId,
        subId,
        childId,
        brandId,
        bdtToPaisa(420),
        bdtToPaisa(360),
        bdtToPaisa(330),
        JSON.stringify(['/uploads/product/lychee-box.jpg', '/uploads/product/lychee-organic.jpg']),
      ]
    );
    inhouseProdId = Number(inhouseProdRes.insertId);

    await client.execute(
      `INSERT INTO \`product_variants\`
       (\`product_id\`, \`variant_sku\`, \`size_label\`, \`color_label\`, \`price_paisa\`, \`stock_on_hand\`, \`stock_reserved\`, \`status\`)
       VALUES (?, 'MT-RICE-01-2KG', '2 kg', 'Standard', ?, 20, 2, 1)`,
      [inhouseProdId, bdtToPaisa(360)]
    );
    const v5Res = await client.execute(
      `INSERT INTO \`product_variants\`
       (\`product_id\`, \`variant_sku\`, \`size_label\`, \`color_label\`, \`price_paisa\`, \`stock_on_hand\`, \`stock_reserved\`, \`status\`)
       VALUES (?, 'MT-RICE-01-5KG', '5 kg', 'Family Pack', ?, 10, 3, 1)`,
      [inhouseProdId, bdtToPaisa(880)]
    );
    variant5KgId = Number(v5Res.insertId);

    // 2. Approved Vendor product using separate vendor_stock_on_hand pool (ADR-006)
    await client.execute(
      `INSERT INTO \`products\`
       (\`sku\`, \`slug\`, \`name_bn\`, \`name_en\`, \`category_id\`, \`vendor_id\`,
        \`regular_price_paisa\`, \`sale_price_paisa\`, \`stock_on_hand\`, \`vendor_stock_on_hand\`, \`vendor_stock_reserved\`,
        \`image_url\`, \`is_gift_eligible\`, \`approval_status\`, \`status\`)
       VALUES ('VD-GIFT-01', 'artisan-date-gift-box', 'খেজুর গিফট বক্স', 'Artisan Date Gift Box',
               ?, ?, ?, ?, 0, 15, 3, '/uploads/product/lychee-fresh.jpg', 1, 'approved', 1)`,
      [catId, verifiedVendorId, bdtToPaisa(1200), bdtToPaisa(1050)]
    );

    // 3. Pending Vendor product (must NEVER appear on storefront)
    await client.execute(
      `INSERT INTO \`products\`
       (\`sku\`, \`slug\`, \`name_bn\`, \`name_en\`, \`category_id\`, \`vendor_id\`,
        \`regular_price_paisa\`, \`sale_price_paisa\`, \`vendor_stock_on_hand\`, \`approval_status\`, \`status\`)
       VALUES ('VD-PEND-01', 'unapproved-vendor-box', 'অননুমোদিত বক্স', 'Unapproved Vendor Box',
               ?, ?, ?, ?, 12, 'pending', 1)`,
      [catId, verifiedVendorId, bdtToPaisa(600), bdtToPaisa(550)]
    );

    await client.execute(
      "INSERT INTO `banners` (`title`, `subtitle`, `position`, `image_url`, `link_url`, `sort_order`, `status`) VALUES ('রমজান ও ঈদ গিফট', 'সারা দেশে ডেলিভারি', 'hero', '/uploads/banner/banner-1.jpg', '/all-products', 1, 1)"
    );
    await client.execute(
      "INSERT INTO `blogs` (`title`, `slug`, `category`, `image_url`, `excerpt`, `content`, `status`) VALUES ('চিনিগুঁড়া চাল সংরক্ষণের উপায়', 'how-to-store-chinigura-rice', 'Kitchen Tips', '/uploads/banner/banner-1.jpg', 'সহজ টিপস', 'পূর্ণ গাইড', 1)"
    );
    await client.execute(
      "INSERT INTO `cms_pages` (`title_bn`, `title_en`, `slug`, `content_bn`, `content_en`, `status`) VALUES ('আমাদের সম্পর্কে', 'About Mr. Tumi', 'about-us', 'বাংলা বিবরণ', 'English verified summary', 1)"
    );

    const { startServer } = require('../server');
    await new Promise((resolve) => {
      server = startServer(0, '127.0.0.1');
      server.once('listening', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (pool) {
      await migrateDown(pool, { steps: 10 });
      await closePool();
    }
  });

  test(
    '1. MySQL Homepage, Facets, Filters, Paisa Price Range, Pagination & Bilingual Localization',
    { skip: !MYSQL_HOST ? SKIP_REASON : false },
    async () => {
      const homeEn = await storefrontRepo.getHomepageData(
        {
          locale: 'en',
          siteSettings: { flash_sale_enabled: '1', flash_sale_end: '2028-01-01T00:00:00Z' },
        },
        pool,
        mysqlCfg
      );
      assert.equal(homeEn.heroBanners.length, 1);
      assert.equal(homeEn.flashProducts.length, 1);
      assert.equal(homeEn.flashProducts[0].name, 'Premium Chinigura Rice Pack');
      assert.equal(homeEn.flashCountdownIso, '2028-01-01T00:00:00.000Z');
      assert.equal(homeEn.giftProducts.length, 2);

      const listRes = await storefrontRepo.listStorefrontProducts(
        {
          locale: 'en',
          childcategorySlug: 'chinigura-rice',
          minPrice: 300,
          maxPrice: 400,
          inStockOnly: true,
        },
        pool,
        mysqlCfg
      );
      assert.equal(listRes.total, 1);
      assert.equal(listRes.items[0].sku, 'MT-RICE-01');
      assert.equal(listRes.items[0].new_price, 360);
      assert.equal(listRes.items[0].available_stock, 25);
      assert.equal(listRes.items[0].variants.length, 2);
      assert.equal(listRes.items[0].has_valid_wholesale, true);

      const allActive = await storefrontRepo.listStorefrontProducts({ locale: 'en' }, pool, mysqlCfg);
      assert.equal(allActive.total, 2);
      const vendorItem = allActive.items.find((i) => i.slug === 'artisan-date-gift-box');
      assert.ok(vendorItem);
      assert.equal(vendorItem.available_stock, 12);
    }
  );

  test(
    '2. MySQL Product Detail, Review Moderation, Contact/Complaint/Newsletter & Sitemap',
    { skip: !MYSQL_HOST ? SKIP_REASON : false },
    async () => {
      const detail = await storefrontRepo.getStorefrontProductDetail(
        'chinigura-gift-pack',
        { locale: 'en' },
        pool,
        mysqlCfg
      );
      assert.ok(detail);
      assert.equal(detail.product.gallery_images.length, 2);
      assert.equal(detail.product.variants[1].price, 880);
      assert.equal(detail.product.variants[1].available_stock, 7);

      const pendingDetail = await storefrontRepo.getStorefrontProductDetail(
        'unapproved-vendor-box',
        { locale: 'en' },
        pool,
        mysqlCfg
      );
      assert.equal(pendingDetail, null);

      const rev = await storefrontRepo.submitProductReview(
        {
          productId: detail.product.id,
          customerName: 'Farhana Rahman',
          rating: 5,
          comment: 'Authentic aromatic Chinigura!',
        },
        pool,
        mysqlCfg
      );
      assert.equal(rev.ok, true);
      assert.equal(rev.status, 'pending');

      await client.execute("UPDATE `reviews` SET `status` = 'approved' WHERE `id` = ?", [rev.id]);
      const afterApprove = await storefrontRepo.getStorefrontProductDetail(
        'chinigura-gift-pack',
        { locale: 'en' },
        pool,
        mysqlCfg
      );
      assert.equal(afterApprove.reviewStats.count, 1);
      assert.equal(afterApprove.reviewStats.averageRating, 5);

      assert.equal(
        (await storefrontRepo.submitContactMessage(
          { name: 'Test User', phone: '01700000000', message: 'Hello MySQL' },
          pool,
          mysqlCfg
        )).ok,
        true
      );
      assert.equal(
        (await storefrontRepo.submitComplaint(
          { name: 'Test User', phone: '01700000000', invoiceNo: 'INV-101', details: 'Box dented' },
          pool,
          mysqlCfg
        )).ok,
        true
      );
      await storefrontRepo.subscribeNewsletter('reader@mrtumi.com', pool, mysqlCfg);
      await storefrontRepo.subscribeNewsletter('reader@mrtumi.com', pool, mysqlCfg);

      const sitemap = await storefrontRepo.getSitemapEntries(pool, mysqlCfg);
      assert.equal(sitemap.products.length, 2);
      assert.equal(sitemap.childcategories.length, 1);
    }
  );

  test(
    '3. Live Express HTTP Storefront runs 100% natively on MySQL 8.0 (`DB_CLIENT=mysql`) with zero SQLite calls',
    { skip: !MYSQL_HOST ? SKIP_REASON : false },
    async () => {
      for (const route of [
        '/',
        '/?lang=en',
        '/all-products?q=Chinigura&lang=en',
        '/category/rice-lentils?lang=en',
        '/subcategory/aromatic-rice?lang=en',
        '/childcategory/chinigura-rice?lang=en',
        '/brand/mr-tumi-select?lang=en',
        '/flash-sales?lang=en',
        '/hot-deals?lang=en',
        '/product/chinigura-gift-pack?lang=en',
        '/about?lang=en',
        '/faq?lang=en',
        '/contact?lang=en',
        '/blogs',
        '/blog/how-to-store-chinigura-rice',
        '/sitemap.xml',
        '/robots.txt',
      ]) {
        const res = await httpRequest(baseUrl, route);
        assert.equal(res.statusCode, 200, `MySQL HTTP route ${route} must return 200`);
      }

      // Add 5 kg structured variant (`price = 880 BDT`) to cart over HTTP in MySQL mode!
      const cartAdd = await httpRequest(baseUrl, '/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          product_id: inhouseProdId,
          variant_id: variant5KgId,
          qty: 2,
        }),
      });
      assert.equal(cartAdd.statusCode, 200);
      const cartPayload = JSON.parse(cartAdd.body);
      assert.equal(cartPayload.success, true);
      assert.equal(cartPayload.cartCount, 2);
      assert.equal(cartPayload.cartSubtotal, 1760);
      assert.equal(cartPayload.cart[0].sku, 'MT-RICE-01-5KG');
    }
  );
});
