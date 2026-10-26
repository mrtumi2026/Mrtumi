const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { env } = require('../config/env');
const dashboardRepository = require('../repositories/adminDashboardRepository');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router();

router.use('/admin', requireAdmin);

// Main Dashboard. Production/MySQL reads are isolated in the async repository.
router.get('/admin/dashboard', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    return res.render('admin/dashboard', await dashboardRepository.getDashboardData());
  }
  // Legacy local prototype only; SQLite is prohibited by the DB guard in production/MySQL.
  const totalOrders = db.get('SELECT COUNT(*) AS c FROM orders').c;
  const pendingOrders = db.get("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'").c;
  const deliveredRow = db.get(
    "SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE status = 'completed'"
  );
  const lowStockCount = db.get('SELECT COUNT(*) AS c FROM products WHERE stock < 10').c;

  // Today's snapshot
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOrdersRow = db.get(
    "SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE substr(created_at, 1, 10) = ? AND status != 'cancelled'",
    todayStr
  );
  const todayDeliveredRev = db.get(
    "SELECT COALESCE(SUM(amount), 0) AS rev FROM orders WHERE substr(created_at, 1, 10) = ? AND status = 'completed'",
    todayStr
  ).rev;

  // Traffic sources
  const trafficRows = db.all(
    `SELECT COALESCE(NULLIF(traffic_source, ''), 'Direct') AS source, COUNT(*) AS cnt
     FROM orders GROUP BY source ORDER BY cnt DESC`
  );
  const trafficSources = trafficRows.map((r) => ({
    source: r.source,
    count: r.cnt,
    percent: totalOrders > 0 ? ((r.cnt / totalOrders) * 100).toFixed(1) : '0.0',
  }));

  // Last 7 days trend
  const trendLabels = [];
  const trendData = [];
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    trendLabels.push(`${monthsShort[d.getMonth()]} ${d.getDate()}`);
    const cnt = db.get('SELECT COUNT(*) AS c FROM orders WHERE substr(created_at, 1, 10) = ?', iso).c;
    trendData.push(cnt);
  }

  // Order Status breakdown for Donut chart
  const statusBreakdown = db.all(
    `SELECT os.name, os.color, COUNT(o.id) AS cnt
     FROM order_statuses os
     LEFT JOIN orders o ON o.status = os.slug
     GROUP BY os.id
     HAVING cnt > 0
     ORDER BY os.sort_order ASC`
  );

  // Products & Categories
  const totalProducts = db.get('SELECT COUNT(*) AS c FROM products').c;
  const dashboardProducts = db.all(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     ORDER BY p.id ASC LIMIT 8`
  );

  const dashboardCategories = db.all(
    `SELECT c.id, c.name, COUNT(p.id) AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id
     GROUP BY c.id
     ORDER BY c.sort_order ASC, c.id ASC`
  );

  // Recent Orders
  const recentOrders = db.all(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.badge_class, 'sb-1') AS badge_class
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     ORDER BY o.id DESC LIMIT 8`
  );

  // Finance Summary
  const credits = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM fund_transactions WHERE type = 'credit'").s;
  const debits = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM fund_transactions WHERE type = 'debit'").s;
  const fundBalance = credits - debits + deliveredRow.rev;
  const totalExpenses = db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses').s;
  const todayExpenses = db.get(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE expense_date = ?',
    todayStr
  ).s;
  const currentMonthPrefix = todayStr.slice(0, 7);
  const monthlyExpenses = db.get(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE substr(expense_date, 1, 7) = ?',
    currentMonthPrefix
  ).s;

  const formattedDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });


  return res.render('admin/dashboard', {
    formattedDate, totalOrders, pendingOrders, totalRevenue: deliveredRow.rev,
    deliveredCount: deliveredRow.c, lowStockCount, todayOrders: todayOrdersRow.c,
    todayRevenue: todayOrdersRow.rev, todayDeliveredRev, trafficSources, trendLabels,
    trendData, statusBreakdown, totalProducts, dashboardProducts, dashboardCategories,
    recentOrders, fundBalance, totalExpenses, todayExpenses, monthlyExpenses,
  });
}));

