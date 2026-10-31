'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const bcrypt = require('bcryptjs');

const fixtureRoot = path.join(os.tmpdir(), `mrtumi-partner-csrf-${process.pid}`);
const dbFile = path.join(fixtureRoot, 'partners.db');
const uploadDir = path.join(fixtureRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = dbFile;
process.env.UPLOAD_DIR = uploadDir;
process.env.SEED_DEMO_DATA = 'true';
process.env.LOG_SILENT = 'true';

const db = require('../src/db/database');
let server;
let baseUrl;
let vendorId;
let resellerId;
let vendorProductId;
let vendorCookie;
let vendorCsrf;
let resellerCookie;
let resellerCsrf;

function responseCookie(response) {
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

async function formPost(route, cookie, token, fields = {}) {
  const headers = { accept: 'text/html', cookie, 'content-type': 'application/x-www-form-urlencoded' };
  if (token) headers['x-csrf-token'] = token;
  return fetch(`${baseUrl}${route}`, {
    method: 'POST', headers, body: new URLSearchParams(fields).toString(), redirect: 'manual',
  });
}

async function hiddenTokenPost(route, cookie, token) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { accept: 'text/html', cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token }).toString(),
    redirect: 'manual',
  });
}

async function loginPartner(kind, identifier, password) {
  const loginPage = await fetch(`${baseUrl}/${kind}/login`, { redirect: 'manual' });
  const cookie = responseCookie(loginPage);
  const html = await loginPage.text();
  const token = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(token, `${kind} login form renders its CSRF token`);
  const login = await formPost(`/${kind}/login`, cookie, token[1], { identifier, password });
  assert.equal(login.status, 302, `${kind} fixture login succeeds`);
  const authenticatedCookie = responseCookie(login) || cookie;
  const portal = await fetch(`${baseUrl}/${kind}/dashboard`, { headers: { cookie: authenticatedCookie } });
  const portalHtml = await portal.text();
  const rotatedToken = portalHtml.match(/name="_csrf" value="([^"]+)"/);
  return { cookie: authenticatedCookie, csrf: rotatedToken ? rotatedToken[1] : token[1] };
}

before(async () => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  db.initializeDatabase();
  const vendorPassword = 'VendorCSRFFixturePass!2026';
  const resellerPassword = 'ResellerCSRFFixturePass!2026';
  const vendor = db.run(
    `INSERT INTO vendors(shop_name,owner_name,phone,email,address,password_hash,commission_rate,balance,verified,status)
     VALUES(?,?,?,?,?,?,10,500,1,1)`,
    'CSRF Fixture Vendor', 'Fixture Vendor Owner', '01755505001', 'vendor-csrf@example.test', 'Fixture address', bcrypt.hashSync(vendorPassword, 8)
  );
  vendorId = Number(vendor.lastInsertRowid);
  const product = db.run(
    `INSERT INTO products(name,slug,code,category_id,vendor_id,new_price,stock,approval_status,status)
     VALUES('CSRF Vendor Product','csrf-vendor-product','VCSRF-1',1,?,500,10,'approved',1)`, vendorId
  );
  vendorProductId = Number(product.lastInsertRowid);
  const reseller = db.run(
    `INSERT INTO resellers(name,shop_name,phone,email,balance,password_hash,verified,status)
     VALUES(?,?,?,?,500,?,1,1)`,
    'CSRF Fixture Reseller', 'Fixture Reseller Shop', '01755505002', 'reseller-csrf@example.test', bcrypt.hashSync(resellerPassword, 8)
  );
  resellerId = Number(reseller.lastInsertRowid);

  const { startServer } = require('../server');
  server = startServer(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const vendorAuth = await loginPartner('vendor', '01755505001', vendorPassword);
  vendorCookie = vendorAuth.cookie;
  vendorCsrf = vendorAuth.csrf;
  const resellerAuth = await loginPartner('reseller', '01755505002', resellerPassword);
  resellerCookie = resellerAuth.cookie;
  resellerCsrf = resellerAuth.csrf;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('vendor and reseller authenticated forms render CSRF tokens on every state-changing portal form', async () => {
  const pages = [
    ['/vendor/dashboard', vendorCookie],
    ['/vendor/products', vendorCookie],
    ['/vendor/products/create', vendorCookie],
    ['/vendor/profile', vendorCookie],
    ['/vendor/withdrawals', vendorCookie],
    ['/vendor/orders', vendorCookie],
    ['/reseller/dashboard', resellerCookie],
    ['/reseller/orders/create', resellerCookie],
    ['/reseller/profile', resellerCookie],
    ['/reseller/deposits', resellerCookie],
    ['/reseller/withdrawals', resellerCookie],
  ];
  for (const [route, cookie] of pages) {
    const response = await fetch(`${baseUrl}${route}`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(response.status, 200, `${route} renders for the authenticated fixture`);
    const html = await response.text();
    assert.match(html, /name="_csrf" value="[^"]+"/, `${route} includes a session CSRF token in its POST form`);
  }
});

test('missing CSRF rejects every vendor and reseller state-changing route before handler-side writes', async () => {
  const vendorRoutes = [
    '/vendor/login', '/vendor/register', '/vendor/logout',
    '/vendor/products/create', `/vendor/products/edit/${vendorProductId}`,
    `/vendor/products/delete/${vendorProductId}`, '/vendor/withdrawals/request',
    '/vendor/profile', '/vendor/orders/mark-ready/987654',
  ];
  const resellerRoutes = [
    '/reseller/login', '/reseller/register', '/reseller/logout',
    '/reseller/orders/create', '/reseller/deposits/create',
    '/reseller/withdrawals/create', '/reseller/profile',
  ];
  const vendorSnapshot = db.get('SELECT shop_name,phone,balance FROM vendors WHERE id=?', vendorId);
  const resellerSnapshot = db.get('SELECT name,phone,balance FROM resellers WHERE id=?', resellerId);
  const vendorProductBefore = db.get('SELECT id,name FROM products WHERE id=? AND vendor_id=?', vendorProductId, vendorId);
  const vendorWithdrawalsBefore = Number(db.get('SELECT COUNT(*) AS n FROM vendor_withdrawals WHERE vendor_id=?', vendorId).n);
  const resellerTransactionsBefore = Number(db.get('SELECT COUNT(*) AS n FROM reseller_transactions WHERE reseller_id=?', resellerId).n);
  const resellerOrdersBefore = Number(db.get('SELECT COUNT(*) AS n FROM orders WHERE reseller_id=?', resellerId).n);

  for (const route of vendorRoutes) {
    const response = await formPost(route, vendorCookie, '');
    assert.equal(response.status, 403, `missing CSRF is rejected on ${route}`);
  }
  for (const route of resellerRoutes) {
    const response = await formPost(route, resellerCookie, '');
    assert.equal(response.status, 403, `missing CSRF is rejected on ${route}`);
  }

  assert.deepEqual(db.get('SELECT shop_name,phone,balance FROM vendors WHERE id=?', vendorId), vendorSnapshot);
  assert.deepEqual(db.get('SELECT name,phone,balance FROM resellers WHERE id=?', resellerId), resellerSnapshot);
  assert.deepEqual(db.get('SELECT id,name FROM products WHERE id=? AND vendor_id=?', vendorProductId, vendorId), vendorProductBefore);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM vendor_withdrawals WHERE vendor_id=?', vendorId).n), vendorWithdrawalsBefore);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM reseller_transactions WHERE reseller_id=?', resellerId).n), resellerTransactionsBefore);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM orders WHERE reseller_id=?', resellerId).n), resellerOrdersBefore);
  assert.equal((await fetch(`${baseUrl}/vendor/dashboard`, { headers: { cookie: vendorCookie } })).status, 200, 'a rejected logout keeps the vendor session active');
  assert.equal((await fetch(`${baseUrl}/reseller/dashboard`, { headers: { cookie: resellerCookie } })).status, 200, 'a rejected logout keeps the reseller session active');
});

