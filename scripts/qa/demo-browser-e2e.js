'use strict';

// Disposable CI-only browser journey. The guarded service DB is reset before use
// and its schema is dropped after evidence is written; the runner is fail-closed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const nodeAssert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const { resetDisposableMysqlDatabase, dropDisposableMysqlSchema } = require('./mysql-test-database');
const { cleanupE2eResources } = require('./demo-e2e-cleanup');

const engine = process.env.QA_DB_ENGINE || 'unknown database';
const outDir = path.join(process.cwd(), 'qa-evidence', 'browser-final', engine);
fs.mkdirSync(outDir, { recursive: true });
const results = { engine, startedAt: new Date().toISOString(), journeys: [], cleanup: { status: 'PENDING' }, notices: [
  'Disposable CI database only; no production endpoint or external provider is configured.',
  'COD orders are test records only. No payment, courier, SMS, OTP, email, refund, or payout operation is invoked.',
] };
const suffix = crypto.randomBytes(4).toString('hex');
const phoneSuffix = crypto.randomBytes(4).readUInt32BE(0).toString().padStart(10, '0').slice(-8);
const demoTag = `DEMO-E2E-${suffix}`;
const demoPassword = `QaOnly-${crypto.randomBytes(12).toString('hex')}!`;
let pool, db, server, browser, mysql;
const ids = { customers: [], vendors: [], products: [], orders: [], category: null, uploadedFiles: [], testDataGroupId: null, cleanupCustomerId: null, adminUserId: null };
let adminCredentials,restrictedAdminCredentials,tempEvidenceFile='';
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
  mysql = require('../../src/db/mysqlPool');
  const { createQueryClient } = mysql;
  pool = mysql.getPool(); db = createQueryClient(pool);
  await resetDisposableMysqlDatabase(pool);
  // Secure, random disposable-only admin fixture. This code is guarded by NODE_ENV=test and exact mrtumi_test DB assertions above.
  const adminPassword=`E2eOnly-${crypto.randomBytes(20).toString('hex')}!`,adminEmail=`qa-admin-${suffix}@example.invalid`,adminHash=await bcrypt.hash(adminPassword,10);
  let adminRole=await db.queryOne("SELECT id FROM roles WHERE slug='admin' LIMIT 1");
  if(!adminRole){const r=await db.execute("INSERT INTO roles(name,slug,status) VALUES('Disposable QA Admin','admin',1)");adminRole={id:r.insertId};}
  const user=await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[adminRole.id,`Disposable QA ${suffix}`,adminEmail,`019${phoneSuffix}`,adminHash,'Admin']);ids.adminUserId=Number(user.insertId);adminCredentials={email:adminEmail,password:adminPassword};
  const requiredPermissions=['test_data.manage','orders.manage','returns.review','dashboard.view'];
  for(const key of requiredPermissions){const permission=await db.queryOne('SELECT id FROM permissions WHERE name=?',[key]);if(permission)await db.execute('INSERT IGNORE INTO role_permissions(role_id,permission_id) VALUES(?,?)',[adminRole.id,permission.id]);}
  const restrictedRoleResult=await db.execute("INSERT INTO roles(name,slug,status) VALUES('Disposable QA Restricted','qa_restricted',1)");const restrictedPassword=`NoPrivileges-${crypto.randomBytes(16).toString('hex')}!`,restrictedEmail=`qa-restricted-${suffix}@example.invalid`;await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[restrictedRoleResult.insertId,`Restricted QA ${suffix}`,restrictedEmail,`017${phoneSuffix}`,await bcrypt.hash(restrictedPassword,10),'Staff']);restrictedAdminCredentials={email:restrictedEmail,password:restrictedPassword};
  const tdGroup=await db.execute("INSERT INTO test_data_groups(group_key,label,description,source,created_by_user_id) VALUES(?,?,?,'e2e',?)",[`e2e-${suffix}`,`${demoTag} Browser QA`, 'Generated only inside guarded disposable browser E2E database.',ids.adminUserId]);ids.testDataGroupId=Number(tdGroup.insertId);
  // A deliberately synthetic, standalone record is used to exercise confirmed cleanup in the Admin UI.
  const cleanupCustomer=await db.execute('INSERT INTO customers(name,phone,email,password_hash,status) VALUES(?,?,?,?,1)',[`${demoTag} cleanup-only`, `018${phoneSuffix}`,`cleanup-${suffix}@example.invalid`,'']);ids.cleanupCustomerId=Number(cleanupCustomer.insertId);
  const version = await db.queryOne('SELECT VERSION() AS version');
  results.serverVersion = version.version;

  const cat = await db.execute('INSERT INTO categories(name_bn,name_en,slug,status) VALUES(?,?,?,1)', ['DEMO মুদিখানা', 'DEMO Grocery', `demo-${suffix}`]);
  ids.category = Number(cat.insertId);
  await db.execute('UPDATE categories SET test_data_group_id=? WHERE id=?',[ids.testDataGroupId,ids.category]);
  await db.execute('INSERT INTO return_category_policies(category_id,eligible,window_days,updated_by_user_id) VALUES(?,1,7,?)',[ids.category,ids.adminUserId]);
  const vendorPasswordHash = await bcrypt.hash(demoPassword, 8);
  for (let i = 1; i <= 2; i++) {
    const r = await db.execute("INSERT INTO vendors(shop_name,owner_name,phone,email,password_hash,verified,status,lifecycle_status) VALUES(?,?,?,?,?,1,1,'active')", [`${demoTag} Vendor 0${i}`, `Demo Vendor 0${i}`, `013${suffix}${i}111`, `demo-vendor-${i}-${suffix}@example.invalid`, vendorPasswordHash]);
    ids.vendors.push(Number(r.insertId));
    await db.execute('UPDATE vendors SET test_data_group_id=? WHERE id=?',[ids.testDataGroupId,r.insertId]);
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
    await db.execute('UPDATE products SET test_data_group_id=? WHERE id=?',[ids.testDataGroupId,r.insertId]);
  }
  const loc = await db.execute("INSERT INTO delivery_locations(division,district,upazila,delivery_charge_paisa,status) VALUES('QA','QA','QA',0,1)");
  const codGateway = await db.queryOne('SELECT id FROM payment_gateways WHERE code=? AND status=1', ['cod']);
  assert(codGateway, 'Expected the active COD gateway seeded by migration 0020.');
  results.fixture = { tag: demoTag, ids: JSON.parse(JSON.stringify(ids)), codGatewayId: Number(codGateway.id), syntheticAccounts: ['demo-customer-01', 'demo-customer-02', 'demo-vendor-01', 'demo-vendor-02'], credentialNote: 'Random password generated for CI-only fixtures; intentionally omitted from artifacts and logs.' };

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
    const phone = `01${3 + index}${phoneSuffix}`;
    const email = `demo-customer-${index}-${suffix}@example.invalid`;
    customerPhones[index - 1] = phone;
    await page.goto(`${baseUrl}/customer/register`, { waitUntil: 'domcontentloaded' });
    const registrationForm = page.locator('form').filter({ has: page.locator('input[name="privacy_policy_version"]') }).first();
    await registrationForm.locator('input[name="name"]').fill(`Demo Customer 0${index} ${suffix}`);
    await registrationForm.locator('input[name="email"]').fill(email);
    await registrationForm.locator('input[name="phone"]').fill(phone);
    await registrationForm.locator('input[name="password"]').fill(demoPassword);
    await registrationForm.locator('input[name="privacy_notice_acknowledged"]').check();
    await page.screenshot({ path: path.join(outDir, `customer-${index}-registration.png`), fullPage: true });
    const responsePromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await registrationForm.locator('button[type="submit"],button:not([type])').first().click();
    const registrationResponse = await responsePromise;
    await page.screenshot({ path: path.join(outDir, `customer-${index}-registration-result.png`), fullPage: true });
    const registrationBody = await page.locator('body').innerText().catch(() => '');
    assert(page.url().endsWith('/customer/account'), `registration did not establish account; HTTP=${registrationResponse?.status()} url=${page.url()} body=${registrationBody.slice(0, 600)}`);
    await page.context().clearCookies();
    await page.goto(`${baseUrl}/customer/login`, { waitUntil: 'domcontentloaded' });
    const loginForm = page.locator('form[action="/customer/login"]');
    await loginForm.locator('input[name="phone"]').fill(phone);
    await loginForm.locator('input[name="password"]').fill(demoPassword);
    const loginNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await loginForm.locator('button[type="submit"],button:not([type])').first().click();
    await loginNavigation;
    assert(page.url().endsWith('/customer/account'), `fresh customer login failed; url=${page.url()}`);
    const row = await db.queryOne('SELECT id FROM customers WHERE phone=?', [phone]);
    assert(row, `registered customer ${index} missing from MySQL`);
    ids.customers.push(Number(row.id));
    await db.execute('UPDATE customers SET test_data_group_id=? WHERE id=?',[ids.testDataGroupId,row.id]);
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
    const addResponsePromise = page.waitForResponse(response => response.url().endsWith('/cart/add') && response.request().method() === 'POST');
    await page.locator('#productCartForm button[type="submit"]').first().click();
    const addResponse = await addResponsePromise;
    const addResult = await addResponse.json();
    assert(addResponse.ok() && addResult.success, `normal add-to-cart request failed: HTTP=${addResponse.status()} message=${addResult.message || ''}`);
    await page.goto(`${baseUrl}/cart`, { waitUntil: 'domcontentloaded' });
    const cartText = await page.locator('body').innerText();
    assert(cartText.includes(productNames[productIndex - 1][0]), `product missing from normal browser cart; url=${page.url()} body=${cartText.slice(0, 500)}`);
    await page.screenshot({ path: path.join(outDir, `customer-${index}-cart.png`), fullPage: true });
    await page.goto(`${baseUrl}/customer/checkout`, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(outDir, `customer-${index}-checkout.png`), fullPage: true });
    const checkoutForm = page.locator('#mainCheckoutForm');
    assert(await checkoutForm.count(), `customer checkout form absent; url=${page.url()} body=${(await page.locator('body').innerText()).slice(0, 500)}`);
    await checkoutForm.locator('input[name="customer_name"]').fill(`Demo Customer 0${index} ${suffix}`);
    await checkoutForm.locator('input[name="phone"]').fill(identity.phone);
    await checkoutForm.locator('textarea[name="address"]').fill(`${demoTag} test address; do not dispatch`);
    await checkoutForm.locator('input[name="note"]').fill(`${demoTag} checkout; no dispatch`);
    await checkoutForm.locator('select[name="delivery_location_id"]').selectOption({ index: 1 });
    await checkoutForm.locator('input[name="payment_method"][value="cod"]').check();
    await checkoutForm.locator('input[name="confirm_order"]').check();
    const responsePromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await checkoutForm.locator('button[type="submit"]').click();
    await responsePromise;
    assert(page.url().includes('/order-success/'), `COD order did not complete: ${page.url()}`);
    const invoice = decodeURIComponent(page.url().split('/').pop());
    const order = await db.queryOne('SELECT id,invoice_no,order_status,payment_method,customer_id FROM orders WHERE invoice_no=?', [invoice]);
    assert(order, `order ${invoice} absent from MySQL`);
    nodeAssert.equal(order.payment_method, 'cod');
    nodeAssert.equal(Number(order.customer_id), ids.customers[index - 1]);
    ids.orders.push(Number(order.id));
    await db.execute('UPDATE orders SET test_data_group_id=? WHERE id=?',[ids.testDataGroupId,order.id]);
    const stockAfter = await db.queryOne('SELECT vendor_stock_on_hand,vendor_stock_reserved FROM products WHERE id=?', [selectedProductId]);
    nodeAssert.equal(Number(stockAfter.vendor_stock_on_hand), Number(stockBefore.vendor_stock_on_hand), 'placing a pending COD order should reserve, not consume, vendor stock');
    nodeAssert.equal(Number(stockAfter.vendor_stock_reserved), Number(stockBefore.vendor_stock_reserved) + 1, 'pending order did not reserve exactly one unit from the assigned vendor pool');
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
    const loginForm = page.locator('form[action="/customer/login"]');
    await loginForm.locator('input[name="phone"]').fill(customerPhones[0]);
    await loginForm.locator('input[name="password"]').fill(demoPassword);
    const loginNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await loginForm.locator('button[type="submit"],button:not([type])').first().click();
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
    nodeAssert.equal(Number(productAfterCancel.vendor_stock_reserved), 0, 'cancellation did not release the demo product reservation');
    await page.screenshot({ path: path.join(outDir, 'customer-cancellation.png'), fullPage: true });
    return { orderId, cancellationStatus: row.status };
  });

  await journey('Admin login, order management and explicit test-data cleanup', async () => {
    assert(adminCredentials && ids.adminUserId,'disposable-only admin fixture was not provisioned');
    await page.context().clearCookies();await page.goto(`${baseUrl}/admin/login`,{waitUntil:'domcontentloaded'});
    const login=page.locator('form').first();await login.locator('input[name="email"]').fill(adminCredentials.email);await login.locator('input[name="password"]').fill(adminCredentials.password);let adminNav=page.waitForNavigation({waitUntil:'domcontentloaded'});await login.locator('button[type="submit"]').click();await adminNav;
    assert(page.url().includes('/admin/dashboard'),'random disposable admin login failed');
    const csrfDenied=await page.request.post(`${baseUrl}/admin/test-data/groups`,{form:{label:'missing CSRF must be rejected'}});assert(csrfDenied.status()===403,'Admin test-data write accepted a missing CSRF token');
    await page.context().clearCookies();await page.goto(`${baseUrl}/admin/login`,{waitUntil:'domcontentloaded'});const restrictedLogin=page.locator('form').first();await restrictedLogin.locator('input[name="email"]').fill(restrictedAdminCredentials.email);await restrictedLogin.locator('input[name="password"]').fill(restrictedAdminCredentials.password);let restrictedNav=page.waitForNavigation({waitUntil:'domcontentloaded'});await restrictedLogin.locator('button[type="submit"]').click();await restrictedNav;const deniedPage=await page.goto(`${baseUrl}/admin/test-data`,{waitUntil:'domcontentloaded'});assert(deniedPage?.status()===403,'Admin without test_data.manage permission accessed the management page');
    await page.context().clearCookies();await page.goto(`${baseUrl}/admin/login`,{waitUntil:'domcontentloaded'});const ownerLogin=page.locator('form').first();await ownerLogin.locator('input[name="email"]').fill(adminCredentials.email);await ownerLogin.locator('input[name="password"]').fill(adminCredentials.password);let ownerNav=page.waitForNavigation({waitUntil:'domcontentloaded'});await ownerLogin.locator('button[type="submit"]').click();await ownerNav;
    await page.goto(`${baseUrl}/admin/phase08/orders?q=${encodeURIComponent((await db.queryOne('SELECT invoice_no FROM orders WHERE id=?',[ids.orders[1]])).invoice_no)}`,{waitUntil:'domcontentloaded'});
    assert((await page.locator('body').innerText()).includes((await db.queryOne('SELECT invoice_no FROM orders WHERE id=?',[ids.orders[1]])).invoice_no),'admin cannot find the generated test order');
    for(const status of ['confirmed','processing','shipped']){
      const form=page.locator(`form[action="/admin/phase08/orders/${ids.orders[1]}/status"]`);await form.locator('select[name="status"]').selectOption(status);await form.locator('input[name="reason"]').fill(`${demoTag} disposable admin QA transition`);const nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await form.locator('button').click();await nav;
    }
    const transitioned=await db.queryOne('SELECT order_status FROM orders WHERE id=?',[ids.orders[1]]);assert(transitioned.order_status==='shipped','admin order lifecycle did not reach shipped');
    await page.goto(`${baseUrl}/admin/test-data`,{waitUntil:'domcontentloaded'});const testDataHeading=await page.locator('h1').innerText();assert(testDataHeading.includes('Test Data Management')||testDataHeading.includes('টেস্ট ডেটা ব্যবস্থাপনা'),'Admin Test Data Management page missing in both supported locales');
    const create=page.locator('form[action="/admin/test-data/groups"]');await create.locator('input[name="label"]').fill(`${demoTag} UI cleanup group`);await create.locator('input[name="description"]').fill('E2E-only explicit cleanup confirmation.');const created=page.waitForNavigation({waitUntil:'domcontentloaded'});await create.locator('button').click();await created;
    assert(page.url().includes('/admin/test-data/groups/'),'Admin group creation did not redirect to group inspection');const groupId=Number(page.url().split('/').pop());
    await page.goto(`${baseUrl}/admin/test-data/groups/${groupId}?type=customers&q=${encodeURIComponent(`018${phoneSuffix}`)}`,{waitUntil:'domcontentloaded'});
    const mark=page.locator(`form[action="/admin/test-data/groups/${groupId}/mark"]`).filter({has:page.locator(`input[name="entity_id"][value="${ids.cleanupCustomerId}"]`)});assert(await mark.count(),'standalone synthetic customer was not available as an explicit candidate');page.once('dialog',dialog=>dialog.accept());let nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await mark.locator('button').click();await nav;
    const confirmation=`CLEAN ${(await db.queryOne('SELECT group_key FROM test_data_groups WHERE id=?',[groupId])).group_key}`;
    const clean=page.locator(`form[action="/admin/test-data/groups/${groupId}/cleanup"]`);assert(await clean.count(),'safe cleanup preview was not offered');await clean.locator('input[name="confirmation"]').fill(confirmation);page.once('dialog',dialog=>dialog.accept());nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await clean.locator('button').click();await nav;
    const customerAfter=await db.queryOne('SELECT id FROM customers WHERE id=?',[ids.cleanupCustomerId]);assert(!customerAfter,'confirmed Admin cleanup left the isolated synthetic record');
    const cleanupBody=await page.locator('body').innerText();assert(cleanupBody.includes('Cleanup completed')||cleanupBody.includes('পরিষ্কার সম্পন্ন'),'cleanup result and audit status not shown in either locale');
    const history=await db.queryOne('SELECT result FROM test_data_cleanup_runs WHERE group_id=? ORDER BY id DESC LIMIT 1',[groupId]);assert(history?.result==='completed','cleanup audit history missing');
    await page.screenshot({path:path.join(outDir,'admin-test-data-cleanup.png'),fullPage:true});
    return {adminUserId:ids.adminUserId,orderId:ids.orders[1],orderStatus:transitioned.order_status,cleanupGroupId:groupId,cleanedCustomerId:ids.cleanupCustomerId,cleanupAudit:history.result};
  });

  await journey('Vendor login, tenant isolation and assigned order visibility', async () => {
    if (ids.orders.length < 2) throw Object.assign(new Error('BLOCKED: both customer COD orders are required before vendor tenant visibility can be compared.'), { code: 'BLOCKED_NO_VENDOR_ORDER_PAIR' });
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
      if (!page.url().includes('/vendor/orders')) {
        const body = await page.locator('body').innerText().catch(() => '');
        attempts.push({ vendorId: ids.vendors[i - 1], status: 'FAIL', url: page.url(), response: body.slice(0, 240) });
        continue;
      }
      const ownOrder = await db.queryOne('SELECT invoice_no FROM orders WHERE id=?', [ids.orders[i - 1]]);
      const foreignOrder = await db.queryOne('SELECT invoice_no FROM orders WHERE id=?', [ids.orders[i === 1 ? 1 : 0]]);
      const portalText = await page.locator('body').innerText();
      assert(portalText.includes(ownOrder.invoice_no), `vendor ${i} cannot see assigned DEMO order ${ownOrder.invoice_no}`);
      assert(!portalText.includes(foreignOrder.invoice_no), `vendor ${i} can see foreign vendor order ${foreignOrder.invoice_no}`);
      await page.screenshot({ path: path.join(outDir, `vendor-${i}-orders.png`), fullPage: true });
      attempts.push({ vendorId: ids.vendors[i - 1], status: 'PASS', ownOrder: ownOrder.invoice_no, foreignOrderHidden: foreignOrder.invoice_no });
    }
    if (attempts.some(a => a.status === 'BLOCKED')) throw Object.assign(new Error(`BLOCKED: both synthetic vendors were individually tested; MySQL vendor login uses legacy SQLite db.get and cannot authenticate. Observations=${JSON.stringify(attempts)}`), { code: 'BLOCKED_VENDOR_LEGACY_SQLITE_AUTH' });
    assert(attempts.every(a => a.status === 'PASS'), 'one or more vendor logins failed');
    return { vendorIds: ids.vendors, attempts };
  });

  await journey('Return request, evidence upload and policy-authorized review', async () => {
    const orderId=ids.orders[1],customerId=ids.customers[1];
    const categoryPolicy=await db.queryOne('SELECT eligible FROM return_category_policies WHERE category_id=?',[ids.category]);assert(Number(categoryPolicy?.eligible)===1,'disposable-only eligible category policy was not configured');
    const line=await db.queryOne('SELECT id FROM order_items WHERE order_id=? LIMIT 1',[orderId]);assert(line,'test order has no returnable order line');
    await page.context().clearCookies();await page.goto(`${baseUrl}/customer/login`,{waitUntil:'domcontentloaded'});const login=page.locator('form[action="/customer/login"]');await login.locator('input[name="phone"]').fill(customerPhones[1]);await login.locator('input[name="password"]').fill(demoPassword);let nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await login.locator('button[type="submit"],button:not([type])').first().click();await nav;assert(page.url().endsWith('/customer/account'),'return customer login failed');
    const detailResponse=await page.goto(`${baseUrl}/customer/account/orders/${orderId}`,{waitUntil:'domcontentloaded'});const form=page.locator(`form[action^="/customer/account/orders/${orderId}/returns"]`);if(!(await form.count())){const orderDebug=await db.queryOne('SELECT id,customer_id,order_status FROM orders WHERE id=?',[orderId]);const actions=await page.locator('form').evaluateAll(forms=>forms.map(f=>f.getAttribute('action')));throw new Error(`Return form unavailable: HTTP ${detailResponse?.status()} at ${page.url()}, order=${JSON.stringify(orderDebug)}, expectedCustomer=${customerId}, forms=${JSON.stringify(actions)}, body=${(await page.locator('body').innerText()).slice(0,600)}`);}const returnLine=await db.queryOne('SELECT id,qty FROM order_items WHERE order_id=? ORDER BY id LIMIT 1',[orderId]);assert(returnLine,'return order line missing from database');await form.locator('.return-line').first().check();await form.locator('input[name="items_json"]').evaluate((input,value)=>{input.value=value;},JSON.stringify([{orderItemId:Number(returnLine.id),qty:1}]));await form.locator('select[name="claim_type"]').selectOption('wrong');await form.locator('textarea[name="reason"]').fill(`${demoTag} return workflow test`);const evidenceFile=path.join(os.tmpdir(),`mrtumi-${suffix}-return-proof.png`);tempEvidenceFile=evidenceFile;fs.writeFileSync(evidenceFile,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52]));await form.locator('input[name="evidence"]').setInputFiles(evidenceFile);nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await form.locator('button').click();await nav;
    const returned=await db.queryOne('SELECT id,status,evidence_path FROM customer_return_requests WHERE order_id=? AND customer_id=? ORDER BY id DESC LIMIT 1',[orderId,customerId]);if(returned?.status!=='requested'){const returnPage=(await page.locator('body').innerText()).slice(0,1800);const events=await db.queryAll('SELECT id,claim_type,status,reason FROM customer_return_requests WHERE order_id=?',[orderId]);throw new Error(`Customer return request not recorded: url=${page.url()} db=${JSON.stringify(events)} body=${returnPage}`);}assert(returned.evidence_path.startsWith('/uploads/custom/'),'return evidence upload was not saved to the custom upload area');ids.uploadedFiles.push(returned.evidence_path);fs.unlinkSync(evidenceFile);tempEvidenceFile='';
    await page.context().clearCookies();await page.goto(`${baseUrl}/admin/login`,{waitUntil:'domcontentloaded'});const adminLogin=page.locator('form').first();await adminLogin.locator('input[name="email"]').fill(adminCredentials.email);await adminLogin.locator('input[name="password"]').fill(adminCredentials.password);nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await adminLogin.locator('button[type="submit"]').click();await nav;await page.goto(`${baseUrl}/admin/d7/returns?status=requested`,{waitUntil:'domcontentloaded'});assert((await page.locator('body').innerText()).includes(String(returned.id)),'admin return review cannot see the submitted return');
    const decision=page.locator(`form[action="/admin/d7/returns/${returned.id}/decision"]`);assert(await decision.count(),'admin return decision form missing');await decision.locator('input[name="note"],textarea[name="note"]').fill(`${demoTag} reviewed in disposable E2E`);nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await decision.locator('button[name="status"][value="approved"]').click();await nav;
    const reviewed=await db.queryOne('SELECT status FROM customer_return_requests WHERE id=?',[returned.id]);assert(reviewed.status==='approved','Admin return decision was not saved');await page.screenshot({path:path.join(outDir,'return-admin-review.png'),fullPage:true});
    return {orderId,returnId:Number(returned.id),categoryPolicy:'disposable-only eligible',customerRequest:'PASS',adminReview:reviewed.status};
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
    try {
      if(tempEvidenceFile&&fs.existsSync(tempEvidenceFile))fs.unlinkSync(tempEvidenceFile);
      if(ids.uploadedFiles.length){const upload=require('../../src/middleware/upload');for(const file of ids.uploadedFiles){if(typeof file==='string'&&file.startsWith('/uploads/custom/'))upload.safeUnlink(path.join(upload.resolveUploadBase(),path.basename(file)));}}
      if (pool) {
        try {
          const auditRows = await db.queryAll('SELECT actor_type,actor_id,action,entity_type,entity_id,created_at FROM audit_logs WHERE (entity_type=\'customer\' AND entity_id IN (SELECT CAST(id AS CHAR) FROM customers WHERE phone LIKE ?)) OR entity_id IN (SELECT CAST(id AS CHAR) FROM orders WHERE customer_note LIKE ? OR invoice_no LIKE ?) ORDER BY id', [`%${suffix}%`, `%${demoTag}%`, `%${demoTag}%`]);
          results.auditEvidence = auditRows;
        } catch (error) { results.auditEvidenceError = `${error.code || error.name}: ${error.message}`; }
        const cleanupErrors = await cleanupE2eResources({
          browser,
          server,
          pool,
          resetDatabase: async (targetPool) => {
            await dropDisposableMysqlSchema(targetPool);
            const checkPool = mysql.getPool();
            const [tables] = await checkPool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'");
            const [migrationRows] = await checkPool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=\'schema_migrations\'');
            results.cleanup.remainingTables = Number(tables[0].n);
            results.cleanup.remainingMigrationTables = Number(migrationRows[0].n);
            if (results.cleanup.remainingTables !== 0 || results.cleanup.remainingMigrationTables !== 0) {
              throw new Error(`cleanup verification found ${results.cleanup.remainingTables} tables and ${results.cleanup.remainingMigrationTables} migration tables`);
            }
          },
          closePool: () => mysql.closePool(),
        });
        if (cleanupErrors.length) {
          results.cleanup.status = 'FAIL';
          results.cleanup.errors = cleanupErrors.map(({ resource, error }) => `${resource}: ${error.code || error.name}: ${error.message}`);
          failure ||= cleanupErrors[0].error;
        } else {
          results.cleanup.status = 'PASS';
          results.cleanup.method = 'Dropped all tables, including schema_migrations, only in the guarded disposable mrtumi_test database.';
        }
      } else results.cleanup.status = 'BLOCKED_SETUP_FAILED_BEFORE_DB_INIT';
    } catch (error) {
      results.cleanup.status = 'FAIL';
      results.cleanup.error = `${error.code || error.name}: ${error.message}`;
      failure ||= error;
      if (pool && mysql) {
        try { await mysql.closePool(); }
        catch (closeError) { results.cleanup.poolCloseError = `${closeError.code || closeError.name}: ${closeError.message}`; }
      }
    }
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