// External provider widgets stay unavailable until verified provider adapters exist.
router.get('/admin/smsgeteway/balance', (_req, res) => res.status(503).json({
  success: false, balance: null, gateway: 'BulkSMSBD', status: 'unavailable',
  message: 'Provider balance is unavailable; no verified live provider integration is configured.',
}));
router.get('/admin/bdcourier/my-plan', (_req, res) => res.status(503).json({
  success: false, data: null, status: 'unavailable',
  message: 'Courier account data is unavailable; no verified live provider integration is configured.',
}));
router.get('/admin/steadfast/dashboard-widget', (_req, res) => res.status(503).json({
  success: false, balance_display: null, in_review_count: null, status: 'unavailable',
  message: 'Courier provider metrics are unavailable; no verified live provider integration is configured.',
}));

// Real-time New Order Polling (Toast + Chime)
router.get('/admin/orders/poll-new', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    const raw = Number.parseInt(req.query.after_id || '0', 10);
    const result = await dashboardRepository.getPollNewOrders(Number.isSafeInteger(raw) && raw > 0 ? raw : 0);
    if (req.query.init) return res.json({ init: true, latest_id: result.latestId, orders: [] });
    return res.json({ latest_id: result.latestId, orders: result.orders });
  }
  const latestRow = db.get('SELECT COALESCE(MAX(id), 0) AS max_id FROM orders');
  const latestId = latestRow ? latestRow.max_id : 0;

  if (req.query.init) {
    return res.json({ init: true, latest_id: latestId, orders: [] });
  }

  const afterId = parseInt(req.query.after_id || '0', 10) || 0;
  if (afterId <= 0) {
    return res.json({ latest_id: latestId, orders: [] });
  }

  const newOrders = db.all(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_name
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.id > ?
     ORDER BY o.id ASC LIMIT 5`,
    afterId
  );

  const enriched = newOrders.map((o) => {
    const items = db.all(
      'SELECT product_name AS name, product_image AS image FROM order_items WHERE order_id = ?',
      o.id
    );
    return {
      id: o.id,
      invoice_id: o.invoice_id,
      customer_name: o.customer_name,
      phone: o.phone,
      amount: o.amount,
      status_name: o.status_name,
      created_at: o.created_at,
      products: items.slice(0, 4),
      more_count: Math.max(0, items.length - 4),
      process_url: `/admin/order/view/${o.id}`,
    };
  });

  return res.json({ latest_id: latestId, orders: enriched });
}));

// New Orders Modal Popup
router.get('/admin/dashboard/new-orders-popup', asyncHandler(async (_req, res) => {
  if (env.db.client === 'mysql') {
    const result = await dashboardRepository.getUnseenOrders();
    return res.json({ show: result.orders.length > 0, latest_id: result.latestId, orders: result.orders });
  }
  const latestId = db.get('SELECT COALESCE(MAX(id), 0) AS m FROM orders').m;
  const unseen = db.all(
    `SELECT o.*, COALESCE(os.name, 'Pending') AS status_name
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.is_seen = 0
     ORDER BY o.id DESC LIMIT 10`
  );
  res.json({
    show: unseen.length > 0,
    latest_id: latestId,
    orders: unseen.map((o) => ({
      id: o.id,
      invoice_id: o.invoice_id,
      customer_name: o.customer_name,
      phone: o.phone,
      amount: o.amount,
      status_name: o.status_name,
      created_at: o.created_at,
      process_url: `/admin/order/view/${o.id}`,
    })),
  });
}));

router.post('/admin/dashboard/dismiss-new-orders-popup', requireCsrf, asyncHandler(async (_req, res) => {
  if (env.db.client === 'mysql') await dashboardRepository.dismissUnseenOrders();
  else db.run('UPDATE orders SET is_seen = 1 WHERE is_seen = 0');
  return res.json({ success: true });
}));

// Gemini AI Assistant (Full Page + Slide-over Widget API)
async function buildSmartAdminReply(message) {
  const q = String(message || '').toLowerCase();
  if (env.db.client === 'mysql') {
    const data = await dashboardRepository.getAssistantSnapshot();
    const lowTxt = data.lowStock.length
      ? data.lowStock.map((p) => `${p.name} (${p.stock} pcs)`).join(', ')
      : 'No low-stock products are currently recorded.';
    if (q.includes('আজ') || q.includes('today') || q.includes('অর্ডার') || q.includes('order')) {
      return `📊 বর্তমান অর্ডার রিপোর্ট:\n• আজকের অর্ডার: ${data.todayOrders} টি\n• পেন্ডিং অর্ডার: ${data.pendingOrders} টি\n• সর্বমোট অর্ডার: ${data.totalOrders} টি\n• ডেলিভার্ড রেভিনিউ: ৳${data.totalRevenue.toLocaleString('en-IN')}`;
    }
    if (q.includes('প্রোডাক্ট') || q.includes('product') || q.includes('stock') || q.includes('স্টক')) {
      return `📦 প্রোডাক্ট ও স্টক আপডেট:\n• মোট প্রোডাক্ট: ${data.totalProducts} টি\n• লো-স্টক: ${lowTxt}`;
    }
    if (q.includes('হিসাব') || q.includes('রেভিনিউ') || q.includes('fund') || q.includes('expense') || q.includes('লাভ')) {
      return `💰 ফান্ড ও ফাইন্যান্স সামারি:\n• বর্তমান ফান্ড ব্যালেন্স: ৳${data.fundBalance.toLocaleString('en-IN')}\n• মোট খরচ: ৳${data.totalExpenses.toLocaleString('en-IN')}\n• ডেলিভার্ড সেলস: ৳${data.totalRevenue.toLocaleString('en-IN')}`;
    }
    return `🤖 অ্যাডমিন রিপোর্টে ${data.totalProducts} টি পণ্য ও ${data.totalOrders} টি অর্ডার রয়েছে। অর্ডার, স্টক বা খরচ সম্পর্কে জিজ্ঞাসা করুন।`;
  }
  const totalOrders = db.get('SELECT COUNT(*) AS c FROM orders').c;
  const pendingOrders = db.get("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'").c;
  const completedRev = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM orders WHERE status = 'completed'").s;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOrders = db.get('SELECT COUNT(*) AS c FROM orders WHERE substr(created_at, 1, 10) = ?', todayStr).c;
  const totalProducts = db.get('SELECT COUNT(*) AS c FROM products').c;
  const lowStock = db.all('SELECT name, stock FROM products WHERE stock < 20 ORDER BY stock ASC LIMIT 5');

  if (q.includes('আজ') || q.includes('today') || q.includes('অর্ডার') || q.includes('order')) {
    return (
      `📊 বর্তমান অর্ডার রিপোর্ট:\n` +
      `• আজকের নতুন অর্ডার: ${todayOrders} টি\n` +
      `• মোট পেন্ডিং অর্ডার: ${pendingOrders} টি (প্রসেসিংয়ের অপেক্ষায়)\n` +
      `• সর্বমোট অর্ডার: ${totalOrders} টি\n` +
      `• ডেলিভার্ড রেভিনিউ: ৳${completedRev.toLocaleString('en-IN')}\n\n` +
      `টিপস: বাম পাশের "Orders → Pending" মেনু থেকে এক ক্লিকে Steadfast বা Pathao কুরিয়ারে পাঠাতে পারবেন।`
    );
  }
  if (q.includes('approve') || q.includes('প্রোডাক্ট') || q.includes('product') || q.includes('stock') || q.includes('স্টক')) {
    const lowTxt = lowStock.length
      ? lowStock.map((p) => `${p.name} (${p.stock} পিস)`).join(', ')
      : 'কোনো প্রোডাক্টে লো-স্টক নেই (সবগুলোতে পর্যাপ্ত স্টক আছে)।';
    return (
      `📦 প্রোডাক্ট ও স্টক আপডেট:\n` +
      `• মোট প্রোডাক্ট: ${totalProducts} টি\n` +
      `• লো-স্টক স্ট্যাটাস: ${lowTxt}\n\n` +
      `Pending Product Approve করতে বাম মেনু থেকে "Products → Pending Products" পেজে গিয়ে Approve বাটনে ক্লিক করুন, অথবা নতুন পণ্য যোগ করতে "Add Product" ব্যবহার করুন।`
    );
  }
  if (q.includes('fraud') || q.includes('ফ্রড') || q.includes('চেক')) {
    return (
      `🛡️ ফ্রড চেক করার নিয়ম:\n` +
      `১. বাম পাশের মেনু থেকে "Manual Fraud Check" পেজে যান।\n` +
      `২. কাস্টমারের ১১ সংখ্যার মোবাইল নম্বর (যেমন 017...) লিখে "Check Courier Ratio" বাটনে ক্লিক করুন।\n` +
      `৩. সাথে সাথে Steadfast, Pathao ও RedX কুরিয়ারের মোট ডেলিভারি বনাম রিটার্ন রেশিও দেখতে পাবেন!`
    );
  }
  if (q.includes('হিসাব') || q.includes('রেভিনিউ') || q.includes('fund') || q.includes('expense') || q.includes('লাভ')) {
    const exp = db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses').s;
    const credits = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM fund_transactions WHERE type = 'credit'").s;
    const debits = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM fund_transactions WHERE type = 'debit'").s;
    return (
      `💰 ফান্ড ও ফাইন্যান্স সামারি:\n` +
      `• বর্তমান ফান্ড ব্যালেন্স: ৳${(credits - debits + completedRev).toLocaleString('en-IN')}\n` +
      `• মোট খরচ (Expenses): ৳${exp.toLocaleString('en-IN')}\n` +
      `• ডেলিভার্ড সেলস: ৳${completedRev.toLocaleString('en-IN')}\n\n` +
      `বিস্তারিত দেখতে "Reports → Profit & Loss" পেজটি ভিজিট করুন।`
    );
  }

  return (
    `🤖 মি. তুমি গ্রোসারি অ্যান্ড গিফট অ্যাডমিন অ্যাসিস্ট্যান্টে স্বাগতম!\n\n` +
    `বর্তমানে আপনার স্টোরে ${totalProducts} টি প্রোডাক্ট এবং ${totalOrders} টি অর্ডার (${pendingOrders} টি Pending) রয়েছে।\n` +
    `আপনি আমাকে জিজ্ঞাসা করতে পারেন:\n` +
    `• "আজ কতটি অর্ডার হয়েছে?"\n` +
    `• "স্টক ও প্রোডাক্ট রিপোর্ট দাও"\n` +
    `• "Fraud check কিভাবে করব?"\n` +
    `• "ফান্ড ও খরচের হিসাব দেখাও"`
  );
}

router.get('/admin/gemini-chat', (req, res) => {
  const chatHistory = req.session.geminiHistory || [];
  res.render('admin/gemini-chat', { chatHistory });
});

router.post('/admin/gemini-chat/send', asyncHandler(async (req, res) => {
  const msg = String(req.body.message || '').trim();
  if (!msg) {
    return res.status(400).json({ success: false, message: 'বার্তা খালি রাখা যাবে না।' });
  }
  const reply = await buildSmartAdminReply(msg);
  if (!Array.isArray(req.session.geminiHistory)) {
    req.session.geminiHistory = [];
  }
  req.session.geminiHistory.push({ role: 'user', text: msg });
  req.session.geminiHistory.push({ role: 'bot', text: reply });
  return res.json({ success: true, reply });
}));

router.post('/admin/gemini-chat/clear', (req, res) => {
  req.session.geminiHistory = [];
  res.json({ success: true });
});

router.post('/admin/gemini-chat/refresh-context', (_req, res) => {
  res.json({ success: true, message: 'ডাটাবেস কনটেক্সট রিফ্রেশ হয়েছে।' });
});

module.exports = router;
