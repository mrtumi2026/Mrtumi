'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const { DatabaseError } = require('../utils/errors');

function mysqlClient(poolOverride = null) {
  if (env.db.client !== 'mysql' && !poolOverride) {
    throw new DatabaseError('MYSQL_REQUIRED', 'Admin dashboard repository requires MySQL.', 503);
  }
  return createQueryClient(poolOverride || getPool());
}

function dhakaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function dhakaDayUtcBounds(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day) - 6 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 19).replace('T', ' '), end: new Date(start.getTime() + 86400000).toISOString().slice(0, 19).replace('T', ' ') };
}

const asNum = (value) => Number(value || 0);
const paisaToBdt = (value) => asNum(value) / 100;

async function getDashboardData({ pool = null, now = new Date() } = {}) {
  const client = mysqlClient(pool);
  const today = dhakaDate(now);
  const { start: dayStart, end: dayEnd } = dhakaDayUtcBounds(today);
  const trendStartDate = new Date(`${today}T00:00:00+06:00`);
  trendStartDate.setUTCDate(trendStartDate.getUTCDate() - 6);
  const trendDate = dhakaDate(trendStartDate);
  const { start: trendStart } = dhakaDayUtcBounds(trendDate);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [orderTotals, todayTotals, trendRows, trafficRows, statusRows, productTotals, lowStockTotals, products, categories, recentOrders, finance, expenses] = await Promise.all([
    client.queryOne(`SELECT COUNT(*) AS total_orders,
      SUM(order_status='pending') AS pending_orders,
      SUM(order_status='completed') AS delivered_count,
      COALESCE(SUM(CASE WHEN order_status='completed' THEN total_paisa ELSE 0 END),0) AS delivered_paisa
      FROM orders`),
    client.queryOne(`SELECT COUNT(*) AS order_count,
      COALESCE(SUM(total_paisa),0) AS revenue_paisa,
      COALESCE(SUM(CASE WHEN order_status='completed' THEN total_paisa ELSE 0 END),0) AS delivered_paisa
      FROM orders WHERE created_at >= ? AND created_at < ? AND order_status <> 'cancelled'`, [dayStart, dayEnd]),
    client.queryAll(`SELECT DATE(DATE_ADD(created_at, INTERVAL 6 HOUR)) AS dhaka_day, COUNT(*) AS count
      FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY dhaka_day`, [trendStart, dayEnd]),
    client.queryAll(`SELECT COALESCE(NULLIF(traffic_source,''),'Direct') AS source, COUNT(*) AS count FROM orders GROUP BY source ORDER BY count DESC`),
    client.queryAll(`SELECT s.name,s.color,COUNT(o.id) AS count FROM order_statuses s
      LEFT JOIN orders o ON o.order_status=s.slug GROUP BY s.id,s.name,s.color,s.sort_order HAVING COUNT(o.id)>0 ORDER BY s.sort_order`),
    client.queryOne(`SELECT COUNT(*) AS count FROM products WHERE is_archived=0 AND status=1 AND approval_status='approved'`),
    client.queryOne(`SELECT COUNT(*) AS count FROM products WHERE is_archived=0 AND status=1 AND approval_status='approved' AND GREATEST(0,CASE WHEN vendor_id IS NULL THEN stock_on_hand-stock_reserved ELSE vendor_stock_on_hand-vendor_stock_reserved END)<10`),
    client.queryAll(`SELECT p.id,p.name_bn,p.name_en,p.image_url,p.sale_price_paisa,p.regular_price_paisa,
      GREATEST(0,CASE WHEN p.vendor_id IS NULL THEN p.stock_on_hand-p.stock_reserved ELSE p.vendor_stock_on_hand-p.vendor_stock_reserved END) AS available_stock,
      COALESCE(c.name_bn,c.name_en) AS category_name
      FROM products p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.is_archived=0 AND p.status=1 AND p.approval_status='approved' ORDER BY p.id LIMIT 8`),
    client.queryAll(`SELECT c.id,COALESCE(c.name_bn,c.name_en) AS name,COUNT(p.id) AS product_count FROM categories c
      LEFT JOIN products p ON p.category_id=c.id AND p.is_archived=0 AND p.status=1 AND p.approval_status='approved'
      WHERE c.status=1 GROUP BY c.id,c.name_bn,c.name_en,c.sort_order ORDER BY c.sort_order,c.id`),
    client.queryAll(`SELECT o.id,o.invoice_no AS invoice_id,o.customer_name,o.customer_phone AS phone,
      o.total_paisa/100 AS amount,o.order_status,COALESCE(s.name,o.order_status) AS status_label,
      COALESCE(s.badge_class,'sb-1') AS badge_class,o.created_at
      FROM orders o LEFT JOIN order_statuses s ON s.slug=o.order_status ORDER BY o.id DESC LIMIT 8`),
    client.queryOne(`SELECT COALESCE(SUM(CASE WHEN tx_type='credit' THEN amount_paisa ELSE 0 END),0) AS credits,
      COALESCE(SUM(CASE WHEN tx_type='debit' THEN amount_paisa ELSE 0 END),0) AS debits FROM fund_transactions`),
    client.queryOne(`SELECT COALESCE(SUM(amount_paisa),0) AS total,
      COALESCE(SUM(CASE WHEN expense_date=? THEN amount_paisa ELSE 0 END),0) AS today,
      COALESCE(SUM(CASE WHEN expense_date>=? AND expense_date<? THEN amount_paisa ELSE 0 END),0) AS monthly
      FROM expenses`, [today, monthStart, new Date(Date.UTC(Number(today.slice(0,4)), Number(today.slice(5,7)), 1)).toISOString().slice(0,10)])
  ]);

  const totalOrders = asNum(orderTotals.total_orders);
  const trafficSources = trafficRows.map((row) => ({ source: row.source, count: asNum(row.count), percent: totalOrders ? ((asNum(row.count) / totalOrders) * 100).toFixed(1) : '0.0' }));
  const byDate = new Map(trendRows.map((row) => [String(row.dhaka_day).slice(0, 10), asNum(row.count)]));
  const trendLabels = [];
  const trendData = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(`${today}T12:00:00+06:00`);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dhakaDate(d);
    trendLabels.push(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', month: 'short', day: 'numeric' }).format(d));
    trendData.push(byDate.get(key) || 0);
  }
  const productsMapped = products.map((p) => ({
    id: Number(p.id), name: p.name_bn || p.name_en || '', image: p.image_url || '',
    new_price: paisaToBdt(p.sale_price_paisa), old_price: paisaToBdt(p.regular_price_paisa),
    stock: asNum(p.available_stock), category_name: p.category_name || '',
  }));
  const deliveredBdt = paisaToBdt(orderTotals.delivered_paisa);
  return {
    formattedDate: new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now),
    totalOrders, pendingOrders: asNum(orderTotals.pending_orders), totalRevenue: deliveredBdt,
    deliveredCount: asNum(orderTotals.delivered_count), lowStockCount: asNum(lowStockTotals.count),
    todayOrders: asNum(todayTotals.order_count), todayRevenue: paisaToBdt(todayTotals.revenue_paisa),
    todayDeliveredRev: paisaToBdt(todayTotals.delivered_paisa), trafficSources, trendLabels, trendData,
    statusBreakdown: statusRows.map((s) => ({ name: s.name, color: s.color, cnt: asNum(s.count) })),
    totalProducts: asNum(productTotals.count), dashboardProducts: productsMapped,
    dashboardCategories: categories.map((c) => ({ id: Number(c.id), name: c.name, product_count: asNum(c.product_count) })),
    recentOrders, fundBalance: paisaToBdt(asNum(finance.credits) - asNum(finance.debits) + asNum(orderTotals.delivered_paisa)),
    totalExpenses: paisaToBdt(expenses.total), todayExpenses: paisaToBdt(expenses.today), monthlyExpenses: paisaToBdt(expenses.monthly),
  };
}

