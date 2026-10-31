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
process.env.ANALYTICS_ATTRIBUTION_ENABLED = 'true';
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
const checkoutRepo = require('../src/repositories/checkoutRepository');
const customerRepo = require('../src/repositories/customerRepository');
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
  let deliveryLocationId = null;

  before(async () => {
    if (!MYSQL_HOST) return;
    pool = getPool();
    client = createQueryClient(pool);
    await migrateDown(pool, { steps: 11 });
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
    deliveryLocationId = (await client.execute("INSERT INTO delivery_locations (division,district,upazila,delivery_charge_paisa,status) VALUES ('Dhaka Division','Dhaka','Dhanmondi',5500,1)")).insertId;
    await client.execute("INSERT INTO payment_gateways (name,code,gateway_type,sandbox,status) VALUES ('Cash on delivery','cod','manual',1,1)");

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
      await migrateDown(pool, { steps: 11 });
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

      // Cart mutations are CSRF-protected in MySQL mode as well as the local prototype.
      const csrfStart = await httpRequest(baseUrl, '/api/v1/csrf-token');
      assert.equal(csrfStart.statusCode,200);
      const cartCsrf = JSON.parse(csrfStart.body).data.csrfToken;
      const cartCookie = (Array.isArray(csrfStart.headers['set-cookie']) ? csrfStart.headers['set-cookie'] : [csrfStart.headers['set-cookie']]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
      for (const invalidQty of [0, -1, 1.5, 100, '2tail', [2], { quantity: 2 }]) {
        const invalidAdd = await httpRequest(baseUrl, '/cart/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cartCookie, 'x-csrf-token': cartCsrf },
          body: JSON.stringify({ product_id: inhouseProdId, variant_id: variant5KgId, qty: invalidQty }),
        });
        assert.equal(invalidAdd.statusCode, 400, `invalid MySQL cart-add quantity ${JSON.stringify(invalidQty)} is rejected`);
      }
      const emptyAfterInvalidAdds = await httpRequest(baseUrl, '/cart/json', { headers: { Cookie: cartCookie, Accept: 'application/json' } });
      assert.equal(JSON.parse(emptyAfterInvalidAdds.body).cartCount, 0, 'invalid MySQL cart-add quantities do not persist or enter the session cart');

      // Add 5 kg structured variant (`price = 880 BDT`) to cart over HTTP in MySQL mode!
      const cartAdd = await httpRequest(baseUrl, '/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie:cartCookie, 'x-csrf-token':cartCsrf },
        body: JSON.stringify({
          product_id: inhouseProdId,
          variant_id: variant5KgId,
          qty: 2,
        }),
      });
      assert.equal(cartAdd.statusCode, 200, `MySQL cart-add HTTP failed: ${cartAdd.body.slice(0,500)}`);
      const cartPayload = JSON.parse(cartAdd.body);
      assert.equal(cartPayload.success, true);
      assert.equal(cartPayload.cartCount, 2);
      assert.equal(cartPayload.cartSubtotal, 1760);
      assert.equal(cartPayload.cart[0].sku, 'MT-RICE-01-5KG');

      const setCookie = cartAdd.headers['set-cookie'];
      let cookieHeader = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
      const cartItemKey=cartPayload.cart[0].key;
      const invalidQty=await httpRequest(baseUrl,'/cart/update',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:cookieHeader,'x-csrf-token':cartCsrf},body:JSON.stringify({key:cartItemKey,qty:'2.5'})});
      assert.equal(invalidQty.statusCode,400,'fractional cart quantity is rejected without altering cart state');
      const variantStock=await client.queryOne('SELECT stock_on_hand,stock_reserved FROM product_variants WHERE id=?',[variant5KgId]);
      await client.execute('UPDATE product_variants SET stock_reserved=? WHERE id=?',[Number(variantStock.stock_on_hand)-1,variant5KgId]);
      const cappedUpdate=await httpRequest(baseUrl,'/cart/update',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:cookieHeader,'x-csrf-token':cartCsrf},body:JSON.stringify({key:cartItemKey,qty:5})});
      assert.equal(cappedUpdate.statusCode,200,`availability cap HTTP failed: ${cappedUpdate.body.slice(0,300)}`);
      assert.equal(JSON.parse(cappedUpdate.body).availabilityAdjusted,true,'requested quantity is capped when current stock is lower');
      assert.equal(JSON.parse(cappedUpdate.body).cart[0].qty,1);
      await client.execute('UPDATE product_variants SET stock_reserved=stock_on_hand WHERE id=?',[variant5KgId]);
      const staleUpdate=await httpRequest(baseUrl,'/cart/update',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:cookieHeader,'x-csrf-token':cartCsrf},body:JSON.stringify({key:cartItemKey,qty:5})});
      assert.equal(staleUpdate.statusCode,200,`stale cart update HTTP failed: ${staleUpdate.body.slice(0,300)}`);
      assert.equal(JSON.parse(staleUpdate.body).availabilityAdjusted,true,'zero available variant is identified as stale');
      assert.equal(JSON.parse(staleUpdate.body).cartCount,0,'zero available variant is removed instead of forced to one unit');
      await client.execute('UPDATE product_variants SET stock_reserved=? WHERE id=?',[variantStock.stock_reserved,variant5KgId]);
      const cartReadded=await httpRequest(baseUrl,'/cart/add',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:cookieHeader,'x-csrf-token':cartCsrf},body:JSON.stringify({product_id:inhouseProdId,variant_id:variant5KgId,qty:2})});
      assert.equal(cartReadded.statusCode,200,`cart restoration HTTP failed: ${cartReadded.body.slice(0,300)}`);
      const readdedSetCookie=cartReadded.headers['set-cookie'];
      cookieHeader=(Array.isArray(readdedSetCookie)?readdedSetCookie:[readdedSetCookie]).filter(Boolean).map((c)=>c.split(';')[0]).join('; ')||cookieHeader;
      assert.equal(JSON.parse(cartReadded.body).cartCount,2,'guest can restore the available cart line after stock recovers');

      // Exercise the same stale-stock rules with a logged-in customer whose cart is persisted in MySQL.
      const customerPhone=`018${String(Date.now()).slice(-8)}`;
      const testCustomer=await customerRepo.registerCustomer({name:'Persistent Cart Test',phone:customerPhone,password:'SecureCartPassword!2026'});
      const loginCsrfStart=await httpRequest(baseUrl,'/api/v1/csrf-token');
      let customerCookie=(Array.isArray(loginCsrfStart.headers['set-cookie'])?loginCsrfStart.headers['set-cookie']:[loginCsrfStart.headers['set-cookie']]).filter(Boolean).map((c)=>c.split(';')[0]).join('; ');
      const loginCsrf=JSON.parse(loginCsrfStart.body).data.csrfToken;
      const customerLogin=await httpRequest(baseUrl,'/customer/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:customerCookie,'x-csrf-token':loginCsrf},body:new URLSearchParams({phone:customerPhone,password:'SecureCartPassword!2026'}).toString()});
      assert.equal(customerLogin.statusCode,302,'customer can authenticate to persistent cart');
      customerCookie=(Array.isArray(customerLogin.headers['set-cookie'])?customerLogin.headers['set-cookie']:[customerLogin.headers['set-cookie']]).filter(Boolean).map((c)=>c.split(';')[0]).join('; ');
      const customerCsrfStart=await httpRequest(baseUrl,'/api/v1/csrf-token',{headers:{Cookie:customerCookie}});
      const customerCsrf=JSON.parse(customerCsrfStart.body).data.csrfToken;
      const customerAdd=await httpRequest(baseUrl,'/cart/add',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:customerCookie,'x-csrf-token':customerCsrf},body:JSON.stringify({product_id:inhouseProdId,variant_id:variant5KgId,qty:2})});
      assert.equal(customerAdd.statusCode,200,`authenticated add failed: ${customerAdd.body.slice(0,300)}`);
      assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?',[testCustomer.id,inhouseProdId,variant5KgId])).quantity),2,'authenticated cart addition persists to MySQL');
      const savedCartResponse=await httpRequest(baseUrl,'/cart/json',{headers:{Cookie:customerCookie,Accept:'application/json'}});
      const savedCart=JSON.parse(savedCartResponse.body).cart;
      const persistedItemKey=savedCart[0].key;
      const customerVariant=await client.queryOne('SELECT stock_on_hand,stock_reserved FROM product_variants WHERE id=?',[variant5KgId]);
      await client.execute('UPDATE product_variants SET stock_reserved=stock_on_hand-1 WHERE id=?',[variant5KgId]);
      const customerCapped=await httpRequest(baseUrl,'/cart/update',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:customerCookie,'x-csrf-token':customerCsrf},body:JSON.stringify({key:persistedItemKey,qty:5})});
      assert.equal(customerCapped.statusCode,200);
      assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?',[testCustomer.id,inhouseProdId,variant5KgId])).quantity),1,'authenticated capped cart is persisted');
      await client.execute('UPDATE product_variants SET stock_reserved=stock_on_hand WHERE id=?',[variant5KgId]);
      const customerStale=await httpRequest(baseUrl,'/cart/update',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:customerCookie,'x-csrf-token':customerCsrf},body:JSON.stringify({key:persistedItemKey,qty:5})});
      assert.equal(customerStale.statusCode,200);
      assert.equal(JSON.parse(customerStale.body).availabilityAdjusted,true);
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_cart_items WHERE customer_id=?',[testCustomer.id])).n),0,'unavailable authenticated cart line is removed from persistence');
      await client.execute('UPDATE product_variants SET stock_reserved=? WHERE id=?',[customerVariant.stock_reserved,variant5KgId]);

      const reloadAdd=await httpRequest(baseUrl,'/cart/add',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:customerCookie,'x-csrf-token':customerCsrf},body:JSON.stringify({product_id:inhouseProdId,variant_id:variant5KgId,qty:2})});
      assert.equal(reloadAdd.statusCode,200,'persistent cart can be repopulated before stale-stock reload checks');
      await client.execute('UPDATE product_variants SET stock_on_hand=1,stock_reserved=0 WHERE id=?',[variant5KgId]);
      const cartPageAfterStockDrop=await httpRequest(baseUrl,'/cart',{headers:{Cookie:customerCookie}});
      assert.equal(cartPageAfterStockDrop.statusCode,200);
      assert.match(cartPageAfterStockDrop.body,/availability changed|প্রাপ্যতা পরিবর্তিত/,'cart page discloses that live availability adjusted saved quantities');
      const reloadedCapped=await httpRequest(baseUrl,'/cart/json',{headers:{Cookie:customerCookie,Accept:'application/json'}});
      assert.equal(JSON.parse(reloadedCapped.body).cart[0].qty,1,'loading a saved cart caps its quantity to current variant and parent availability');
      assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?',[testCustomer.id,inhouseProdId,variant5KgId])).quantity),1,'GET cart refresh persists the capped quantity');
      await client.execute('UPDATE product_variants SET stock_reserved=stock_on_hand WHERE id=?',[variant5KgId]);
      const reloadedUnavailable=await httpRequest(baseUrl,'/cart/json',{headers:{Cookie:customerCookie,Accept:'application/json'}});
      assert.equal(reloadedUnavailable.statusCode,200);
      assert.equal(JSON.parse(reloadedUnavailable.body).cartCount,0,'loading a saved cart removes a newly unavailable variant');
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_cart_items WHERE customer_id=?',[testCustomer.id])).n),0,'unavailable saved lines are removed from persistent storage');
      await client.execute('UPDATE product_variants SET stock_on_hand=?,stock_reserved=? WHERE id=?',[customerVariant.stock_on_hand,customerVariant.stock_reserved,variant5KgId]);

      const checkoutPage = await httpRequest(baseUrl, '/customer/checkout?lang=en&utm_source=facebook&utm_medium=paid_social&utm_campaign=p14-ci', { headers: { Cookie: cookieHeader, Accept:'application/json' } });
      assert.equal(checkoutPage.statusCode, 200, `MySQL checkout GET failed: ${checkoutPage.body.slice(0,500)}`);
      assert.doesNotMatch(checkoutPage.body, /name="cart_backup_json"/,'MySQL checkout must not accept a client cart backup');
      assert.match(checkoutPage.body, /Cash on delivery/);
      assert.match(checkoutPage.body, /Optional campaign attribution/);
      const csrf = checkoutPage.body.match(/name="_csrf" value="([^"]+)"/);
      assert.ok(csrf,'checkout form binds a CSRF token');
      const consentCsrfRejected = await httpRequest(baseUrl, '/analytics/consent', { method:'POST', headers:{Cookie:cookieHeader,'Content-Type':'application/x-www-form-urlencoded'}, body:'choice=accept&return_to=%2F' });
      assert.equal(consentCsrfRejected.statusCode,403,'analytics consent cannot be changed without CSRF');
      const unsafeReturn = await httpRequest(baseUrl, '/analytics/consent', { method:'POST', headers:{Cookie:cookieHeader,'Content-Type':'application/x-www-form-urlencoded','x-csrf-token':csrf[1]}, body:new URLSearchParams({choice:'reject',return_to:'//attacker.example'}).toString() });
      assert.equal(unsafeReturn.statusCode,303);
      assert.equal(unsafeReturn.headers.location,'/','consent preference return path cannot become an external redirect');
      const consentGranted = await httpRequest(baseUrl, '/analytics/consent', { method:'POST', headers:{Cookie:cookieHeader,'Content-Type':'application/x-www-form-urlencoded','x-csrf-token':csrf[1]}, body:new URLSearchParams({choice:'accept',return_to:'/customer/checkout?lang=en&utm_source=facebook&utm_medium=paid_social&utm_campaign=p14-ci'}).toString() });
      assert.equal(consentGranted.statusCode,303,'an explicit CSRF-protected opt-in is required');
      const attributedCheckoutPage = await httpRequest(baseUrl, '/customer/checkout?lang=en&utm_source=facebook&utm_medium=paid_social&utm_campaign=p14-ci', { headers:{Cookie:cookieHeader} });
      assert.equal(attributedCheckoutPage.statusCode,200);
      assert.match(attributedCheckoutPage.body,/Campaign attribution is enabled for this session/);
      const requestKey = attributedCheckoutPage.body.match(/name="checkout_request_key" value="([^"]+)"/);
      assert.ok(requestKey,'checkout form binds an idempotency request key after consent');
      assert.equal(Number((await client.queryOne("SELECT COUNT(*) AS n FROM incomplete_orders WHERE phone='01712345678' AND consent_given=1")).n),0,'checkout data is not captured before opt-in');
      const capture = await httpRequest(baseUrl,'/checkout/save-incomplete',{method:'POST',headers:{Cookie:cookieHeader,'Content-Type':'application/json','x-csrf-token':csrf[1]},body:JSON.stringify({name:'Checkout Test',phone:'01712345678',consent:'true',notification_consent:'false'})});
      assert.equal(capture.statusCode,200,`Recovery opt-in HTTP failed: ${capture.body.slice(0,500)}`);const capturePayload=JSON.parse(capture.body);assert.equal(capturePayload.ok,true);
      const unrelatedSessionStart=await httpRequest(baseUrl,'/api/v1/csrf-token');
      const unrelatedSessionCookie=(Array.isArray(unrelatedSessionStart.headers['set-cookie'])?unrelatedSessionStart.headers['set-cookie']:[unrelatedSessionStart.headers['set-cookie']]).filter(Boolean).map(value=>value.split(';')[0]).join('; ');
      const unrelatedSessionCsrf=JSON.parse(unrelatedSessionStart.body).data.csrfToken;
      assert.notEqual(unrelatedSessionCookie,cookieHeader,'withdrawal fixture uses a distinct session');
      const crossSessionWithdrawal=await httpRequest(baseUrl,'/checkout/withdraw-recovery-consent',{method:'POST',headers:{Cookie:unrelatedSessionCookie,'Content-Type':'application/json','x-csrf-token':unrelatedSessionCsrf},body:JSON.stringify({record_id:capturePayload.id})});
      assert.equal(crossSessionWithdrawal.statusCode,404,'a different session cannot withdraw another session’s recovery consent');
      const afterRejectedWithdrawal=await client.queryOne('SELECT status,phone,customer_name,cart_json,consent_withdrawn_at FROM incomplete_orders WHERE id=?',[capturePayload.id]);
      assert.equal(afterRejectedWithdrawal.status,'abandoned');assert.equal(afterRejectedWithdrawal.phone,'01712345678');assert.equal(afterRejectedWithdrawal.customer_name,'Checkout Test');assert.ok(afterRejectedWithdrawal.cart_json);assert.equal(afterRejectedWithdrawal.consent_withdrawn_at,null,'unauthorized withdrawal leaves the owner’s record intact');
      const form = new URLSearchParams({
        _csrf: csrf[1], checkout_request_key: requestKey[1], customer_name: 'Checkout Test', phone: '01712345678',
        address: 'House 1, Test Road, Dhanmondi', delivery_location_id: String(deliveryLocationId), payment_method: 'cod',
        note: 'CI checkout', confirm_order: 'yes', cart_backup_json: JSON.stringify([{ product_id: inhouseProdId, qty: 99, price: 0.01 }]),
      }).toString();
      const csrfRejected = await httpRequest(baseUrl, '/customer/checkout', { method:'POST',headers:{Cookie:cookieHeader,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({checkout_request_key:requestKey[1],confirm_order:'yes'}).toString() });
      assert.equal(csrfRejected.statusCode,403,'checkout rejects a missing CSRF token');
      const submitted = await httpRequest(baseUrl, '/customer/checkout', { method:'POST',headers:{Cookie:cookieHeader,'Content-Type':'application/x-www-form-urlencoded'},body:form });
      assert.equal(submitted.statusCode,302);
      const invoice = decodeURIComponent(submitted.headers.location.split('/').pop());
      const placed = await client.queryOne('SELECT id,subtotal_paisa,shipping_paisa,total_paisa,paid_paisa,cod_due_paisa,payment_status,payment_method,order_status,traffic_source,utm_source,utm_medium,utm_campaign,analytics_consent_at,analytics_consent_version FROM orders WHERE invoice_no=?',[invoice]);
      assert.ok(placed);
      assert.deepEqual([Number(placed.subtotal_paisa),Number(placed.shipping_paisa),Number(placed.total_paisa),Number(placed.paid_paisa),Number(placed.cod_due_paisa)],[176000,5500,181500,0,181500]);
      assert.equal(placed.payment_status,'unpaid'); assert.equal(placed.payment_method,'cod'); assert.equal(placed.order_status,'pending');
      assert.deepEqual([placed.traffic_source,placed.utm_source,placed.utm_medium,placed.utm_campaign,placed.analytics_consent_version],['Meta','facebook','paid_social','p14-ci','p14-v1']);
      assert.ok(placed.analytics_consent_at,'the successful order records the explicit first-party attribution consent');
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM order_payments WHERE order_id=?',[placed.id])).n),0,'unverified payment is never recorded as paid');
      assert.equal(Number((await client.queryOne('SELECT stock_reserved FROM products WHERE id=?',[inhouseProdId])).stock_reserved),7);
      assert.equal(Number((await client.queryOne('SELECT stock_reserved FROM product_variants WHERE id=?',[variant5KgId])).stock_reserved),5);
      const replayResponses = await Promise.all([1,2].map(()=>httpRequest(baseUrl, '/customer/checkout', { method:'POST',headers:{Cookie:cookieHeader,'Content-Type':'application/x-www-form-urlencoded'},body:form })));
      assert.ok(replayResponses.every((replay)=>replay.statusCode===302));
      assert.ok(replayResponses.every((replay)=>replay.headers.location===submitted.headers.location),'concurrent same-payload retries resolve to one invoice');
      const mismatchForm = new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(form)), phone:'01812345678' }).toString();
      const mismatch = await httpRequest(baseUrl, '/customer/checkout', { method:'POST',headers:{Cookie:cookieHeader,'Content-Type':'application/x-www-form-urlencoded'},body:mismatchForm });
      assert.equal(mismatch.statusCode,409,'reusing an idempotency key with changed data is rejected');
      const durableKey=`incomplete:${capturePayload.id}`;
      const orderCount = await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?',[durableKey]);
      assert.equal(Number(orderCount.n),1,`recovery order idempotency key was not persisted (found ${orderCount.n})`);
      const recoveryState=await client.queryOne('SELECT status,recovered_order_id,notification_allowed FROM incomplete_orders WHERE id=?',[capturePayload.id]);
      assert.equal(recoveryState.status,'recovered');assert.equal(Number(recoveryState.recovered_order_id),Number(placed.id),`recovery link ${recoveryState.recovered_order_id} does not match order ${placed.id}`);assert.equal(Number(recoveryState.notification_allowed),0);
      const successPage = await httpRequest(baseUrl, submitted.headers.location, { headers: { Cookie: cookieHeader } });
      assert.equal(successPage.statusCode,200); assert.match(successPage.body,/No online payment has been recorded/);
      assert.doesNotMatch(successPage.body,/01712345678|House 1, Test Road/,'public success page does not expose customer contact or address');

      const concurrentKeys=[`p08-checkout-stock-a-${Date.now()}`,`p08-checkout-stock-b-${Date.now()}`];
      const concurrentOrders=await Promise.allSettled(concurrentKeys.map((requestKey)=>checkoutRepo.createOrder({customer_name:'Concurrent Checkout',phone:'01912345678',address:'House 2, Concurrent Road',delivery_location_id:deliveryLocationId,payment_method:'cod'}, {locale:'en',requestKey,cart:[{product_id:inhouseProdId,variant_id:variant5KgId,qty:3}]})));
      assert.equal(concurrentOrders.filter(x=>x.status==='fulfilled').length,1,`row locks should allow one checkout; outcomes=${concurrentOrders.map(x=>x.status==='fulfilled'?'fulfilled':x.reason?.message).join('; ')}`);
      assert.equal(concurrentOrders.filter(x=>x.status==='rejected'&&x.reason.code==='CONFLICT').length,1,`exactly one checkout should be rejected for stock; outcomes=${concurrentOrders.map(x=>x.status==='fulfilled'?'fulfilled':`${x.reason?.code}:${x.reason?.message}`).join('; ')}`);
      const noConsentOrder=await client.queryOne('SELECT traffic_source,utm_source,utm_medium,utm_campaign,analytics_consent_at,analytics_consent_version FROM orders WHERE id=?',[concurrentOrders.find(x=>x.status==='fulfilled').value.id]);
      assert.deepEqual([noConsentOrder.traffic_source,noConsentOrder.utm_source,noConsentOrder.utm_medium,noConsentOrder.utm_campaign,noConsentOrder.analytics_consent_at,noConsentOrder.analytics_consent_version],['Direct','','','',null,null],'without explicit consent, no attribution is persisted');
      assert.equal(Number((await client.queryOne('SELECT stock_reserved FROM product_variants WHERE id=?',[variant5KgId])).stock_reserved),8);
      await client.execute("INSERT INTO settings (setting_key,setting_value) VALUES ('otp_mode','on') ON DUPLICATE KEY UPDATE setting_value='on'");
      await assert.rejects(()=>checkoutRepo.createOrder({customer_name:'OTP blocked',phone:'01912345678',address:'House 3, Policy Road',delivery_location_id:deliveryLocationId,payment_method:'cod'},{locale:'en',requestKey:`p08-checkout-otp-${Date.now()}`,cart:[{product_id:inhouseProdId,qty:1}]}),(err)=>err.code==='CONFLICT');
      await client.execute("UPDATE settings SET setting_value='off' WHERE setting_key='otp_mode'");
      await client.execute("INSERT INTO settings (setting_key,setting_value) VALUES ('advance_payment_mode','fixed'),('advance_payment_value','100') ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)");
      await assert.rejects(()=>checkoutRepo.createOrder({customer_name:'Advance blocked',phone:'01912345678',address:'House 3, Policy Road',delivery_location_id:deliveryLocationId,payment_method:'cod'},{locale:'en',requestKey:`p08-checkout-advance-${Date.now()}`,cart:[{product_id:inhouseProdId,qty:1}]}),(err)=>err.code==='CONFLICT');
      await client.execute("UPDATE settings SET setting_value='off' WHERE setting_key='advance_payment_mode'");
    }
  );

  test('4. Phase 07 authenticated cart ownership and login guest-cart merge', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const suffix = String(Date.now()).slice(-7);
    const customerA = await customerRepo.registerCustomer({ name: 'Cart owner A', phone: `017${suffix}1`, password: 'SecureCartPassword!2026' });
    const customerB = await customerRepo.registerCustomer({ name: 'Cart owner B', phone: `017${suffix}2`, password: 'SecureCartPassword!2026' });
    await client.execute('UPDATE products SET stock_on_hand=100,stock_reserved=0 WHERE id=?', [inhouseProdId]);
    await client.execute('UPDATE product_variants SET stock_on_hand=100,stock_reserved=0 WHERE id=?', [variant5KgId]);
    const login = async (phone, guestAdd = false) => {
      const initial = await httpRequest(baseUrl, '/api/v1/csrf-token');
      let cookie = (Array.isArray(initial.headers['set-cookie']) ? initial.headers['set-cookie'] : [initial.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
      const csrf = JSON.parse(initial.body).data.csrfToken;
      if (guestAdd) {
        const added = await httpRequest(baseUrl, '/cart/add', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ product_id: inhouseProdId, variant_id: variant5KgId, qty: 1 }) });
        assert.equal(added.statusCode, 200, `guest cart add failed: ${added.body.slice(0, 300)}`);
        cookie = (Array.isArray(added.headers['set-cookie']) ? added.headers['set-cookie'] : [added.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ') || cookie;
      }
      const guestCookie = cookie;
      const authenticated = await httpRequest(baseUrl, '/customer/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf }, body: new URLSearchParams({ phone, password: 'SecureCartPassword!2026' }).toString() });
      assert.equal(authenticated.statusCode, 302, `login failed: ${authenticated.body.slice(0, 300)}`);
      cookie = (Array.isArray(authenticated.headers['set-cookie']) ? authenticated.headers['set-cookie'] : [authenticated.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ') || cookie;
      assert.notEqual(cookie, guestCookie, 'login regenerates the session identifier after authentication');
      const tokenResponse = await httpRequest(baseUrl, '/api/v1/csrf-token', { headers: { Cookie: cookie } });
      return { cookie, csrf: JSON.parse(tokenResponse.body).data.csrfToken };
    };

    await client.execute('INSERT INTO customer_cart_items (customer_id,product_id,variant_id,quantity) VALUES (?,?,?,?)', [customerA.id, inhouseProdId, variant5KgId, 1]);
    await client.execute('INSERT INTO customer_cart_items (customer_id,product_id,variant_id,quantity) VALUES (?,?,?,?)', [customerB.id, inhouseProdId, variant5KgId, 4]);
    const sessionA = await login(customerA.phone);
    const sessionB = await login(customerB.phone);
    const cartA = await httpRequest(baseUrl, '/cart/json', { headers: { Cookie: sessionA.cookie, Accept: 'application/json' } });
    assert.equal(JSON.parse(cartA.body).cart[0].qty, 1, 'customer A reads only A-owned persistent quantity');
    const clearA = await httpRequest(baseUrl, '/cart/clear', { method: 'POST', headers: { Cookie: sessionA.cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': sessionA.csrf }, body: '{}' });
    assert.equal(clearA.statusCode, 200);
    assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?', [customerB.id, inhouseProdId, variant5KgId])).quantity), 4, 'customer A clear cannot mutate customer B data');
    const cartBAfter = await httpRequest(baseUrl, '/cart/json', { headers: { Cookie: sessionB.cookie, Accept: 'application/json' } });
    assert.equal(JSON.parse(cartBAfter.body).cart[0].qty, 4, 'customer B still reads its own cart');

    await client.execute('DELETE FROM customer_cart_items WHERE customer_id=?', [customerA.id]);
    const guestSession = await login(customerA.phone, true);
    const merged = await httpRequest(baseUrl, '/cart/json', { headers: { Cookie: guestSession.cookie, Accept: 'application/json' } });
    assert.equal(JSON.parse(merged.body).cartCount, 1, 'login preserves and merges the guest cart into the authenticated persistent cart');
    assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?', [customerA.id, inhouseProdId, variant5KgId])).quantity), 1);

    const registrationStart = await httpRequest(baseUrl, '/api/v1/csrf-token');
    let registrationCookie = (Array.isArray(registrationStart.headers['set-cookie']) ? registrationStart.headers['set-cookie'] : [registrationStart.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    const registrationCsrf = JSON.parse(registrationStart.body).data.csrfToken;
    const registrationAdd = await httpRequest(baseUrl, '/cart/add', { method: 'POST', headers: { Cookie: registrationCookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': registrationCsrf }, body: JSON.stringify({ product_id: inhouseProdId, variant_id: variant5KgId, qty: 1 }) });
    assert.equal(registrationAdd.statusCode, 200);
    registrationCookie = (Array.isArray(registrationAdd.headers['set-cookie']) ? registrationAdd.headers['set-cookie'] : [registrationAdd.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ') || registrationCookie;
    const registrationPhone = `018${String(Date.now()).slice(-8)}`;
    const registration = await httpRequest(baseUrl, '/customer/register', { method: 'POST', headers: { Cookie: registrationCookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': registrationCsrf }, body: new URLSearchParams({ name: 'Guest cart registration', phone: registrationPhone, password: 'SecureCartPassword!2026', privacy_notice_acknowledged: 'yes', privacy_policy_version: '1.0' }).toString() });
    assert.equal(registration.statusCode, 302, `registration with guest cart failed (HTTP ${registration.statusCode}): ${registration.body.slice(0, 1200)}`);
    const registeredCookie = (Array.isArray(registration.headers['set-cookie']) ? registration.headers['set-cookie'] : [registration.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    assert.ok(registeredCookie && registeredCookie !== registrationCookie, 'registration regenerates the session identifier after account creation');
    const registeredCustomer = await client.queryOne('SELECT id FROM customers WHERE phone=?', [registrationPhone]);
    assert.ok(registeredCustomer);
    assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?', [registeredCustomer.id, inhouseProdId, variant5KgId])).quantity), 1, 'registration preserves and merges the guest cart');

    const logout = await httpRequest(baseUrl, '/customer/logout', { method: 'POST', headers: { Cookie: guestSession.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': guestSession.csrf }, body: '' });
    assert.equal(logout.statusCode, 302, 'logout is a CSRF-protected POST');
    const afterLogout = await httpRequest(baseUrl, '/customer/account', { headers: { Cookie: guestSession.cookie } });
    assert.equal(afterLogout.statusCode, 302, 'destroyed customer session cannot reopen the account page');
    assert.match(afterLogout.headers.location, /^\/customer\/login/);
  });

  test('5. Phase 07 checkout uses only active owner-configured COD and delivery rows', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const product = await client.queryOne('SELECT id FROM products WHERE slug=?', ['artisan-date-gift-box']);
    const input = { customer_name: 'Configured Checkout', phone: '01912345678', address: 'House 5, Config Road', delivery_location_id: deliveryLocationId, payment_method: 'cod' };
    const makeOptions = (requestKey) => ({ locale: 'en', requestKey, cart: [{ product_id: product.id, qty: 1 }] });

    await client.execute("UPDATE payment_gateways SET status=0 WHERE code='cod'");
    try {
      await assert.rejects(() => checkoutRepo.createOrder(input, makeOptions(`p07-no-cod-${Date.now()}`)), (err) => err.code === 'CONFLICT');
    } finally {
      await client.execute("UPDATE payment_gateways SET status=1 WHERE code='cod'");
    }

    await client.execute('UPDATE delivery_locations SET status=0 WHERE id=?', [deliveryLocationId]);
    try {
      await assert.rejects(() => checkoutRepo.createOrder(input, makeOptions(`p07-inactive-zone-${Date.now()}`)), (err) => err.code === 'VALIDATION_ERROR');
    } finally {
      await client.execute('UPDATE delivery_locations SET status=1 WHERE id=?', [deliveryLocationId]);
    }
  });

  test('5b. Phase 07 MySQL checkout enforces active customer phone/IP block records', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const product=await client.queryOne('SELECT id FROM products WHERE slug=?',['artisan-date-gift-box']);
    const phone=`017${String(Date.now()).slice(-8)}`;const requestKey=`p07-checkout-block-${Date.now()}`;
    await client.execute('INSERT INTO ip_blocks(target_type,ip_or_phone,reason,status) VALUES(?,?,?,1)',['phone',phone,'P07 blocklist regression']);
    try {
      await assert.rejects(()=>checkoutRepo.createOrder({customer_name:'Blocked checkout',phone,address:'House 6, Block Road',delivery_location_id:deliveryLocationId,payment_method:'cod'},{locale:'en',requestKey,cart:[{product_id:product.id,qty:1}]}),(err)=>err.code==='CONFLICT'&&/blocked from placing orders/.test(err.message));
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?',[requestKey])).n),0,'blocked checkout does not persist an order');
    } finally {
      await client.execute('DELETE FROM ip_blocks WHERE target_type=? AND ip_or_phone=?',['phone',phone]);
    }
  });

  test('5c. Phase 07 coupon eligibility, paisa discounts, usage limits, concurrency and checkout rollback', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const cart=[{product_id:inhouseProdId,variant_id:variant5KgId,qty:1}];
    const prefix=`P05-COUPON-${Date.now()}`;
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'percent',15,0,NULL,10,0,UTC_TIMESTAMP()+INTERVAL 2 DAY,1)",[`${prefix}-PERCENT`]);
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'fixed',500,0,NULL,NULL,0,UTC_TIMESTAMP()+INTERVAL 2 DAY,1)",[`${prefix}-FIXED`]);
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'percent',10,0,NULL,NULL,0,UTC_TIMESTAMP()-INTERVAL 1 DAY,1)",[`${prefix}-EXPIRED`]);
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'percent',10,999999999,NULL,NULL,0,UTC_TIMESTAMP()+INTERVAL 2 DAY,1)",[`${prefix}-MINIMUM`]);
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'percent',10,0,NULL,1,1,UTC_TIMESTAMP()+INTERVAL 2 DAY,1)",[`${prefix}-EXHAUSTED`]);
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'percent',10,0,NULL,NULL,0,NULL,0)",[`${prefix}-DISABLED`]);
    const quote=await checkoutRepo.quoteCart(cart,{locale:'en'});
    const percent=await checkoutRepo.validateCoupon(`${prefix}-percent`,cart,{locale:'en'});
    assert.equal(percent.amount,Number((BigInt(quote.subtotalPaisa)*15n)/100n),'percentage discounts retain canonical whole-paisa truncation');
    assert.equal(percent.subtotalPaisa,quote.subtotalPaisa);
    assert.equal((await checkoutRepo.validateCoupon(`${prefix}-fixed`,cart,{locale:'en'})).amount,Math.min(quote.subtotalPaisa,500),'flat legacy BDT amount maps to fixed paisa');
    for(const code of [`${prefix}-expired`,`${prefix}-minimum`,`${prefix}-exhausted`,`${prefix}-disabled`]){
      await assert.rejects(()=>checkoutRepo.validateCoupon(code,cart,{locale:'en'}),(err)=>err.code==='VALIDATION_ERROR',`${code} must not qualify`);
    }

    const concurrentCode=`${prefix}-ONCE`;
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'percent',10,0,1,0,UTC_TIMESTAMP()+INTERVAL 2 DAY,1)",[concurrentCode]);
    const orderInput={customer_name:'Coupon concurrency',phone:'01812345678',address:'House 8, Coupon concurrency road',delivery_location_id:deliveryLocationId,payment_method:'cod',coupon_code:concurrentCode};
    const keys=[`${prefix}-ORDER-A`,`${prefix}-ORDER-B`];
    const results=await Promise.allSettled(keys.map(requestKey=>checkoutRepo.createOrder(orderInput,{locale:'en',requestKey,cart})));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1,'only one concurrent checkout consumes the single-use coupon');
    assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='VALIDATION_ERROR').length,1,'the second concurrent checkout sees the exhausted usage limit');
    assert.equal(Number((await client.queryOne('SELECT used_count FROM coupons WHERE code=?',[concurrentCode])).used_count),1);
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key IN (?,?)',keys)).n),1);

    const rollbackCode=`${prefix}-ROLLBACK`;
    await client.execute("INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,usage_limit,used_count,expires_at,status) VALUES(?,'percent',10,0,5,0,UTC_TIMESTAMP()+INTERVAL 2 DAY,1)",[rollbackCode]);
    const rollbackKey=`${prefix}-ROLLBACK-ORDER`;
    const stockBefore=await client.queryOne('SELECT stock_on_hand,stock_reserved FROM products WHERE id=?',[inhouseProdId]);
    const usageTrigger=`p05_coupon_fail_${process.pid}`;
    await client.execute(`CREATE TRIGGER ${usageTrigger} BEFORE UPDATE ON coupons FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture coupon usage failure'`);
    try{
      await assert.rejects(()=>checkoutRepo.createOrder({...orderInput,coupon_code:rollbackCode},{locale:'en',requestKey:rollbackKey,cart}));
    }finally{await client.execute(`DROP TRIGGER IF EXISTS ${usageTrigger}`);}
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?',[rollbackKey])).n),0,'failed usage update rolls back the order');
    assert.equal(Number((await client.queryOne('SELECT used_count FROM coupons WHERE code=?',[rollbackCode])).used_count),0,'failed checkout does not consume coupon usage');
    const stockAfter=await client.queryOne('SELECT stock_on_hand,stock_reserved FROM products WHERE id=?',[inhouseProdId]);
    assert.deepEqual([Number(stockAfter.stock_on_hand),Number(stockAfter.stock_reserved)],[Number(stockBefore.stock_on_hand),Number(stockBefore.stock_reserved)],'failed checkout preserves warehouse stock and reservations');
  });

  test('6. Phase 07 checkout order, lines, reservation and audit roll back together on injected audit failure', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const product = await client.queryOne('SELECT id,vendor_stock_reserved FROM products WHERE slug=?', ['artisan-date-gift-box']);
    const requestKey = `p07-checkout-rollback-${Date.now()}`;
    const reservedBefore = Number(product.vendor_stock_reserved);
    const triggerName = `p07_fail_checkout_audit_${process.pid}`;
    await client.execute(`CREATE TRIGGER \`${triggerName}\` BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional checkout audit failure'`);
    try {
      await assert.rejects(() => checkoutRepo.createOrder({ customer_name: 'Rollback Checkout', phone: '01912345678', address: 'House 6, Rollback Road', delivery_location_id: deliveryLocationId, payment_method: 'cod' }, { locale: 'en', requestKey, cart: [{ product_id: product.id, qty: 1 }] }));
    } finally {
      await client.execute(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
    }
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?', [requestKey])).n), 0, 'failed checkout leaves no order');
    assert.equal(Number((await client.queryOne('SELECT vendor_stock_reserved FROM products WHERE id=?', [product.id])).vendor_stock_reserved), reservedBefore, 'failed checkout leaves inventory unreserved');
    assert.equal(Number((await client.queryOne("SELECT COUNT(*) AS n FROM stock_reservations WHERE reservation_key LIKE 'order:%' AND product_id=? AND status='active'", [product.id])).n), 0, 'failed checkout leaves no active reservation');
  });

  test('7. Phase 07 authenticated checkout clears the saved cart once; duplicate replay preserves later cart edits', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const phone = `013${String(Date.now()).slice(-8)}`;
    const customer = await customerRepo.registerCustomer({ name: 'Checkout cart lifecycle', phone, password: 'SecureCartPassword!2026' });
    const start = await httpRequest(baseUrl, '/api/v1/csrf-token');
    let cookie = (Array.isArray(start.headers['set-cookie']) ? start.headers['set-cookie'] : [start.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    const loginCsrf = JSON.parse(start.body).data.csrfToken;
    const login = await httpRequest(baseUrl, '/customer/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': loginCsrf }, body: new URLSearchParams({ phone, password: 'SecureCartPassword!2026' }).toString() });
    assert.equal(login.statusCode, 302);
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    const product = await client.queryOne('SELECT id FROM products WHERE slug=?', ['artisan-date-gift-box']);
    const csrfResponse = await httpRequest(baseUrl, '/api/v1/csrf-token', { headers: { Cookie: cookie } });
    const cartCsrf = JSON.parse(csrfResponse.body).data.csrfToken;
    const added = await httpRequest(baseUrl, '/cart/add', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': cartCsrf }, body: JSON.stringify({ product_id: product.id, qty: 1 }) });
    assert.equal(added.statusCode, 200, `authenticated cart add failed: ${added.body.slice(0, 300)}`);
    const checkoutPage = await httpRequest(baseUrl, '/customer/checkout?lang=en', { headers: { Cookie: cookie } });
    assert.equal(checkoutPage.statusCode, 200);
    const csrf = checkoutPage.body.match(/name="_csrf" value="([^"]+)"/);
    const requestKey = checkoutPage.body.match(/name="checkout_request_key" value="([^"]+)"/);
    assert.ok(csrf && requestKey, 'checkout form contains CSRF and stable request keys');
    const form = new URLSearchParams({
      _csrf: csrf[1], checkout_request_key: requestKey[1], customer_name: customer.name, phone,
      address: 'House 9, Cart Lifecycle Road', delivery_location_id: String(deliveryLocationId),
      payment_method: 'cod', coupon_code: '', confirm_order: 'yes',
    }).toString();
    const submitted = await httpRequest(baseUrl, '/customer/checkout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    assert.equal(submitted.statusCode, 302, `authenticated checkout failed: ${submitted.body.slice(0, 300)}`);
    const invoice = decodeURIComponent(submitted.headers.location.split('/').pop());
    const order = await client.queryOne('SELECT id,customer_id,idempotency_key FROM orders WHERE invoice_no=?', [invoice]);
    assert.equal(Number(order.customer_id), Number(customer.id));
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_cart_items WHERE customer_id=?', [customer.id])).n), 0, 'successful order clears persistent authenticated cart');
    const emptyCart = await httpRequest(baseUrl, '/cart/json', { headers: { Cookie: cookie, Accept: 'application/json' } });
    assert.equal(Number(JSON.parse(emptyCart.body).cartCount), 0, 'session cart is empty after checkout');

    const laterAdd = await httpRequest(baseUrl, '/cart/add', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf[1] }, body: JSON.stringify({ product_id: product.id, qty: 1 }) });
    assert.equal(laterAdd.statusCode, 200, 'customer can add an item after completing an order');
    const replay = await httpRequest(baseUrl, '/customer/checkout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    assert.equal(replay.statusCode, 302);
    assert.equal(replay.headers.location, submitted.headers.location, 'retry resolves to the original invoice');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?', [order.idempotency_key])).n), 1, 'retry does not create another order');
    assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id IS NULL', [customer.id, product.id])).quantity), 1, 'replay does not clear cart changes made after the original order');
  });

  test('7b. Phase 07 checkout keeps order, inventory reservation, and saved-cart clearing atomic on clear failure', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const phone = `018${String(Date.now()).slice(-8)}`;
    const customer = await customerRepo.registerCustomer({ name: 'Checkout atomic cart', phone, password: 'SecureCartPassword!2026' });
    const initial = await httpRequest(baseUrl, '/api/v1/csrf-token');
    let cookie = (Array.isArray(initial.headers['set-cookie']) ? initial.headers['set-cookie'] : [initial.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    const login = await httpRequest(baseUrl, '/customer/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': JSON.parse(initial.body).data.csrfToken }, body: new URLSearchParams({ phone, password: 'SecureCartPassword!2026' }).toString() });
    assert.equal(login.statusCode, 302);
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    const token = await httpRequest(baseUrl, '/api/v1/csrf-token', { headers: { Cookie: cookie } });
    const csrf = JSON.parse(token.body).data.csrfToken;
    const reservationBefore = await client.queryOne('SELECT stock_on_hand,stock_reserved FROM product_variants WHERE id=?', [variant5KgId]);
    const add = await httpRequest(baseUrl, '/cart/add', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ product_id: inhouseProdId, variant_id: variant5KgId, qty: 1 }) });
    assert.equal(add.statusCode, 200);
    const checkout = await httpRequest(baseUrl, '/customer/checkout?lang=en', { headers: { Cookie: cookie } });
    const checkoutCsrf = checkout.body.match(/name="_csrf" value="([^"]+)"/);
    const requestKey = checkout.body.match(/name="checkout_request_key" value="([^"]+)"/);
    assert.ok(checkoutCsrf && requestKey);
    const form = new URLSearchParams({ _csrf: checkoutCsrf[1], checkout_request_key: requestKey[1], customer_name: customer.name, phone, address: 'House 10, Atomic Cart Road', delivery_location_id: String(deliveryLocationId), payment_method: 'cod', coupon_code: '', confirm_order: 'yes' }).toString();
    const trigger = `phase07_fail_cart_delete_${String(customer.id)}`;
    await client.execute(`CREATE TRIGGER ${trigger} BEFORE DELETE ON customer_cart_items FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional checkout cart-clear failure'`);
    try {
      const failed = await httpRequest(baseUrl, '/customer/checkout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      assert.equal(failed.statusCode, 500, 'injected transactional cart-clear failure is surfaced');
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?', [requestKey[1]])).n), 0, 'failed transaction must not leave a durable order');
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_cart_items WHERE customer_id=?', [customer.id])).n), 1, 'failed transaction retains the saved cart line');
      const reservationAfterFailure = await client.queryOne('SELECT stock_on_hand,stock_reserved FROM product_variants WHERE id=?', [variant5KgId]);
      assert.equal(Number(reservationAfterFailure.stock_on_hand), Number(reservationBefore.stock_on_hand), 'failed checkout does not decrement variant stock');
      assert.equal(Number(reservationAfterFailure.stock_reserved), Number(reservationBefore.stock_reserved), 'failed checkout does not leave a partial inventory reservation');
      await client.execute(`DROP TRIGGER ${trigger}`);
      const retried = await httpRequest(baseUrl, '/customer/checkout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      assert.equal(retried.statusCode, 302, `same-key retry succeeds: ${retried.body.slice(0, 300)}`);
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?', [requestKey[1]])).n), 1, 'retry creates exactly one order');
      assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_cart_items WHERE customer_id=?', [customer.id])).n), 0, 'successful retry commits persistent-cart clearing with the order');
    } finally {
      await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });

  test('7c. Phase 07 address routes are customer-scoped and checkout cannot consume a foreign saved-address ID', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const suffix = String(Date.now()).slice(-8);
    const firstPhone = `015${suffix}`;
    const secondPhone = `017${suffix}`;
    const password = 'SecureAddressPassword!2026';
    const first = await customerRepo.registerCustomer({ name: 'Address owner one', phone: firstPhone, password });
    const second = await customerRepo.registerCustomer({ name: 'Address owner two', phone: secondPhone, password });
    const firstAddress = await client.execute('INSERT INTO customer_addresses (customer_id,label,recipient_name,recipient_phone,division,district,upazila,street_address) VALUES (?,?,?,?,?,?,?,?)', [first.id, 'Home', 'Owner One', firstPhone, 'Dhaka', 'Dhaka', 'Dhanmondi', 'House 11, Owner One Road']);
    const secondAddress = await client.execute('INSERT INTO customer_addresses (customer_id,label,recipient_name,recipient_phone,division,district,upazila,street_address) VALUES (?,?,?,?,?,?,?,?)', [second.id, 'Home', 'Owner Two', secondPhone, 'Dhaka', 'Dhaka', 'Gulshan', 'House 22, Owner Two Road']);
    const loginCustomer = async (phone) => {
      const initial = await httpRequest(baseUrl, '/api/v1/csrf-token');
      let cookie = (Array.isArray(initial.headers['set-cookie']) ? initial.headers['set-cookie'] : [initial.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
      const login = await httpRequest(baseUrl, '/customer/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': JSON.parse(initial.body).data.csrfToken }, body: new URLSearchParams({ phone, password }).toString() });
      assert.equal(login.statusCode, 302);
      cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
      const token = await httpRequest(baseUrl, '/api/v1/csrf-token', { headers: { Cookie: cookie } });
      return { cookie, csrf: JSON.parse(token.body).data.csrfToken };
    };
    const one = await loginCustomer(firstPhone);
    const createOwn = await httpRequest(baseUrl, '/customer/account/addresses', { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': one.csrf }, body: new URLSearchParams({ _csrf: one.csrf, label: 'Work', recipient_name: 'Owner One Work', recipient_phone: firstPhone, division: 'Dhaka', district: 'Dhaka', upazila: 'Dhanmondi', street_address: 'House 12, Owner One Work Road' }).toString() });
    assert.equal(createOwn.statusCode, 302, 'authenticated owner can create a valid saved address');
    const createdAddress = await client.queryOne('SELECT id,customer_id FROM customer_addresses WHERE customer_id=? AND recipient_name=?', [first.id, 'Owner One Work']);
    assert.ok(createdAddress, 'valid address persists for its authenticated owner');
    const account = await httpRequest(baseUrl, '/customer/account', { headers: { Cookie: one.cookie } });
    assert.equal(account.statusCode, 200);
    assert.match(account.body, /House 11, Owner One Road/);
    assert.match(account.body, /House 12, Owner One Work Road/);
    assert.doesNotMatch(account.body, /House 22, Owner Two Road/, 'account read is scoped to the authenticated customer');
    const foreignDelete = await httpRequest(baseUrl, `/customer/account/addresses/${secondAddress.insertId}/delete`, { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': one.csrf }, body: '_csrf=' + encodeURIComponent(one.csrf) });
    assert.equal(foreignDelete.statusCode, 404, 'cross-customer delete is indistinguishable from a missing address');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_addresses WHERE id=? AND customer_id=?', [secondAddress.insertId, second.id])).n), 1, 'foreign address remains unchanged');
    for (const id of ['not-an-id', '9007199254740992']) {
      const invalid = await httpRequest(baseUrl, `/customer/account/addresses/${id}/delete`, { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': one.csrf }, body: '_csrf=' + encodeURIComponent(one.csrf) });
      assert.equal(invalid.statusCode, 404, `invalid address ID ${id} is rejected`);
    }
    const missing = await httpRequest(baseUrl, '/customer/account/addresses/999999999/delete', { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': one.csrf }, body: '_csrf=' + encodeURIComponent(one.csrf) });
    assert.equal(missing.statusCode, 404, 'well-formed but missing address ID is rejected');
    const malformed = await httpRequest(baseUrl, '/customer/account/addresses', { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/json', 'x-csrf-token': one.csrf }, body: 'null' });
    assert.equal(malformed.statusCode, 400, 'malformed address body is a client validation error');
    const addressCountBeforeMalformedField = Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id=?', [first.id])).n);
    const malformedField = await httpRequest(baseUrl, '/customer/account/addresses', { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/json', 'x-csrf-token': one.csrf }, body: JSON.stringify({ label: 'Home', recipient_name: 'Owner One', recipient_phone: firstPhone, division: 'Dhaka', district: 'Dhaka', upazila: 'Dhanmondi', street_address: { hidden: 'structured value' } }) });
    assert.equal(malformedField.statusCode, 400, 'structured text fields are rejected');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id=?', [first.id])).n), addressCountBeforeMalformedField, 'malformed field does not persist an address');
    const unsupportedUpdate = await httpRequest(baseUrl, `/customer/account/addresses/${firstAddress.insertId}`, { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': one.csrf }, body: new URLSearchParams({ _csrf: one.csrf, recipient_name: 'Changed' }).toString() });
    assert.equal(unsupportedUpdate.statusCode, 404, 'no address-update route exists, so an ID cannot be used to update another owner address');
    const ownerDelete = await httpRequest(baseUrl, `/customer/account/addresses/${createdAddress.id}/delete`, { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': one.csrf }, body: '_csrf=' + encodeURIComponent(one.csrf) });
    assert.equal(ownerDelete.statusCode, 302, 'authenticated owner can delete their own saved address');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM customer_addresses WHERE id=? AND customer_id=?', [createdAddress.id, first.id])).n), 0, 'owner deletion persists');

    const product = await client.queryOne('SELECT id FROM products WHERE slug=?', ['artisan-date-gift-box']);
    const cartAdd = await httpRequest(baseUrl, '/cart/add', { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': one.csrf }, body: JSON.stringify({ product_id: product.id, qty: 1 }) });
    assert.equal(cartAdd.statusCode, 200);
    const checkout = await httpRequest(baseUrl, '/customer/checkout?lang=en', { headers: { Cookie: one.cookie } });
    const checkoutCsrf = checkout.body.match(/name="_csrf" value="([^"]+)"/);
    const requestKey = checkout.body.match(/name="checkout_request_key" value="([^"]+)"/);
    assert.ok(checkoutCsrf && requestKey);
    const foreignUse = await httpRequest(baseUrl, '/customer/checkout', { method: 'POST', headers: { Cookie: one.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: checkoutCsrf[1], checkout_request_key: requestKey[1], customer_name: first.name, phone: firstPhone, address_id: String(secondAddress.insertId), delivery_location_id: String(deliveryLocationId), payment_method: 'cod', confirm_order: 'yes' }).toString() });
    assert.equal(foreignUse.statusCode, 400, 'a saved-address ID alone cannot supply another customer\'s shipping address');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE customer_id=?', [first.id])).n), 0, 'foreign ID did not create an order');
  });

  test('8. Phase 07 deterministic concurrent persistent-cart adds do not lose quantity updates', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const phone = `016${String(Date.now()).slice(-8)}`;
    const customer = await customerRepo.registerCustomer({ name: 'Concurrent cart owner', phone, password: 'SecureCartPassword!2026' });
    const originalProduct = await client.queryOne('SELECT stock_on_hand,stock_reserved FROM products WHERE id=?', [inhouseProdId]);
    const originalVariant = await client.queryOne('SELECT stock_on_hand,stock_reserved FROM product_variants WHERE id=?', [variant5KgId]);
    await client.execute('UPDATE products SET stock_on_hand=100,stock_reserved=0 WHERE id=?', [inhouseProdId]);
    await client.execute('UPDATE product_variants SET stock_on_hand=100,stock_reserved=0 WHERE id=?', [variant5KgId]);
    try {
      await client.execute('INSERT INTO customer_cart_items (customer_id,product_id,variant_id,quantity) VALUES (?,?,?,1)', [customer.id, inhouseProdId, variant5KgId]);
      const makeSession = async () => {
        const initial = await httpRequest(baseUrl, '/api/v1/csrf-token');
        let cookie = (Array.isArray(initial.headers['set-cookie']) ? initial.headers['set-cookie'] : [initial.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
        const csrf = JSON.parse(initial.body).data.csrfToken;
        const auth = await httpRequest(baseUrl, '/customer/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf }, body: new URLSearchParams({ phone, password: 'SecureCartPassword!2026' }).toString() });
        assert.equal(auth.statusCode, 302);
        cookie = (Array.isArray(auth.headers['set-cookie']) ? auth.headers['set-cookie'] : [auth.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ') || cookie;
        const token = await httpRequest(baseUrl, '/api/v1/csrf-token', { headers: { Cookie: cookie } });
        return { cookie, csrf: JSON.parse(token.body).data.csrfToken };
      };
      const [first, second] = await Promise.all([makeSession(), makeSession()]);
      const originalAddCartLine = customerRepo.addCartLine;
      let arrivals = 0;
      let openGate;
      const gate = new Promise((resolve) => { openGate = resolve; });
      customerRepo.addCartLine = async (...args) => {
        arrivals += 1;
        if (arrivals === 2) openGate();
        await gate;
        return originalAddCartLine(...args);
      };
      let responses;
      try {
        responses = await Promise.all([first, second].map((session) => httpRequest(baseUrl, '/cart/add', { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': session.csrf }, body: JSON.stringify({ product_id: inhouseProdId, variant_id: variant5KgId, qty: 1 }) })));
      } finally {
        customerRepo.addCartLine = originalAddCartLine;
      }
      assert.ok(responses.every((response) => response.statusCode === 200), responses.map((response) => response.body.slice(0, 200)).join('\n'));
      const finalQuantity = Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?', [customer.id, inhouseProdId, variant5KgId])).quantity);
      assert.equal(finalQuantity, 3, 'two distinct authenticated sessions adding one each to quantity one must persist quantity three');
    } finally {
      await client.execute('UPDATE products SET stock_on_hand=?,stock_reserved=? WHERE id=?', [originalProduct.stock_on_hand, originalProduct.stock_reserved, inhouseProdId]);
      await client.execute('UPDATE product_variants SET stock_on_hand=?,stock_reserved=? WHERE id=?', [originalVariant.stock_on_hand, originalVariant.stock_reserved, variant5KgId]);
    }
  });

  test('9. Phase 07 concurrent authenticated updates to separate cart lines preserve both changes', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const phone = `014${String(Date.now()).slice(-8)}`;
    const customer = await customerRepo.registerCustomer({ name: 'Concurrent update owner', phone, password: 'SecureCartPassword!2026' });
    const vendorProduct = await client.queryOne('SELECT id FROM products WHERE slug=?', ['artisan-date-gift-box']);
    await client.execute('INSERT INTO customer_cart_items (customer_id,product_id,variant_id,quantity) VALUES (?,?,?,1)', [customer.id, inhouseProdId, variant5KgId]);
    await client.execute('INSERT INTO customer_cart_items (customer_id,product_id,variant_id,quantity) VALUES (?,?,NULL,1)', [customer.id, vendorProduct.id]);
    const makeSession = async () => {
      const initial = await httpRequest(baseUrl, '/api/v1/csrf-token');
      let cookie = (Array.isArray(initial.headers['set-cookie']) ? initial.headers['set-cookie'] : [initial.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
      const csrf = JSON.parse(initial.body).data.csrfToken;
      const auth = await httpRequest(baseUrl, '/customer/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf }, body: new URLSearchParams({ phone, password: 'SecureCartPassword!2026' }).toString() });
      assert.equal(auth.statusCode, 302);
      cookie = (Array.isArray(auth.headers['set-cookie']) ? auth.headers['set-cookie'] : [auth.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ') || cookie;
      const token = await httpRequest(baseUrl, '/api/v1/csrf-token', { headers: { Cookie: cookie } });
      return { cookie, csrf: JSON.parse(token.body).data.csrfToken };
    };
    const [first, second] = await Promise.all([makeSession(), makeSession()]);
    const originalSetCartLine = customerRepo.setCartLine;
    let arrivals = 0;
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    customerRepo.setCartLine = async (...args) => {
      arrivals += 1;
      if (arrivals === 2) openGate();
      await gate;
      return originalSetCartLine(...args);
    };
    let responses;
    try {
      const lineA = `saved-${inhouseProdId}-${variant5KgId}`;
      const lineB = `saved-${vendorProduct.id}-0`;
      responses = await Promise.all([
        httpRequest(baseUrl, '/cart/update', { method: 'POST', headers: { Cookie: first.cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': first.csrf }, body: JSON.stringify({ key: lineA, qty: 2 }) }),
        httpRequest(baseUrl, '/cart/update', { method: 'POST', headers: { Cookie: second.cookie, 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': second.csrf }, body: JSON.stringify({ key: lineB, qty: 2 }) }),
      ]);
    } finally {
      customerRepo.setCartLine = originalSetCartLine;
    }
    assert.ok(responses.every((response) => response.statusCode === 200), responses.map((response) => response.body.slice(0, 200)).join('\n'));
    const final = await client.queryAll('SELECT product_id,variant_id,quantity FROM customer_cart_items WHERE customer_id=?', [customer.id]);
    assert.equal(final.length, 2, 'both cart lines remain present');
    assert.equal(Number(final.find((row) => Number(row.product_id) === inhouseProdId)?.quantity), 2, 'customer A line update persists');
    assert.equal(Number(final.find((row) => Number(row.product_id) === Number(vendorProduct.id))?.quantity), 2, 'customer B line update persists');
  });

  test('10. MySQL quick-order uses canonical checkout, CSRF, configured delivery, variant prices, inventory and idempotency', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const suffix=String(Date.now()).slice(-8);
    const phone=`016${suffix}`;
    const customer=await customerRepo.registerCustomer({name:'Quick Order Customer',phone,password:'SecureQuickOrderPassword!2026'});
    const initial=await httpRequest(baseUrl,'/api/v1/csrf-token');
    let cookie=(Array.isArray(initial.headers['set-cookie'])?initial.headers['set-cookie']:[initial.headers['set-cookie']]).filter(Boolean).map(value=>value.split(';')[0]).join('; ');
    const login=await httpRequest(baseUrl,'/customer/login',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded','x-csrf-token':JSON.parse(initial.body).data.csrfToken},body:new URLSearchParams({phone,password:'SecureQuickOrderPassword!2026'}).toString()});
    assert.equal(login.statusCode,302);
    cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(value=>value.split(';')[0]).join('; ')||cookie;
    const tokenResponse=await httpRequest(baseUrl,'/api/v1/csrf-token',{headers:{Cookie:cookie}});
    const csrf=JSON.parse(tokenResponse.body).data.csrfToken;
    await customerRepo.addCartLine(customer.id,{product_id:inhouseProdId,variant_id:variant5KgId,qty:2});

    const locationResponse=await httpRequest(baseUrl,'/api/checkout/delivery-locations',{headers:{Cookie:cookie,Accept:'application/json'}});
    assert.equal(locationResponse.statusCode,200);
    const locations=JSON.parse(locationResponse.body).locations;
    assert.ok(locations.some(location=>Number(location.id)===Number(deliveryLocationId)),'quick order receives active configured delivery locations');
    const quoteParams=new URLSearchParams({product_id:String(inhouseProdId),qty:'1',size:'5 kg',color:'Family Pack',delivery_location_id:String(deliveryLocationId)});
    const quoteResponse=await httpRequest(baseUrl,`/api/checkout/quick-quote?${quoteParams.toString()}`,{headers:{Cookie:cookie,Accept:'application/json'}});
    assert.equal(quoteResponse.statusCode,200,quoteResponse.body.slice(0,300));
    const quote=JSON.parse(quoteResponse.body);
    assert.deepEqual([Number(quote.unitPricePaisa),Number(quote.subtotalPaisa),Number(quote.shippingPaisa),Number(quote.totalPaisa)],[88000,88000,5500,93500],'UI quote uses authoritative canonical integer-paisa price and active configured delivery');
    await client.execute('UPDATE product_variants SET status=0 WHERE product_id=?',[inhouseProdId]);
    let inactiveVariantQuote;
    try { inactiveVariantQuote=await httpRequest(baseUrl,`/api/checkout/quick-quote?${quoteParams.toString()}`,{headers:{Cookie:cookie,Accept:'application/json'}}); }
    finally { await client.execute('UPDATE product_variants SET status=1 WHERE product_id=?',[inhouseProdId]); }
    assert.equal(inactiveVariantQuote.statusCode,409,'products whose variants are all inactive cannot fall back to unvarianted stock');
    const quickOrderPath='/order/quick-submit';
    const requestKey=`quick-order-${Date.now()}-${Math.random().toString(36).slice(2,12)}`;
    const payload={product_id:inhouseProdId,qty:1,size:'5 kg',color:'Family Pack',customer_name:customer.name,phone,address:'House 12, Quick Order Road',delivery_location_id:String(deliveryLocationId),quick_order_request_key:requestKey,price:1,shipping_charge:0,amount:1};
    const before=await client.queryOne('SELECT stock_reserved FROM product_variants WHERE id=?',[variant5KgId]);
    const missingCsrf=await httpRequest(baseUrl,quickOrderPath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});
    assert.equal(missingCsrf.statusCode,403,'quick order rejects a missing CSRF token before persistence');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key LIKE ?',[`quick:%:${requestKey}`])).n),0);

    const submitted=await httpRequest(baseUrl,quickOrderPath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Accept:'application/json','x-csrf-token':csrf},body:JSON.stringify(payload)});
    assert.equal(submitted.statusCode,200,submitted.body.slice(0,400));
    const submittedData=JSON.parse(submitted.body);
    assert.equal(submittedData.success,true);
    assert.match(submittedData.redirect,/^\/order-success\//);
    const order=await client.queryOne('SELECT id,customer_id,subtotal_paisa,shipping_paisa,total_paisa,paid_paisa,cod_due_paisa,payment_status,payment_method,order_status,traffic_source,utm_source,utm_medium,utm_campaign,analytics_consent_at,analytics_consent_version FROM orders WHERE invoice_no=?',[submittedData.invoice_id]);
    assert.ok(order);
    assert.equal(Number(order.customer_id),Number(customer.id));
    assert.deepEqual([Number(order.subtotal_paisa),Number(order.shipping_paisa),Number(order.total_paisa),Number(order.paid_paisa),Number(order.cod_due_paisa)],[88000,5500,93500,0,93500],'client-supplied price and shipping fields do not affect canonical paisa totals');
    assert.deepEqual([order.payment_status,order.payment_method,order.order_status],['unpaid','cod','pending']);
    assert.deepEqual([order.traffic_source,order.utm_source,order.utm_medium,order.utm_campaign,order.analytics_consent_at,order.analytics_consent_version],['Direct','','','',null,null],'quick order does not activate or persist attribution without explicit D6 consent');
    const item=await client.queryOne('SELECT product_id,variant_id,unit_price_paisa,qty,line_total_paisa FROM order_items WHERE order_id=?',[order.id]);
    assert.deepEqual([Number(item.product_id),Number(item.variant_id),Number(item.unit_price_paisa),Number(item.qty),Number(item.line_total_paisa)],[Number(inhouseProdId),Number(variant5KgId),88000,1,88000]);
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM order_status_history WHERE order_id=?',[order.id])).n),1,'canonical initial status history is written');
    assert.equal(Number((await client.queryOne("SELECT COUNT(*) AS n FROM stock_reservations WHERE reservation_key=? AND status='active'",[`order:${order.id}`])).n),1,'canonical inventory reservation is created');
    assert.equal(Number((await client.queryOne('SELECT stock_reserved FROM product_variants WHERE id=?',[variant5KgId])).stock_reserved),Number(before.stock_reserved)+1);
    assert.equal(Number((await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?',[customer.id,inhouseProdId,variant5KgId])).quantity),2,'quick order does not consume unrelated saved-cart contents');

    const replay=await httpRequest(baseUrl,quickOrderPath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Accept:'application/json','x-csrf-token':csrf},body:JSON.stringify(payload)});
    assert.equal(replay.statusCode,200);
    assert.equal(JSON.parse(replay.body).invoice_id,submittedData.invoice_id,'same request key replays the original invoice');
    assert.equal(Number((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key LIKE ?',[`quick:%:${requestKey}`])).n),1);
    assert.equal(Number((await client.queryOne('SELECT stock_reserved FROM product_variants WHERE id=?',[variant5KgId])).stock_reserved),Number(before.stock_reserved)+1,'idempotent retry does not reserve stock twice');
    const changed=await httpRequest(baseUrl,quickOrderPath,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Accept:'application/json','x-csrf-token':csrf},body:JSON.stringify({...payload,qty:2})});
    assert.equal(changed.statusCode,409,'request key cannot be reused with altered order data');
  });

  test('11. Phase 07 customer profile, order history pagination and order details are MySQL-backed and owner-scoped', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const suffix = String(Date.now()).slice(-8);
    const password = 'SecureHistoryPassword!2026';
    const owner = await customerRepo.registerCustomer({ name: 'Order history owner', phone: `013${suffix}`, email: `history-owner-${suffix}@example.invalid`, password });
    const other = await customerRepo.registerCustomer({ name: 'Different history owner', phone: `014${suffix}`, email: `history-other-${suffix}@example.invalid`, password });
    const insertOrder = async (customer, invoiceNo, name) => {
      const order = await client.execute(
        `INSERT INTO orders(invoice_no,customer_id,customer_name,customer_phone,shipping_address,division,district,subtotal_paisa,discount_paisa,shipping_paisa,total_paisa,paid_paisa,cod_due_paisa,payment_method,payment_status,order_status,order_channel)
         VALUES(?,?,?,?,?,'Dhaka','Dhaka',1250,50,600,1800,0,1800,'cod','unpaid','pending','storefront')`,
        [invoiceNo, customer.id, customer.name, customer.phone, 'House 18, History Road']
      );
      await client.execute(
        `INSERT INTO order_items(order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa,size_label,color_label)
         VALUES(?,?,?,1250,1,1250,'1 pack','Gold')`,
        [order.insertId, inhouseProdId, name]
      );
      return Number(order.insertId);
    };
    let oldestOrderId;
    let newestInvoice;
    for (let index = 0; index < 21; index += 1) {
      const invoice = `P07-HIST-${suffix}-${String(index).padStart(2, '0')}`;
      const id = await insertOrder(owner, invoice, `History item ${index}`);
      if (index === 0) oldestOrderId = id;
      if (index === 20) newestInvoice = invoice;
    }
    const foreignOrderId = await insertOrder(other, `P07-OTHER-${suffix}`, 'Private other customer item');

    const initial = await httpRequest(baseUrl, '/api/v1/csrf-token');
    let cookie = (Array.isArray(initial.headers['set-cookie']) ? initial.headers['set-cookie'] : [initial.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    const login = await httpRequest(baseUrl, '/customer/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': JSON.parse(initial.body).data.csrfToken }, body: new URLSearchParams({ phone: owner.phone, password }).toString() });
    assert.equal(login.statusCode, 302, 'owner logs in through the existing CSRF-protected route');
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map((value) => value.split(';')[0]).join('; ');

    const anonymous = await httpRequest(baseUrl, '/customer/account/orders');
    assert.equal(anonymous.statusCode, 302, 'order history requires a customer session');
    const account = await httpRequest(baseUrl, '/customer/account?lang=en', { headers: { Cookie: cookie } });
    assert.equal(account.statusCode, 200, account.body.slice(0, 300));
    assert.match(account.body, /Order history owner/);
    assert.match(account.body, /013\d{8}/);
    assert.match(account.body, new RegExp(`history-owner-${suffix}@example\\.invalid`));
    assert.doesNotMatch(account.body, new RegExp(`history-other-${suffix}@example\\.invalid`), 'account profile does not leak another customer profile');

    const firstPage = await httpRequest(baseUrl, '/customer/account/orders?lang=en', { headers: { Cookie: cookie } });
    assert.equal(firstPage.statusCode, 200, firstPage.body.slice(0, 300));
    assert.match(firstPage.body, new RegExp(newestInvoice));
    assert.doesNotMatch(firstPage.body, new RegExp(`P07-HIST-${suffix}-00`), 'first page is bounded to the newest 20 orders');
    assert.doesNotMatch(firstPage.body, new RegExp(`P07-OTHER-${suffix}`), 'history is isolated to the authenticated customer');
    assert.match(firstPage.body, /1 \/ 2/);
    const secondPage = await httpRequest(baseUrl, '/customer/account/orders?page=2&lang=en', { headers: { Cookie: cookie } });
    assert.equal(secondPage.statusCode, 200);
    assert.match(secondPage.body, new RegExp(`P07-HIST-${suffix}-00`));
    assert.doesNotMatch(secondPage.body, new RegExp(`P07-OTHER-${suffix}`));
    const invalidPage = await httpRequest(baseUrl, '/customer/account/orders?page=1.5', { headers: { Cookie: cookie } });
    assert.equal(invalidPage.statusCode, 400, 'malformed page values fail as client errors');

    const detail = await httpRequest(baseUrl, `/customer/account/orders/${oldestOrderId}?lang=en`, { headers: { Cookie: cookie } });
    assert.equal(detail.statusCode, 200, detail.body.slice(0, 300));
    assert.match(detail.body, new RegExp(`P07-HIST-${suffix}-00`));
    assert.match(detail.body, /History item 0/);
    assert.match(detail.body, /House 18, History Road/);
    assert.match(detail.body, /৳12\.50/);
    const foreignDetail = await httpRequest(baseUrl, `/customer/account/orders/${foreignOrderId}`, { headers: { Cookie: cookie } });
    assert.equal(foreignDetail.statusCode, 404, 'a different customer cannot retrieve order details by guessing its numeric ID');
    const invalidDetail = await httpRequest(baseUrl, '/customer/account/orders/not-an-id', { headers: { Cookie: cookie } });
    assert.equal(invalidDetail.statusCode, 404);
  });

  test('12. Phase 07 failed persistent-cart replacement rolls back instead of deleting valid saved data', { skip: !MYSQL_HOST ? SKIP_REASON : false }, async () => {
    const phone = `015${String(Date.now()).slice(-8)}`;
    const customer = await customerRepo.registerCustomer({ name: 'Cart rollback owner', phone, password: 'SecureCartPassword!2026' });
    await client.execute('INSERT INTO customer_cart_items (customer_id,product_id,variant_id,quantity) VALUES (?,?,?,2)', [customer.id, inhouseProdId, variant5KgId]);
    const triggerName = `fail_cart_insert_${process.pid}`;
    await client.execute(`CREATE TRIGGER \`${triggerName}\` BEFORE INSERT ON customer_cart_items FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional test failure'`);
    try {
      await assert.rejects(() => customerRepo.replaceCart(customer.id, [{ product_id: inhouseProdId, variant_id: variant5KgId, qty: 7 }]), 'injected insert failure must be surfaced');
      const persisted = await client.queryOne('SELECT quantity FROM customer_cart_items WHERE customer_id=? AND product_id=? AND variant_id=?', [customer.id, inhouseProdId, variant5KgId]);
      assert.equal(Number(persisted.quantity), 2, 'transaction rollback retains the pre-existing valid cart line');
    } finally {
      await client.execute(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
    }
  });

});
