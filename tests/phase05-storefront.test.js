'use strict';

/**
 * PHASE 05 — CUSTOMER STOREFRONT VERIFICATION SUITE
 *
 * Tests:
 * 1. Promo window & gallery image guards (no hardcoded sample thumbnails or fake countdown dates)
 * 2. Homepage, Category, Subcategory, Brand, Search, Filter, Sort & Pagination
 * 3. Product Detail: DB gallery, SKU, stock badges, unapproved vendor guard, wholesale tier guard & JSON-LD
 * 4. Cart Entry Points (`/cart/add`, `/cart/update`, `/cart/remove`, `/cart/clear`) with stock & wholesale rules
 * 5. Support, FAQ, About, Policy, Blog, Moderated Reviews & SEO (`/sitemap.xml`, `/robots.txt`) in `bn` & `en`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB_PATH = path.join(os.tmpdir(), `mrtumi.phase05.${process.pid}.test.db`);
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = TEST_DB_PATH;
process.env.SEED_DEMO_DATA = 'true';
process.env.LOG_SILENT = 'true';

const storefrontRepo = require('../src/repositories/storefrontRepository');

function cleanupTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (_e) {}
    }
  }
}

function httpRequest(baseUrl, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const reqOpts = {
      method: options.method || 'GET',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: options.headers || {},
    };
    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function mergeCookies(...setCookieLists) {
  const map = new Map();
  for (const list of setCookieLists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

describe('Phase 05 — Customer Storefront, Catalogue, Product Detail, Support & SEO', () => {
  let server;
  let baseUrl;
  let sqliteDb;

  before(async () => {
    cleanupTestDb();
    sqliteDb = require('../src/db/database');
    sqliteDb.initializeDatabase();

    // Seed specific Phase 05 edge-case test fixtures in ephemeral test DB:
    // 1. Multi-image + approved wholesale product
    sqliteDb.run(
      `INSERT INTO products
       (name, slug, code, category_id, subcategory_id, brand_id, old_price, new_price, wholesale_price, wholesale_min_qty,
        stock, sold_count, unit, sizes, colors, image, gallery, short_desc, description, is_flash_sale, is_hot_deal, is_wholesale, approval_status, status)
       VALUES (?, ?, ?, 1, 1, 1, 950, 800, 720, 5, 25, 42, '১ প্যাক', '১ প্যাক,২ প্যাক', 'গোল্ড বক্স',
               '/uploads/product/lychee-box.jpg', ?, 'উৎসবের প্রিমিয়াম ড্রাই ফ্রুট ও গিফট বক্স', 'বিস্তারিত বিবরণ', 1, 1, 1, 'approved', 1)`,
      'প্রিমিয়াম ফেস্টিভ গিফট হ্যাম্পার',
      'premium-festive-gift-hamper',
      'MT-GIFT-501',
      JSON.stringify(['/uploads/product/lychee-box.jpg', '/uploads/product/lychee-organic.jpg'])
    );

    // 2. Single-image out-of-stock product with invalid wholesale (wholesale_price >= new_price)
    sqliteDb.run(
      `INSERT INTO products
       (name, slug, code, category_id, brand_id, old_price, new_price, wholesale_price, wholesale_min_qty,
        stock, sold_count, unit, sizes, colors, image, gallery, short_desc, description, is_flash_sale, is_hot_deal, is_wholesale, approval_status, status)
       VALUES (?, ?, ?, 1, 1, 300, 280, 290, 5, 0, 3, '১ কেজি', '১ কেজি', '',
               '/uploads/product/lychee-fresh.jpg', '[]', 'স্টক আউট পণ্য', 'বিবরণ', 0, 0, 1, 'approved', 1)`,
      'স্টক আউট মিনি প্যাক',
      'out-of-stock-mini-pack',
      'MT-OOS-502'
    );

    // 3. Unapproved vendor product (MUST NEVER appear on storefront or sitemap)
    sqliteDb.run(
      `INSERT INTO products
       (name, slug, code, category_id, vendor_id, old_price, new_price, stock, image, approval_status, status)
       VALUES (?, ?, ?, 1, 1, 500, 450, 20, '/uploads/product/lychee-fresh.jpg', 'pending', 1)`,
      'Unapproved Pending Vendor Item',
      'unapproved-pending-vendor-item',
      'MT-PEND-503'
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
    cleanupTestDb();
  });

  test('1. Promo window & gallery helpers prevent fabricated countdowns and hardcoded sample thumbnails', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');

    // Blank end timestamp -> active promo, but NO countdown date fabricated
    assert.deepEqual(storefrontRepo.parsePromoWindow('1', '', now), {
      active: true,
      countdownIso: null,
    });
    // Disabled promo -> inactive
    assert.deepEqual(storefrontRepo.parsePromoWindow('0', '2027-01-01T00:00:00Z', now), {
      active: false,
      countdownIso: null,
    });
    // Past end timestamp -> expired (inactive)
    assert.deepEqual(storefrontRepo.parsePromoWindow('1', '2025-01-01T00:00:00Z', now), {
      active: false,
      countdownIso: null,
    });
    // Valid future timestamp -> active with exact ISO countdown
    const future = storefrontRepo.parsePromoWindow('1', '2027-01-15T18:00:00Z', now);
    assert.equal(future.active, true);
    assert.equal(future.countdownIso, '2027-01-15T18:00:00.000Z');

    // Single-image gallery returns exactly 1 image
    const single = storefrontRepo.parseGalleryImages('/uploads/product/a.jpg', '[]');
    assert.deepEqual(single, ['/uploads/product/a.jpg']);

    // Multi-image gallery deduplicates primary & rejects path-traversal strings
    const multi = storefrontRepo.parseGalleryImages(
      '/uploads/product/a.jpg',
      JSON.stringify(['/uploads/product/a.jpg', '/uploads/product/b.jpg', '../secret.txt'])
    );
    assert.deepEqual(multi, ['/uploads/product/a.jpg', '/uploads/product/b.jpg']);
  });

  test('2. Homepage, Category, Subcategory, Brand, Search, Filters, Sorting & Pagination work end-to-end', async () => {
    // Clear flash_sale_end so we verify no hardcoded '2027-06-30' leaks into HTML
    sqliteDb.setSetting('flash_sale_end', '');
    const home = await httpRequest(baseUrl, '/');
    assert.equal(home.statusCode, 200);
    assert.ok(!home.body.includes('2027-06-30'), 'Homepage must not render hardcoded fallback countdown');
    assert.ok(!home.body.includes('Unapproved Pending Vendor Item'), 'Pending vendor product must never leak on homepage');

    // Configure a real future flash_sale_end and verify data-countdown appears
    sqliteDb.setSetting('flash_sale_end', '2027-12-31T23:59:59Z');
    const homeWithCountdown = await httpRequest(baseUrl, '/');
    assert.equal(homeWithCountdown.statusCode, 200);
    assert.ok(homeWithCountdown.body.includes('data-countdown="2027-12-31T23:59:59.000Z"'));

    // Search & SKU search
    const skuSearch = await httpRequest(baseUrl, '/all-products?q=MT-GIFT-501');
    assert.equal(skuSearch.statusCode, 200);
    assert.ok(skuSearch.body.includes('প্রিমিয়াম ফেস্টিভ গিফট হ্যাম্পার'));
    assert.ok(!skuSearch.body.includes('স্টক আউট মিনি প্যাক'));

    // In-stock filter excludes out-of-stock item
    const inStockRes = await httpRequest(baseUrl, '/all-products?in_stock=1&per_page=48');
    assert.equal(inStockRes.statusCode, 200);
    assert.ok(!inStockRes.body.includes('out-of-stock-mini-pack'));

    // Price range filter & sort
    const priceRes = await httpRequest(
      baseUrl,
      '/all-products?min_price=750&max_price=850&sort=price_asc'
    );
    assert.equal(priceRes.statusCode, 200);
    assert.ok(priceRes.body.includes('premium-festive-gift-hamper'));

    // Pagination (`per_page=2`) renders reusable pagination partial
    const pagedRes = await httpRequest(baseUrl, '/all-products?per_page=2&page=1');
    assert.equal(pagedRes.statusCode, 200);
    assert.ok(pagedRes.body.includes('pagination'), 'Catalogue must render pagination when total > perPage');

    // Category, Subcategory & Brand routes
    const catRow = sqliteDb.get('SELECT slug FROM categories WHERE status = 1 LIMIT 1');
    const catRes = await httpRequest(baseUrl, `/category/${catRow.slug}`);
    assert.equal(catRes.statusCode, 200);

    const subRow = sqliteDb.get('SELECT slug FROM subcategories WHERE status = 1 LIMIT 1');
    if (subRow) {
      const subRes = await httpRequest(baseUrl, `/subcategory/${subRow.slug}`);
      assert.equal(subRes.statusCode, 200);
    }

    const brandRow = sqliteDb.get('SELECT slug FROM brands WHERE status = 1 LIMIT 1');
    if (brandRow) {
      const brandRes = await httpRequest(baseUrl, `/brand/${brandRow.slug}`);
      assert.equal(brandRes.statusCode, 200);
    }

    // Missing category returns proper 404
    const missingCat = await httpRequest(baseUrl, '/category/does-not-exist-xyz');
    assert.equal(missingCat.statusCode, 404);
  });

  test('3. Product Detail enforces DB gallery, wholesale guard, out-of-stock state, unapproved 404 & JSON-LD', async () => {
    // Multi-image + valid wholesale product
    const prodOk = await httpRequest(baseUrl, '/product/premium-festive-gift-hamper');
    assert.equal(prodOk.statusCode, 200);
    assert.ok(prodOk.body.includes('js-gallery-thumb'), 'Multi-image product must render gallery thumbnails');
    assert.ok(prodOk.body.includes('MT-GIFT-501'), 'Product detail must show SKU');
    assert.ok(prodOk.body.includes('application/ld+json'), 'Product detail must include Schema.org JSON-LD');
    assert.ok(prodOk.body.includes('৭২০') || prodOk.body.includes('720'), 'Approved valid wholesale tier must render');

    // Single-image + invalid wholesale + out-of-stock product
    const prodOos = await httpRequest(baseUrl, '/product/out-of-stock-mini-pack?lang=en');
    assert.equal(prodOos.statusCode, 200);
    assert.ok(
      !prodOos.body.includes('class="p-0 border rounded-3 overflow-hidden bg-white js-gallery-thumb'),
      'Single-image product must NOT render hardcoded gallery thumbnails'
    );
    assert.ok(
      !prodOos.body.includes('Approved Wholesale Tier Pricing'),
      'Invalid wholesale tier (wholesale_price >= new_price) must NOT render'
    );
    assert.ok(prodOos.body.includes('Out of Stock'), 'Out-of-stock badge must appear in English');

    // Unapproved vendor product must return 404
    const pendingRes = await httpRequest(baseUrl, '/product/unapproved-pending-vendor-item');
    assert.equal(pendingRes.statusCode, 404);
  });

  test('4. Cart entry points enforce CSRF, stock availability and approved wholesale tier pricing', async () => {
    const csrfResponse = await httpRequest(baseUrl, '/api/v1/csrf-token');
    const csrfToken = JSON.parse(csrfResponse.body).data.csrfToken;
    const csrfCookie = mergeCookies(csrfResponse.headers['set-cookie']);
    const mutationHeaders = { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: csrfCookie, 'x-csrf-token': csrfToken };
    for (const [path, body] of [['/cart/add',{product_id:1,qty:1}],['/cart/update',{key:'missing',qty:1}],['/cart/remove',{key:'missing'}],['/cart/clear',{}]]) {
      const denied = await httpRequest(baseUrl,path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:csrfCookie},body:JSON.stringify(body)});
      assert.equal(denied.statusCode,403,`${path} rejects a cart mutation without CSRF`);
    }
    const giftProd = sqliteDb.get("SELECT id FROM products WHERE slug = 'premium-festive-gift-hamper'");
    const oosProd = sqliteDb.get("SELECT id FROM products WHERE slug = 'out-of-stock-mini-pack'");

    // Out-of-stock add-to-cart is rejected with 400
    const oosAdd = await httpRequest(baseUrl, '/cart/add', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ product_id: oosProd.id, qty: 1 }),
    });
    assert.equal(oosAdd.statusCode, 400);
    assert.equal(JSON.parse(oosAdd.body).success, false);

    // Add 2 units (< wholesale_min_qty 5) -> retail unit price 800
    const addRetail = await httpRequest(baseUrl, '/cart/add', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ product_id: giftProd.id, qty: 2, size: '১ প্যাক', color: 'গোল্ড বক্স' }),
    });
    assert.equal(addRetail.statusCode, 200);
    const retailData = JSON.parse(addRetail.body);
    assert.equal(retailData.success, true);
    assert.equal(retailData.cartCount, 2);
    assert.equal(retailData.cartSubtotal, 1600);

    const cookieHeader = mergeCookies(addRetail.headers['set-cookie']);

    // Update qty to 5 (>= wholesale_min_qty 5) -> wholesale unit price 720 * 5 = 3600
    const itemKey = retailData.cart[0].key;
    const updWholesale = await httpRequest(baseUrl, '/cart/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookieHeader,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ key: itemKey, qty: 5 }),
    });
    assert.equal(updWholesale.statusCode, 200);
    const wsData = JSON.parse(updWholesale.body);
    assert.equal(wsData.cartSubtotal, 3600);
  });

  test('5. About, FAQ, Contact, Blogs, Moderated Reviews & SEO (`/sitemap.xml`, `/robots.txt`) work in `bn` & `en`', async () => {
    for (const route of ['/about', '/faq', '/contact', '/blogs', '/about?lang=en', '/faq?lang=en', '/contact?lang=en']) {
      const res = await httpRequest(baseUrl, route);
      assert.equal(res.statusCode, 200, `Expected 200 for ${route}`);
      assert.ok(!/ফল\s*বাজার/.test(res.body), `No legacy reference brand allowed on ${route}`);
    }

    // Legal/policy owner-review notice preserved from Phase 04
    const policy = await httpRequest(baseUrl, '/page/return-policy?lang=en');
    assert.equal(policy.statusCode, 200);
    assert.ok(policy.body.includes('mt-copy-review-banner'));

    // Review moderation: submitted review goes to 'pending' and does NOT immediately appear on product page
    const giftProd = sqliteDb.get("SELECT id FROM products WHERE slug = 'premium-festive-gift-hamper'");
    const revSubmit = await httpRequest(baseUrl, '/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        product_id: giftProd.id,
        customer_name: 'Tanvir Ahmed',
        rating: 5,
        comment: 'Unmoderated pending test review string XYZ987',
      }),
    });
    assert.equal(revSubmit.statusCode, 200);
    assert.equal(JSON.parse(revSubmit.body).status, 'pending');

    const prodBeforeApproval = await httpRequest(baseUrl, '/product/premium-festive-gift-hamper');
    assert.ok(
      !prodBeforeApproval.body.includes('XYZ987'),
      'Pending review must NOT display on storefront before admin approval'
    );

    sqliteDb.run("UPDATE reviews SET status = 'approved' WHERE comment LIKE '%XYZ987%'");
    const prodAfterApproval = await httpRequest(baseUrl, '/product/premium-festive-gift-hamper');
    assert.ok(
      prodAfterApproval.body.includes('XYZ987'),
      'Approved review must display on storefront'
    );

    // Contact & Complaint endpoints persist to database
    const contactRes = await httpRequest(baseUrl, '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: 'Nusrat Jahan',
        phone: '01711223344',
        email: 'nusrat@example.com',
        subject: 'Corporate Gift Inquiry',
        message: 'Need 30 festive gift hampers inside Dhaka.',
      }),
    });
    assert.equal(contactRes.statusCode, 200);
    assert.equal(JSON.parse(contactRes.body).success, true);

    const complaintRes = await httpRequest(baseUrl, '/api/complaint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: 'Nusrat Jahan',
        phone: '01711223344',
        invoice_id: '10001',
        details: 'Packaging feedback test',
      }),
    });
    assert.equal(complaintRes.statusCode, 200);
    assert.equal(JSON.parse(complaintRes.body).success, true);

    // SEO: /robots.txt and /sitemap.xml
    const robots = await httpRequest(baseUrl, '/robots.txt');
    assert.equal(robots.statusCode, 200);
    assert.ok(robots.body.includes('Disallow: /admin/'));
    assert.ok(robots.body.includes('/sitemap.xml'));

    const sitemap = await httpRequest(baseUrl, '/sitemap.xml');
    assert.equal(sitemap.statusCode, 200);
    assert.ok(sitemap.body.includes('/product/premium-festive-gift-hamper'));
    assert.ok(
      !sitemap.body.includes('unapproved-pending-vendor-item'),
      'Sitemap must exclude unapproved vendor products'
    );
  });
});