async function getPollNewOrders(afterId = 0, { pool = null } = {}) {
  const client = mysqlClient(pool);
  const latest = await client.queryOne('SELECT COALESCE(MAX(id),0) AS max_id FROM orders');
  const rows = afterId > 0 ? await client.queryAll(`SELECT o.id,o.invoice_no AS invoice_id,o.customer_name,o.customer_phone AS phone,
    o.total_paisa/100 AS amount,COALESCE(s.name,o.order_status) AS status_name,o.created_at
    FROM orders o LEFT JOIN order_statuses s ON s.slug=o.order_status WHERE o.id>? ORDER BY o.id LIMIT 5`, [afterId]) : [];
  const orders = await Promise.all(rows.map(async (o) => {
    const items = await client.queryAll('SELECT product_name AS name,product_image AS image FROM order_items WHERE order_id=? ORDER BY id LIMIT 5', [o.id]);
    return { ...o, id: Number(o.id), products: items.slice(0, 4), more_count: Math.max(0, items.length - 4), process_url: `/admin/order/view/${o.id}` };
  }));
  return { latestId: asNum(latest.max_id), orders };
}

async function getUnseenOrders({ pool = null } = {}) {
  const client = mysqlClient(pool);
  const latest = await client.queryOne('SELECT COALESCE(MAX(id),0) AS latest_id FROM orders');
  const orders = await client.queryAll(`SELECT o.id,o.invoice_no AS invoice_id,o.customer_name,o.customer_phone AS phone,
    o.total_paisa/100 AS amount,COALESCE(s.name,'Pending') AS status_name,o.created_at FROM orders o
    LEFT JOIN order_statuses s ON s.slug=o.order_status WHERE o.is_seen=0 ORDER BY o.id DESC LIMIT 10`);
  return { latestId: asNum(latest.latest_id), orders: orders.map((o) => ({ ...o, id: Number(o.id), process_url: `/admin/order/view/${o.id}` })) };
}