test('invalid-CSRF multipart product uploads delete only the newly uploaded file', async () => {
  const uploadRoot = path.join(uploadDir, 'custom');
  fs.mkdirSync(uploadRoot, { recursive: true });
  const sentinelPath = path.join(uploadRoot, 'pre-existing-file.jpg');
  fs.writeFileSync(sentinelPath, 'preserve-existing-file');
  const before = fs.readdirSync(uploadRoot).sort();

  for (const route of ['/vendor/products/create', `/vendor/products/edit/${vendorProductId}`]) {
    const form = new FormData();
    form.set('name', 'Untrusted upload request');
    form.set('image', new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'new-upload.jpg');
    const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { cookie: vendorCookie }, body: form, redirect: 'manual' });
    assert.equal(response.status, 403, `${route} rejects missing CSRF after parsing the multipart body`);
    assert.deepEqual(fs.readdirSync(uploadRoot).sort(), before, `${route} removes its unassigned upload without touching existing files`);
  }
  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'preserve-existing-file');
  assert.deepEqual(db.get('SELECT id,name FROM products WHERE id=? AND vendor_id=?', vendorProductId, vendorId), { id: vendorProductId, name: 'CSRF Vendor Product' });
});

test('session-bound hidden form tokens authorize the normal vendor and reseller logout flows', async () => {
  const vendorLogout = await hiddenTokenPost('/vendor/logout', vendorCookie, vendorCsrf);
  assert.equal(vendorLogout.status, 302);
  assert.equal(vendorLogout.headers.get('location'), '/vendor/login');
  const resellerLogout = await hiddenTokenPost('/reseller/logout', resellerCookie, resellerCsrf);
  assert.equal(resellerLogout.status, 302);
  assert.equal(resellerLogout.headers.get('location'), '/reseller/login');
  assert.equal((await fetch(`${baseUrl}/vendor/dashboard`, { headers: { cookie: vendorCookie }, redirect: 'manual' })).headers.get('location'), '/vendor/login');
  assert.equal((await fetch(`${baseUrl}/reseller/dashboard`, { headers: { cookie: resellerCookie }, redirect: 'manual' })).headers.get('location'), '/reseller/login');
});
