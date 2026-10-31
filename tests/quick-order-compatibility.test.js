'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');

const dbFile = path.join(os.tmpdir(), `mrtumi-quick-order-compat-${process.pid}.db`);
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = dbFile;
process.env.SEED_DEMO_DATA = 'true';
process.env.LOG_SILENT = 'true';

const db = require('../src/db/database');
let server;
let baseUrl;
let productId;
let cookie;
let csrfToken;

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch {}
  }
  db.initializeDatabase();
  const product = db.run(
    `INSERT INTO products(name,slug,code,category_id,new_price,wholesale_price,wholesale_min_qty,stock,sold_count,sizes,colors,status)
     VALUES('Quick order SQLite fixture','quick-order-sqlite-fixture','QCOMPAT-1',1,500,400,3,10,0,'Standard','',1)`
  );
  productId = Number(product.lastInsertRowid);

  const { startServer } = require('../server');
  server = startServer(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const csrfResponse = await fetch(`${baseUrl}/api/v1/csrf-token`);
  assert.equal(csrfResponse.status, 200);
  csrfToken = (await csrfResponse.json()).data.csrfToken;
  cookie = (csrfResponse.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch {}
  }
});

async function submitQuickOrder({ token = csrfToken, payload = {} } = {}) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (token) headers['x-csrf-token'] = token;
  return fetch(`${baseUrl}/order/quick-submit`, {
    method: 'POST', headers,
    body: JSON.stringify({
      product_id: productId, qty: 2, customer_name: 'SQLite Quick Buyer', phone: '01755504001',
      address: 'House 3, SQLite Quick Road', shipping_area: 'ঢাকার ভিতরে', ...payload,
    }),
    redirect: 'manual',
  });
}

test('SQLite quick order rejects missing CSRF without persisting an order or changing stock', async () => {
  const beforeStock = db.get('SELECT stock,sold_count FROM products WHERE id=?', productId);
  const response = await submitQuickOrder({ token: '' });
  assert.equal(response.status, 403);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM orders WHERE order_type='quick_order'").n), 0);
  assert.deepEqual(db.get('SELECT stock,sold_count FROM products WHERE id=?', productId), beforeStock);
});

test('SQLite quick order retains its existing COD order and stock behavior with the portal-supplied CSRF token', async () => {
  const response = await submitQuickOrder();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.match(result.redirect, /^\/order-success\//);
  const order = db.get('SELECT invoice_id,subtotal,shipping_charge,amount,payment_status,status,order_type FROM orders WHERE invoice_id=?', result.invoice_id);
  assert.deepEqual([Number(order.subtotal), Number(order.shipping_charge), Number(order.amount), order.payment_status, order.status, order.order_type], [1000, 60, 1060, 'unpaid', 'pending', 'quick_order']);
  assert.deepEqual(db.get('SELECT stock,sold_count FROM products WHERE id=?', productId), { stock: 8, sold_count: 2 });
});