async function dismissUnseenOrders(actor = {}, { pool = null } = {}) {
  const activePool = pool || getPool();
  return require('../db/mysqlPool').withTransaction(async (tx) => {
    const result = await tx.execute('UPDATE orders SET is_seen=1 WHERE is_seen=0');
    await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES('admin',?,'admin.dashboard.popup.dismissed','dashboard','unseen_orders',NULL,?,?,?)`,
      [actor.id || null, JSON.stringify({dismissedCount:Number(result.affectedRows||0)}), String(actor.ip||'').slice(0,64), String(actor.userAgent||'').slice(0,255)]);
    return result;
  }, {pool:activePool});
}

async function getAssistantSnapshot({ pool = null, now = new Date() } = {}) {
  const client = mysqlClient(pool);
  const { start, end } = dhakaDayUtcBounds(dhakaDate(now));
  const [dashboard, lowStock] = await Promise.all([
    getDashboardData({ pool, now }),
    client.queryAll(`SELECT COALESCE(name_bn,name_en) AS name,
      GREATEST(0,CASE WHEN vendor_id IS NULL THEN stock_on_hand-stock_reserved ELSE vendor_stock_on_hand-vendor_stock_reserved END) AS stock
      FROM products WHERE is_archived=0 AND status=1 AND approval_status='approved'
      ORDER BY stock LIMIT 5`)
  ]);
  return { ...dashboard, todayOrders: asNum((await client.queryOne('SELECT COUNT(*) AS n FROM orders WHERE created_at>=? AND created_at<?', [start,end])).n), lowStock };
}

module.exports = { dhakaDate, dhakaDayUtcBounds, getDashboardData, getPollNewOrders, getUnseenOrders, dismissUnseenOrders, getAssistantSnapshot };
