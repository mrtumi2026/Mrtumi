'use strict';

// Disposable CI-only browser journey. The service DB is reset before use and
// migrated down after evidence is written; the runner is deliberately fail-closed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');

const engine = process.env.QA_DB_ENGINE || 'unknown database';
const outDir = path.join(process.cwd(), 'qa-evidence', 'browser-final', engine);
fs.mkdirSync(outDir, { recursive: true });
const results = { engine, startedAt: new Date().toISOString(), journeys: [], cleanup: { status: 'PENDING' }, notices: [
  'Disposable CI database only; no production endpoint or external provider is configured.',
  'COD orders are test records only. No payment, courier, SMS, OTP, email, refund, or payout operation is invoked.',
] };
const suffix = crypto.randomBytes(4).toString('hex');
const demoTag = `DEMO-E2E-${suffix}`;
const demoPassword = `QaOnly-${crypto.randomBytes(12).toString('hex')}!`;
let pool, db, server, browser;
const ids = { customers: [], vendors: [], products: [], orders: [], category: null, uploadedFiles: [] };
const customerPhones = [];
let baseUrl = '';

function assert(condition, message) { if (!condition) throw new Error(message); }
async function journey(name, fn) {
  const item = { name, status: 'RUNNING', startedAt: new Date().toISOString() };
  results.journeys.push(item);
  try { item.details = await fn(); item.status = 'PASS'; }
  catch (error) { item.status = String(error.code || '').startsWith('BLOCKED_') ? 'BLOCKED' : 'FAIL'; item.error = `${error.code || error.name || 'Error'}: ${error.message}`; item.stack = String(error.stack || '').split('\n').slice(0, 8).join('\n'); }
  item.finishedAt = new Date().toISOString();
}
async function main() {
  assert(process.env.NODE_ENV === 'test' && process.env.DB_CLIENT === 'mysql', 'Refusing to run outside the MySQL test profile.');
  assert(process.env.DB_NAME === 'mrtumi_test' && process.env.DB_USER === 'mrtumi_test' && process.env.DB_HOST === '127.0.0.1', 'Refusing to use a database other than the named disposable CI service.');
  assert(process.env.MYSQL_TEST_REQUIRED === 'true', 'MYSQL_TEST_REQUIRED must be enabled.');
  const mysql = require('../../src/db/mysqlPool');
  const migrator = require('../../src/db/migrator');
  const { createQueryClient } = mysql;
  pool = mysql.getPool(); db = createQueryClient(pool);
  await migrator.migrateDown(pool, { steps: 13 });
  await migrator.migrateUp(pool);
  const version = await db.queryOne('SELECT VERSION() AS version');
  results.serverVersion = version.version;

  const cat = await db.execute('INSERT INTO categories(name_bn,name_en,slug,status) VALUES(?,?,?,1)', ['DEMO মুদিখানা', 'DEMO Grocery', `demo-${suffix}`]);
  ids.category = Number(cat.insertId);
  const vendorPasswordHash = await bcrypt.hash(demoPassword, 8);
  for (let i = 1; i <= 2; i++) {
    const r = await db.execute('INSERT INTO vendors(shop_name,owner_name,phone,email,password_hash,verified,status) VALUES(?,?,?,?,?,1,1)', [`${demoTag} Vendor 0${i}`, `Demo Vendor 0${i}`, `013${suffix}${i}111`, `demo-vendor-${i}-${suffix}@example.invalid`, vendorPasswordHash]);
    ids.vendors.push(Number(r.insertId));
  }
  const productNames = [
    ['ডেমো সুগন্ধি চাল', 'DEMO Aromatic Rice', 'বাংলাদেশি সুগন্ধি চালের পরীক্ষামূলক প্যাক।', 'A test pack of aromatic Bangladeshi rice.', 18500],
    ['ডেমো খেজুর উপহার বাক্স', 'DEMO Date Gift Box', 'উপহারের জন্য নির্বাচিত খেজুরের বাক্স।', 'A curated date box prepared for gifting.', 42000],
    ['ডেমো মধু জার', 'DEMO Raw Honey Jar', 'প্রাকৃতিক স্বাদের পরীক্ষামূলক মধু।', 'A test jar of honey with a naturally rich taste.', 26500],
    ['ডেমো মসলা উপহার সেট', 'DEMO Spice Gift Set', 'রান্নার জন্য বাছাইকৃত মসলার সেট।', 'A giftable set of selected cooking spices.', 31500],
    ['ডেমো চা ও বিস্কুট হ্যাম্পার', 'DEMO Tea & Biscuit Hamper', 'চা ও বিস্কুটের ছোট উপহার প্যাক।', 'A small hamper of tea and biscuits.', 22500],
  ];
  for (let i = 0; i < productNames.length; i++) {
    const [bn, en, descBn, descEn, price] = productNames[i];
    const r = await db.execute(`INSERT INTO products(sku,slug,name_bn,name_en,category_id,vendor_id,regular_price_paisa,sale_price_paisa,stock_on_hand,vendor_stock_on_hand,short_desc_bn,short_desc_en,image_url,approval_status,status)
      VALUES(?,?,?,?,?,?,?, ?,0,20,?,?,?,'approved',1)`, [`${demoTag}-${i+1}`, `${demoTag.toLowerCase()}-${i+1}`, bn, en, ids.category, ids.vendors[i % 2], price, price, descBn, descEn, '/uploads/product/lychee-box.jpg']);
    ids.products.push(Number(r.insertId));
  }
  const loc = await db.execute("INSERT INTO delivery_locations(division,district,upazila,delivery_charge_paisa,status) VALUES('QA','QA','QA',0,1)");
  await db.execute("INSERT INTO payment_gateways(name,code,gateway_type,sandbox,status) VALUES('QA COD','cod','manual',1,1)");
  results.fixture = { tag: demoTag, ids: JSON.parse(JSON.stringify(ids)), syntheticAccounts: ['demo-customer-01', 'demo-customer-02', 'demo-vendor-01', 'demo-vendor-02'], credentialNote: 'Random password generated for CI-only fixtures; intentionally omitted from artifacts and logs.' };

  const { startServer } = require('../../server');
  server = startServer(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const consoleLogs = [];
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on('console', msg => consoleLogs.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', error => consoleLogs.push(`pageerror: ${error.message}`));
  results.browser = { userAgent: await page.evaluate(() => navigator.userAgent), viewportWidths: [360, 390, 768, 1366] };

  await journey('Public storefront: all five DEMO products render', async () => {
    const r = await page.goto(`${baseUrl}/all-products`, { waitUntil: 'domcontentloaded' });
    assert(r && r.ok(), `catalog returned ${r?.status()}`);
    for (let i = 0; i < ids.products.length; i++) {
      const url = `${baseUrl}/product/${encodeURIComponent(`${demoTag.toLowerCase()}-${i+1}`)}`;
      const productResponse = await page.goto(url, { waitUntil: 'domcontentloaded' });
      assert(productResponse && productResponse.ok(), `product ${i+1} returned ${productResponse?.status()}`);
      await page.screenshot({ path: path.join(outDir, `product-${i+1}.png`), fullPage: true });
      assert((await page.locator('h1').first().textContent())?.trim(), `product ${i+1} has no title`);
    }
    return { productIds: ids.products, publicUrls: ids.products.map((_, i) => `/product/${demoTag.toLowerCase()}-${i+1}`) };
  });

  async function registerCustomer(index) {
    const phone = `01${3 + index}${suffix.padEnd(8, '0').slice(0, 8)}${index}`.slice(0, 11);
    const email = `demo-customer-${index}-${suffix}@example.invalid`;
    customerPhones[index - 1] = phone;
    await page.goto(`${baseUrl}/customer/register`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="name"]').fill(`Demo Customer 0${index} ${suffix}`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="phone"]').fill(phone);
    await page.locator('input[name="password"]').fill(demoPassword);
    await page.locator('input[name="privacy_notice_acknowledged"]').check();
    await page.screenshot({ path: path.join(outDir, `customer-${index}-registration.png`), fullPage: true });
    const responsePromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('form').first().locator('button[type="submit"],button:not([type])').first().click();
    await responsePromise;
    assert(page.url().endsWith('/customer/account'), `registration did not establish account; url=${page.url()}`);
    await page.context().clearCookies();
    await page.goto(`${baseUrl}/customer/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="phone"]').fill(phone);
    await page.locator('input[name="password"]').fill(demoPassword);
    const loginNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('form').first().locator('button[type="submit"],button:not([type])').first().click();
    await loginNavigation;
    assert(page.url().endsWith('/customer/account'), `fresh customer login failed; url=${page.url()}`);
    const row = await db.queryOne('SELECT id FROM customers WHERE phone=?', [phone]);
    assert(row, `registered customer ${index} missing from MySQL`);
    ids.customers.push(Number(row.id));
    return { phone, email };
  }

  async function customerCheckout(index, productIndex) {
    const identity = await registerCustomer(index);
    const selectedProductId = ids.products[productIndex - 1];
    const stockBefore = await db.queryOne('SELECT vendor_stock_on_hand,vendor_stock_reserved FROM products WHERE id=?', [selectedProductId]);
    // Verify fresh authenticated session and account-scoped history route.
    await page.goto(`${baseUrl}/customer/account/orders`, { waitUntil: 'domcontentloaded' });
    assert(page.url().endsWith('/customer/account/orders'), 'authenticated order history was not accessible');
    await page.screenshot({ path: path.join(outDir, `customer-${index}-history-before.png`), fullPage: true });
    await page.goto(`${baseUrl}/product/${demoTag.toLowerCase()}-${productIndex}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#productCartForm button[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${baseUrl}/customer/checkout`, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(outDir, `customer-${index}-checkout.png`), fullPage: true });
    await page.locator('input[name="customer_name"]').fill(`Demo Customer 0${index} ${suffix}`);
    await page.locator('input[name="phone"]').fill(identity.phone);
    await page.locator('textarea[name="address"]').fill(`${demoTag} test address; do not dispatch`);
    await page.locator('input[name="note"]').fill(`${demoTag} checkout; no dispatch`);
    await page.locator('select[name="delivery_location_id"]').selectOption({ index: 1 });
    await page.locator('input[name="payment_method"][value="cod"]').check();
    await page.locator('input[name="confirm_order"]').check();
    const responsePromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('#mainCheckoutForm button[type="submit"]').last().click();
    await responsePromise;
    assert(page.url().includes('/order-success/'), `COD order did not complete: ${page.url()}`);
    const invoice = decodeURIComponent(page.url().split('/').pop());
    const order = await db.queryOne('SELECT id,invoice_no,order_status,payment_method,customer_id FROM orders WHERE invoice_no=?', [invoice]);
    assert(order, `order ${invoice} absent from MySQL`);
    assert.equal(order.payment_method, 'cod');
    assert.equal(Number(order.customer_id), ids.customers[index - 1]);
    ids.orders.push(Number(order.id));
    const stockAfter = await db.queryOne('SELECT vendor_stock_on_hand,vendor_stock_reserved FROM products WHERE id=?', [selectedProductId]);
    assert.equal(Number(stockAfter.vendor_stock_on_hand), Number(stockBefore.vendor_stock_on_hand), 'placing a pending COD order should reserve, not consume, vendor stock');
    assert.equal(Number(stockAfter.vendor_stock_reserved), Number(stockBefore.vendor_stock_reserved) + 1, 'pending order did not reserve exactly one unit from the assigned vendor pool');
    await page.screenshot({ path: path.join(outDir, `customer-${index}-order-success.png`), fullPage: true });
    await page.goto(`${baseUrl}/customer/account/orders`, { waitUntil: 'domcontentloaded' });
    assert((await page.locator('body').innerText()).includes(invoice), 'new invoice absent from customer history');
    return { customerId: ids.customers[index - 1], orderId: Number(order.id), invoice, status: order.order_status, payment: 'COD only' };
  }

  await journey('Customer registration, login/session, storefront cart, COD checkout and order history', async () => {
    const first = await customerCheckout(1, 1);
    const second = await customerCheckout(2, 2);
    return { customers: ids.customers, orders: [first, second] };
  });

  await journey('Customer pre-dispatch cancellation', async () => {
    if (!ids.orders.length) throw Object.assign(new Error('BLOCKED: no preceding successful demo COD order exists.'), { code: 'BLOCKED_NO_DEMO_ORDER' });
    const orderId = ids.orders[0];
    await page.context().clearCookies();
    await page.goto(`${baseUrl}/customer/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="phone"]').fill(customerPhones[0]);
    await page.locator('input[name="password"]').fill(demoPassword);
    const loginNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('form').first().locator('button[type="submit"],button:not([type])').first().click();
    await loginNavigation;
    assert(page.url().endsWith('/customer/account'), 'customer 01 could not log in before cancellation');
    await page.goto(`${baseUrl}/customer/account/orders/${orderId}`, { waitUntil: 'domcontentloaded' });
    const form = page.locator(`form[action="/customer/account/orders/${orderId}/cancel"]`);
    assert(await form.count(), 'eligible pre-dispatch cancellation form is not available');
    await form.locator('input[name="reason"]').fill(`${demoTag} cancellation test`);
    const responsePromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await form.locator('button[type="submit"],button:not([type])').first().click();
    await responsePromise;
    const row = await db.queryOne('SELECT status FROM order_cancellation_requests WHERE order_id=? AND customer_id=? ORDER BY id DESC LIMIT 1', [orderId, ids.customers[0]]);
    assert(row, 'cancellation request was not recorded');
    const orderLine = await db.queryOne('SELECT product_id FROM order_items WHERE order_id=? LIMIT 1', [orderId]);
    const productAfterCancel = await db.queryOne('SELECT vendor_stock_reserved FROM products WHERE id=?', [orderLine.product_id]);
    assert.equal(Number(productAfterCancel.vendor_stock_reserved), 0, 'cancellation did not release the demo product reservation');
    await page.screenshot({ path: path.join(outDir, 'customer-cancellation.png'), fullPage: true });
    return { orderId, cancellationStatus: row.status };
  });

  await journey('Admin order visibility and management', async () => {
    const row = await db.queryOne("SELECT id FROM users WHERE status=1 ORDER BY id LIMIT 1");
    if (!row) throw Object.assign(new Error('BLOCKED: freshly migrated disposable CI database has no existing admin user; task forbids creating another admin.'), { code: 'BLOCKED_NO_EXISTING_ADMIN' });
    await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(outDir, 'admin-login.png'), fullPage: true });
    throw Object.assign(new Error('BLOCKED: existing admin credentials are not provisioned in the disposable CI schema; no admin account was created.'), { code: 'BLOCKED_ADMIN_CREDENTIALS_UNAVAILABLE' });
  });

  await journey('Vendor login, tenant isolation and assigned order visibility', async () => {
    const attempts = [];
    for (let i = 1; i <= 2; i++) {
      await page.context().clearCookies();
      await page.goto(`${baseUrl}/vendor/login`, { waitUntil: 'domcontentloaded' });
      await page.screenshot({ path: path.join(outDir, `vendor-${i}-login.png`), fullPage: true });
      const form = page.locator('form').first();
      await form.locator('input[name="identifier"]').fill(`demo-vendor-${i}-${suffix}@example.invalid`);
      await form.locator('input[name="password"]').fill(demoPassword);
      await form.locator('button[type="submit"],button:not([type])').first().click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (!page.url().includes('/vendor/dashboard')) {
        const body = await page.locator('body').innerText().catch(() => '');
        attempts.push({ vendorId: ids.vendors[i - 1], status: 'BLOCKED', url: page.url(), response: body.slice(0, 240) });
      } else {
        attempts.push({ vendorId: ids.vendors[i - 1], status: 'PASS' });
      }
    }
    if (attempts.some(a => a.status === 'BLOCKED')) throw Object.assign(new Error(`BLOCKED: both synthetic vendors were individually tested; MySQL vendor login uses legacy SQLite db.get and cannot authenticate. Observations=${JSON.stringify(attempts)}`), { code: 'BLOCKED_VENDOR_LEGACY_SQLITE_AUTH' });
    assert(attempts.every(a => a.status === 'PASS'), 'one or more vendor logins failed');
    return { vendorIds: ids.vendors, attempts };
  });

  await journey('Return request, evidence upload, and policy-authorized review', async () => {
    const eligible = await db.queryOne('SELECT COUNT(*) AS n FROM return_category_policies WHERE eligible=1');
    if (!Number(eligible?.n || 0)) throw Object.assign(new Error('BLOCKED: no return-eligible category policy exists in the migrated disposable database; no policy was invented or changed.'), { code: 'BLOCKED_NO_RETURN_POLICY' });
    throw Object.assign(new Error('BLOCKED: an eligible-category policy exists, but the preceding demo orders are pending/unfulfilled and cannot truthfully support a return request.'), { code: 'BLOCKED_NO_ELIGIBLE_DEMO_RETURN_ORDER' });
  });

  for (const width of [360, 390, 768, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(`${baseUrl}/all-products`, { waitUntil: 'domcontentloaded' });
    const metrics = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    results.browser[`viewport-${width}`] = { httpStatus: response?.status(), ...metrics };
    await page.screenshot({ path: path.join(outDir, `storefront-${width}.png`), fullPage: true });
  }
  results.console = consoleLogs.slice(-200);
  results.fixtures = JSON.parse(JSON.stringify(ids));
}

(async () => {
  let failure;
  try { await main(); } catch (error) {
    failure = error;
    results.runnerFailure = `${error.code || error.name || 'Error'}: ${error.message}`;
    results.stack = String(error.stack || '').split('\n').slice(0, 12).join('\n');
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { if (server) await new Promise(resolve => server.close(resolve)); } catch {}
    try {
      if (pool) {
        const mysql = require('../../src/db/mysqlPool');
        const migrator = require('../../src/db/migrator');
        try {
          const auditRows = await db.queryAll('SELECT actor_type,actor_id,action,entity_type,entity_id,created_at FROM audit_logs WHERE (entity_type=\'customer\' AND entity_id IN (SELECT CAST(id AS CHAR) FROM customers WHERE phone LIKE ?)) OR entity_id IN (SELECT CAST(id AS CHAR) FROM orders WHERE customer_note LIKE ? OR invoice_no LIKE ?) ORDER BY id', [`%${suffix}%`, `%${demoTag}%`, `%${demoTag}%`]);
          results.auditEvidence = auditRows;
        } catch (error) { results.auditEvidenceError = `${error.code || error.name}: ${error.message}`; }
        await migrator.migrateDown(pool, { steps: 13 });
        await mysql.closePool();
        results.cleanup.status = 'PASS';
        results.cleanup.method = 'Migrated down all 13 schema versions on the dedicated CI-only mrtumi_test service database; no production or SQLite database was touched.';
        const checkPool = mysql.getPool();
        const [tables] = await checkPool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' AND table_name<>'schema_migrations'");
        const [migrationRows] = await checkPool.query('SELECT COUNT(*) AS n FROM schema_migrations');
        results.cleanup.remainingTables = Number(tables[0].n);
        results.cleanup.remainingMigrationRows = Number(migrationRows[0].n);
        if (results.cleanup.remainingTables !== 0 || results.cleanup.remainingMigrationRows !== 0) throw new Error(`cleanup verification found ${results.cleanup.remainingTables} application tables and ${results.cleanup.remainingMigrationRows} migration rows`);
        await mysql.closePool();
      } else results.cleanup.status = 'BLOCKED_SETUP_FAILED_BEFORE_DB_INIT';
    } catch (error) { results.cleanup.status = 'FAIL'; results.cleanup.error = `${error.code || error.name}: ${error.message}`; failure ||= error; }
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, 'journey-results.json'), `${JSON.stringify(results, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'runner.log'), [`Engine: ${engine}`, `Tag: ${demoTag}`, `Started: ${results.startedAt}`, ...results.journeys.map(j => `${j.status} ${j.name}${j.error ? ` — ${j.error}` : ''}`), `Cleanup: ${results.cleanup.status}${results.cleanup.error ? ` — ${results.cleanup.error}` : ''}`, `Runner failure: ${results.runnerFailure || 'none'}`].join('\n') + '\n');
    const statusSummary = JSON.stringify({ engine, journeys: results.journeys.map(({ name, status, error }) => ({ name, status, error })), cleanup: results.cleanup, runnerFailure: results.runnerFailure || null }).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').slice(0, 5000);
    process.stdout.write(`::notice title=DEMO E2E evidence summary::${statusSummary}\n`);
    if (failure) {
      const annotation = String(results.runnerFailure || failure.message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').slice(0, 3000);
      process.stdout.write(`::error title=DEMO E2E runner failure::${annotation}\n`);
      console.error('DEMO E2E runner failure:', results.runnerFailure);
    }
  }
  const failures = results.journeys.filter(j => j.status === 'FAIL');
  if (failure || failures.length || results.cleanup.status !== 'PASS') process.exitCode = 1;
})();
