'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const SKIP = 'SKIPPED locally: no local mysqld/docker; required on GitHub Actions mysql:8.0 service';
if (REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true but MYSQL_TEST_HOST is missing.');
process.env.NODE_ENV = 'test';
process.env.LOG_SILENT = 'true';
if (MYSQL_HOST) {
  process.env.DB_CLIENT = 'mysql'; process.env.DB_HOST = MYSQL_HOST;
  process.env.DB_PORT = String(process.env.MYSQL_TEST_PORT || 3306);
  process.env.DB_NAME = process.env.MYSQL_TEST_DB || 'mrtumi_test';
  process.env.DB_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test';
  process.env.DB_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw';
}
const { getPool, createQueryClient, closePool } = require('../src/db/mysqlPool');
const { migrateUp, migrateDown } = require('../src/db/migrator');
const repo = require('../src/repositories/adminDashboardRepository');
const routes = require('../src/routes/adminDashboard');

describe('Phase 09 — live MySQL 8.0 admin dashboard repository and HTTP access', { skip: !MYSQL_HOST && !REQUIRED ? SKIP : false }, () => {
  let pool, db, server, baseUrl, cookie, productId;
  const day = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);

  before(async () => {
    if (!MYSQL_HOST) return;
    pool = getPool(); db = createQueryClient(pool);
    await migrateDown(pool, { steps: 10 }); await migrateUp(pool);
    const suffix = Date.now();
    const roleId = (await db.execute('INSERT INTO roles(name,slug,status) VALUES(?,?,1)', [`P09 dashboard ${suffix}`, `p09_dash_${suffix}`])).insertId;
    await db.execute("INSERT INTO permissions(name,module,description) VALUES('dashboard.view','dashboard','Dashboard read access') ON DUPLICATE KEY UPDATE name=VALUES(name)");
    const permission = await db.queryOne("SELECT id FROM permissions WHERE name='dashboard.view'");
    await db.execute('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?)', [roleId, permission.id]);
    const grants = await db.queryAll('SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?', [roleId]);
    const authorizedUser = { id: 999001, role_slug: `p09_dash_${suffix}`, permissions: grants.map((row) => row.name) };
    const app = express();
    app.use(session({ secret: 'phase09-dashboard-http-test-session-secret', resave: false, saveUninitialized: false }));
    app.use((req, res, next) => {
      req.adminUser = req.session.adminUser || null;
      res.render = (view, locals) => res.status(200).json({ view, locals });
      next();
    });
    app.get('/__test/login/:allowed', (req, res) => {
      if (req.params.allowed === 'yes') req.session.adminUser = authorizedUser;
      else req.session.adminUser = { id: 999002, role_slug: `p09_no_grant_${suffix}`, permissions: [] };
      req.session.save(() => res.status(204).end());
    });
    app.use(routes);
    app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ code: err.code || 'ERROR', message: err.message }));
    server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const cat = await db.execute("INSERT INTO categories(name_bn,name_en,slug,status) VALUES('ড্যাশবোর্ড','Dashboard',?,1)", [`p09-dash-${suffix}`]);
    productId = (await db.execute("INSERT INTO products(sku,slug,name_bn,name_en,category_id,regular_price_paisa,sale_price_paisa,stock_on_hand,stock_reserved,approval_status,status) VALUES(?,?,?,?,?,12000,10000,9,2,'approved',1)", [`P09-${suffix}`, `p09-dash-product-${suffix}`, 'পরীক্ষা', 'Dashboard product', cat.insertId])).insertId;
    await db.execute("INSERT INTO order_statuses(name,slug,badge_class,color,sort_order,status) VALUES('Completed','completed','sb-2','#00aa00',1,1) ON DUPLICATE KEY UPDATE name=VALUES(name)");
    const orderId = (await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 fixture','01712345678','Test address',10000,10000,0,10000,'completed','phase09-test',UTC_TIMESTAMP())", [`P09-${suffix}`])).insertId;
    const { start: dayStart, end: dayEnd } = repo.dhakaDayUtcBounds(today);
    await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 boundary','01712345678','Test address',1200,1200,0,1200,'pending','phase09-boundary',?)", [`P09-start-${suffix}`, dayStart]);
    await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 boundary','01712345678','Test address',1300,1300,0,1300,'pending','phase09-after-day',?)", [`P09-end-${suffix}`, dayEnd]);
    await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 cancelled','01712345678','Test address',1400,1400,0,1400,'cancelled','phase09-cancelled',?)", [`P09-cancel-${suffix}`, dayStart]);
    await db.execute('INSERT INTO order_items(order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES(?,?,?,10000,1,10000)', [orderId, productId, 'Dashboard product']);
    await db.execute("INSERT INTO fund_transactions(account_name,tx_type,amount_paisa,note,tx_date) VALUES('test','credit',2500,'fixture',?)", [today]);
    await db.execute("INSERT INTO expenses(title,category,amount_paisa,note,expense_date) VALUES('test','test',500,'fixture',?)", [today]);
  });
  after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (MYSQL_HOST) await closePool(); });

  async function get(path, useCookie = cookie) {
    return fetch(`${baseUrl}${path}`, { headers: { accept: 'application/json', ...(useCookie ? { cookie: useCookie } : {}) }, redirect: 'manual' });
  }
  async function sessionFor(allowed) {
    const response = await fetch(`${baseUrl}/__test/login/${allowed ? 'yes' : 'no'}`);
    return response.headers.get('set-cookie').split(';')[0];
  }

  test('MySQL repository distinguishes empty data, aggregates real paisa/status/date/stock and preserves bounded lists', async (t) => {
    if (!MYSQL_HOST) return t.skip(SKIP);
    const data = await repo.getDashboardData({ now: new Date() });
    assert.ok(data.totalOrders >= 4);
    assert.ok(data.pendingOrders >= 2);
    assert.equal(data.todayOrders, 2, 'includes start-boundary pending + current completed order, excludes cancelled and exact next-day boundary');
    assert.ok(data.todayRevenue >= 112);
    assert.ok(data.deliveredCount >= 1);
    assert.ok(data.totalRevenue >= 100);
    assert.ok(data.dashboardProducts.some((p) => p.id === Number(productId) && p.stock === 7 && p.new_price === 100));
    assert.ok(data.statusBreakdown.some((s) => s.name === 'Completed' && s.cnt >= 1));
    assert.equal(data.trendData.length, 7);
    assert.ok(data.recentOrders.length <= 8);
    assert.ok(data.trafficSources.some((source) => source.source === 'phase09-test'));
    assert.ok(data.todayExpenses >= 5);
    assert.ok(data.totalExpenses >= data.todayExpenses);
  });

  test('authenticated admin HTTP uses MySQL path; provider metrics stay unavailable (dashboard-specific RBAC remains open)', async (t) => {
    if (!MYSQL_HOST) return t.skip(SKIP);
    assert.equal((await get('/admin/dashboard', '')).status, 401);
    const deniedCookie = await sessionFor(false);
    assert.equal((await get('/admin/dashboard', deniedCookie)).status, 200, 'dashboard-specific granular RBAC is not implemented yet; current boundary is admin session only');
    cookie = await sessionFor(true);
    const dash = await get('/admin/dashboard');
    assert.equal(dash.status, 200);
    const body = await dash.text();
    assert.match(body, /Dashboard product/);
    for (const route of ['/admin/smsgeteway/balance', '/admin/bdcourier/my-plan', '/admin/steadfast/dashboard-widget']) {
      const response = await get(route);
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.equal(payload.status, 'unavailable');
      assert.equal(payload.success, false);
    }
  });
});
