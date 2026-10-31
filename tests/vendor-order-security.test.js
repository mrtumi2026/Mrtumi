'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const bcrypt = require('bcryptjs');

const dbFile = path.join(os.tmpdir(), `mrtumi-vendor-order-security-${process.pid}.db`);
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = dbFile;
process.env.SEED_DEMO_DATA = 'true';
process.env.LOG_SILENT = 'true';

const db = require('../src/db/database');
let server;
let baseUrl;
let vendorId;
let ownedOrderId;
let foreignOrderId;
let cookie;
let csrfToken;

function sessionCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function request(route, { method = 'GET', body = null, token = csrfToken } = {}) {
  const headers = { accept: 'text/html' };
  if (cookie) headers.cookie = cookie;
  if (token) headers['x-csrf-token'] = token;
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
    redirect: 'manual',
  });
  const text = await response.text();
  const tokenMatch = text.match(/name="_csrf" value="([^"]+)"/);
  if (tokenMatch) csrfToken = tokenMatch[1];
  return { response, text };
}

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch {}
  }
  db.initializeDatabase();
  const password = 'VendorSecurityFixturePass!2026';
  const hash = bcrypt.hashSync(password, 8);
  const vendorA = db.run(
    `INSERT INTO vendors(shop_name,owner_name,phone,email,address,password_hash,commission_rate,balance,verified,status)
     VALUES(?,?,?,?,?,?,10,0,1,1)`,
    'Security Fixture Vendor A', 'Fixture Owner A', '01755501001', 'vendor-a@example.test', '', hash
  );
  const vendorB = db.run(
    `INSERT INTO vendors(shop_name,owner_name,phone,email,address,password_hash,commission_rate,balance,verified,status)
     VALUES(?,?,?,?,?,?,10,0,1,1)`,
    'Security Fixture Vendor B', 'Fixture Owner B', '01755501002', 'vendor-b@example.test', '', hash
  );
  vendorId = Number(vendorA.lastInsertRowid);
  const productA = db.run(
    `INSERT INTO products(name,slug,code,category_id,vendor_id,new_price,stock,approval_status,status)
     VALUES('Vendor A fixture','vendor-a-security-fixture','VSAFE-A',1,?,500,5,'approved',1)`, vendorId
  );
  const productB = db.run(
    `INSERT INTO products(name,slug,code,category_id,vendor_id,new_price,stock,approval_status,status)
     VALUES('Vendor B fixture','vendor-b-security-fixture','VSAFE-B',1,?,500,5,'approved',1)`, Number(vendorB.lastInsertRowid)
  );
  function makeOrder(invoice, productId) {
    const order = db.run(
      `INSERT INTO orders(invoice_id,customer_name,phone,address,subtotal,amount,status)
       VALUES(?, 'Security fixture customer', '01755502000', 'Fixture address', 500, 500, 'pending')`, invoice
    );
    db.run(
      `INSERT INTO order_items(order_id,product_id,product_name,price,qty)
       VALUES(?,?,?,500,1)`,
      Number(order.lastInsertRowid), Number(productId), `Fixture ${invoice}`
    );
    return Number(order.lastInsertRowid);
  }
  ownedOrderId = makeOrder('VSAFE-OWNED', productA.lastInsertRowid);
  foreignOrderId = makeOrder('VSAFE-FOREIGN', productB.lastInsertRowid);

  const { startServer } = require('../server');
  server = startServer(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const loginPage = await fetch(`${baseUrl}/vendor/login`, { redirect: 'manual' });
  cookie = sessionCookie(loginPage);
  const loginHtml = await loginPage.text();
  const match = loginHtml.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'vendor login form supplies the session-bound CSRF token');
  csrfToken = match[1];
  const login = await fetch(`${baseUrl}/vendor/login`, {
    method: 'POST',
    headers: {
      accept: 'text/html',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrfToken,
    },
    body: new URLSearchParams({ identifier: '01755501001', password }).toString(),
    redirect: 'manual',
  });
  assert.equal(login.status, 302, 'fixture vendor login succeeds');
  cookie = sessionCookie(login) || cookie;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch {}
  }
});

test('vendor mark-ready form carries the session-bound CSRF token', async () => {
  const { response, text } = await request('/vendor/orders');
  assert.equal(response.status, 200);
  assert.match(text, /name="_csrf" value="[^"]+"/);
  assert.match(text, new RegExp(`/vendor/orders/mark-ready/${ownedOrderId}`));
});

test('vendor mark-ready POST rejects missing CSRF before any order/history write', async () => {
  const { response } = await request(`/vendor/orders/mark-ready/${foreignOrderId}`, { method: 'POST', token: '' });
  assert.equal(response.status, 403);
  assert.equal(db.get('SELECT status FROM orders WHERE id=?', foreignOrderId).status, 'pending');
});

test('mark-ready remains fail-closed for both the vendor-owned and another vendor order', async () => {
  for (const orderId of [ownedOrderId, foreignOrderId]) {
    const { response } = await request(`/vendor/orders/mark-ready/${orderId}`, { method: 'POST' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/vendor/orders');
    assert.equal(db.get('SELECT status FROM orders WHERE id=?', orderId).status, 'pending');
  }
});
