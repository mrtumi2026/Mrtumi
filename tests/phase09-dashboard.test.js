'use strict';

process.env.LOG_SILENT = 'true';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repo = require('../src/repositories/adminDashboardRepository');

describe('Phase 09 dashboard repository contract', () => {
  test('dashboard route delegates MySQL-mode reads to repository; SQLite calls stay only in explicit local branches', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/adminDashboard.js'), 'utf8');
    assert.match(source, /if \(env\.db\.client === 'mysql'\)\s*\{\s*return res\.render\('admin\/dashboard', await dashboardRepository\.getDashboardData\(\)\)/);
    assert.match(source, /router\.use\('\/admin', requireAdmin\)/);
    assert.match(source, /dashboardRepository\.getPollNewOrders/);
    assert.match(source, /dashboardRepository\.getUnseenOrders/);
    assert.doesNotMatch(source, /18420|1485\.50|342 \/ 5,000|25 Nov 2026|Pro Business Plan/);
  });

  test('MySQL repository uses bound params, converts paisa, and sanitizes database failures', async () => {
    const calls = [];
    const pool = { async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM orders') && sql.includes('total_orders')) return [[{ total_orders: 0, pending_orders: 0, delivered_count: 0, delivered_paisa: 0 }]];
      if (sql.includes('FROM orders WHERE created_at >=')) return [[{ order_count: 0, revenue_paisa: 0, delivered_paisa: 0 }]];
      if (sql.includes('GROUP BY dhaka_day')) return [[]];
      if (sql.includes('GROUP BY source')) return [[]];
      if (sql.includes('FROM order_statuses')) return [[]];
      if (sql.includes('FROM products WHERE')) return [[{ count: 0 }]];
      if (sql.includes('FROM products p')) return [[]];
      if (sql.includes('FROM categories c')) return [[]];
      if (sql.includes('FROM orders o')) return [[]];
      if (sql.includes('FROM fund_transactions')) return [[{ credits: 0, debits: 0 }]];
      if (sql.includes('FROM expenses')) return [[{ total: 0, today: 0, monthly: 0 }]];
      throw new Error(`Unexpected SQL in test: ${sql}`);
    } };
    const data = await repo.getDashboardData({ pool, now: new Date('2026-10-26T06:00:00Z') });
    assert.equal(data.totalOrders, 0);
    assert.equal(data.totalRevenue, 0);
    assert.equal(data.totalProducts, 0);
    assert.equal(data.dashboardProducts.length, 0);
    assert.equal(data.trendData.length, 7);
    assert.deepEqual(data.trendData, Array(7).fill(0));
    assert.ok(calls.every((c) => Array.isArray(c.params)), 'repository parameterizes all DB calls');
    assert.ok(calls.some((c) => c.sql.includes('total_paisa')));
    assert.ok(calls.some((c) => c.sql.includes('amount_paisa')));
    const failingPool = { async query() { const err = new Error('private connection string'); err.code = 'ER_NO_SUCH_TABLE'; throw err; } };
    await assert.rejects(repo.getDashboardData({ pool: failingPool }), (err) => {
      assert.equal(err.code, 'DB_QUERY_FAILED');
      assert.doesNotMatch(err.message, /private connection string|SELECT/);
      return true;
    });
  });
});
