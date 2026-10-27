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

      // Cart mutations are CSRF-protected in MySQL mode as well as the local prototype.
      const csrfStart = await httpRequest(baseUrl, '/api/v1/csrf-token');
      assert.equal(csrfStart.statusCode,200);
      const cartCsrf = JSON.parse(csrfStart.body).data.csrfToken;
      const cartCookie = (Array.isArray(csrfStart.headers['set-cookie']) ? csrfStart.headers['set-cookie'] : [csrfStart.headers['set-cookie']]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
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
});
