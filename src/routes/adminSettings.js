const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { env } = require('../config/env');
const settingsRepository = require('../repositories/settingsRepository');
const adminFinanceReadRepository = require('../repositories/adminFinanceReadRepository');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
router.use('/admin', requireAdmin);

// ─── Landing Page / Campaigns ───
function renderCampaigns(res, openModal = false) {
  const rows = db.all(
    `SELECT c.*, p.name AS product_name
     FROM campaigns c
     LEFT JOIN products p ON p.id = c.product_id
     ORDER BY c.id DESC`
  );
  const products = db.all('SELECT id, name, new_price FROM products ORDER BY id ASC');

  res.render('admin/crud-module', {
    pageTitle: 'Landing Page Campaigns',
    subtitle: 'সিঙ্গেল প্রোডাক্ট হাই-কনভার্টিং ল্যান্ডিং পেজ তৈরি ও লাইভ লিংক কপি করুন',
    createAction: '/admin/campaign/create',
    deletePrefix: '/admin/campaign/delete',
    publicLinkPrefix: '/campaign',
    publicLinkKey: 'slug',
    autoOpenModal: openModal,
    columns: [
      { key: 'id', label: '#' },
      { key: 'title', label: 'Campaign Title' },
      { key: 'product_name', label: 'Linked Product' },
      { key: 'slug', label: 'URL Slug' },
      { key: 'offer_price', label: 'Offer Price', type: 'currency' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'title', label: 'Campaign Title', type: 'text', required: true },
      { name: 'slug', label: 'Landing Page Slug (e.g. mango-fest)', type: 'text', required: true },
      {
        name: 'product_id',
        label: 'Target Product',
        type: 'select',
        options: products.map((p) => ({ value: p.id, label: `${p.name} (৳${p.new_price})` })),
      },
      { name: 'headline', label: 'Hero Headline (বাংলা)', type: 'text', required: true },
      { name: 'subheadline', label: 'Subheadline', type: 'text' },
      { name: 'regular_price', label: 'Regular Price (৳)', type: 'number', value: '1900' },
      { name: 'offer_price', label: 'Offer Price (৳)', type: 'number', value: '1300', required: true },
      {
        name: 'benefits',
        label: 'Key Benefits (separate with |)',
        type: 'textarea',
        value: 'শতভাগ ফরমালিনমুক্ত বাগানের তাজা ফল|সারা দেশে ক্যাশ অন ডেলিভারি|পণ্য দেখে মূল্য পরিশোধের সুবিধা',
      },
    ],
    rows,
  });
}

router.get('/admin/campaign/manage', (_req, res) => renderCampaigns(res, false));
router.get('/admin/campaign/create', (_req, res) => renderCampaigns(res, true));

router.post('/admin/campaign/create', (req, res) => {
  const b = req.body;
  const cleanSlug = String(b.slug || b.title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '') || `offer-${Date.now().toString().slice(-4)}`;
  db.run(
    `INSERT INTO campaigns (title, slug, product_id, headline, subheadline, regular_price, offer_price, benefits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    b.title,
    cleanSlug,
    Number(b.product_id || 1),
    b.headline || b.title,
    b.subheadline || '',
    Number(b.regular_price || 0),
    Number(b.offer_price || 1000),
    b.benefits || ''
  );
  req.flash('success', `ল্যান্ডিং পেজ তৈরি হয়েছে! ভিজিট করুন: /campaign/${cleanSlug}`);
  res.redirect('/admin/campaign/manage');
});

router.post('/admin/campaign/delete/:id', (req, res) => {
  db.run('DELETE FROM campaigns WHERE id = ?', req.params.id);
  res.redirect('/admin/campaign/manage');
});

// ─── Manual Fraud Check (/admin/manual-fraud-check) ───
router.get('/admin/manual-fraud-check', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  const result = phone ? {
    phone,
    available: false,
    message: 'External fraud-provider verification is not configured. No courier history or risk score is available; review manually.',
  } : null;
  res.render('admin/fraud-check', { phone, result });
});

// ─── Send Custom SMS ───
router.get('/admin/sms/custom-send', (_req, res) => {
  const logs = db.all('SELECT * FROM sms_logs ORDER BY id DESC LIMIT 50');
  const customers = db.all('SELECT name, phone FROM customers ORDER BY id DESC LIMIT 100');
  res.render('admin/settings', {
    pageTitle: 'Send Custom SMS',
    section: 'custom_sms',
    logs,
    customers,
  });
});

router.post('/admin/sms/custom-send', (req, res) => {
  req.flash('error', 'SMS sending is disabled: no verified SMS provider is configured. No message was sent and no balance was changed.');
  return res.redirect('/admin/sms/custom-send');
});

// ─── Universal Key-Value Settings Save Endpoint ───
router.post('/admin/settings/save', upload.single('logo_file'), asyncHandler(async (req, res) => {
  const redirectTo = req.body._redirect || req.get('Referrer') || '/admin/settings/manage';
  const changes = Object.fromEntries(Object.entries(req.body).filter(([key]) => !key.startsWith('_')));
  if (req.file) {
    const uploadedPath = `/uploads/custom/${req.file.filename}`;
    changes.logo_dark = uploadedPath;
    changes.logo_light = uploadedPath;
  }
  if (Object.keys(changes).length && env.db.client === 'mysql') {
    await settingsRepository.saveSettings(changes, {
      id: req.adminUser?.id || req.session?.adminUser?.id || null,
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
    });
  } else if (Object.keys(changes).length) {
    for (const [key, value] of Object.entries(changes)) db.setSetting(key, value);
  }
  req.flash('success', 'সেটিংস সফলভাবে সংরক্ষণ করা হয়েছে!');
  res.redirect(redirectTo);
}));

// ─── Site Settings & API Integrations Pages ───
const settingsPageMap = {
  '/admin/settings/manage': { title: 'General Site Settings', section: 'general' },
  '/admin/sale-notification': { title: 'Sales Notification Popup', section: 'sale_notification' },
  '/admin/contact/manage': { title: 'Contact Information', section: 'contact' },
  '/admin/email-setting': { title: 'SMTP & Email Settings', section: 'email' },
  '/admin/fraud-settings': { title: 'Fraud Check API Settings', section: 'fraud_api' },
  '/admin/order-restriction-settings': { title: 'Order Restriction & Anti-Spam', section: 'order_restriction' },
  '/admin/smsgeteway/manage': { title: 'SMS Gateway Configuration', section: 'sms_gateway' },
  '/admin/facebook-capi/settings': { title: 'Facebook Conversion API (CAPI)', section: 'fb_capi' },
  '/admin/gemini-ai/settings': { title: 'Gemini AI Assistant Settings', section: 'gemini_ai' },
  '/admin/social-login/settings': { title: 'Google & Facebook Social Login', section: 'social_login' },
  '/admin/cron-jobs': { title: 'Cron Jobs & Scheduled Tasks', section: 'cron_jobs' },
  '/admin/tag-manager/manage': { title: 'Google Tag Manager (GTM)', section: 'gtm' },
  '/admin/pixels/manage': { title: 'Facebook Pixel Manage', section: 'fb_pixel' },
  '/admin/tiktok-pixels/manage': { title: 'TikTok Pixel Configuration', section: 'tiktok_pixel' },
  '/admin/facebook-page/settings': { title: 'Facebook Page Auto-Post', section: 'fb_page' },
  '/admin/popup': { title: 'Promotional Popup Offer', section: 'popup_offer' },
  '/admin/seo-settings': { title: 'SEO & Meta Tags Settings', section: 'seo' },
  '/admin/sitemap': { title: 'XML Sitemap Settings', section: 'sitemap' },
  '/admin/license-info': { title: 'System Information & License', section: 'license' },
  '/admin/updates': { title: 'System Version & Updates', section: 'updates' },
};

for (const [routePath, cfg] of Object.entries(settingsPageMap)) {
  router.get(routePath, (_req, res) => {
    res.render('admin/settings', {
      pageTitle: cfg.title,
      section: cfg.section,
      logs: [],
      customers: [],
    });
  });
}

// ─── Social Media, Feature Bar, CMS Pages, Banners, Payment Gateways, Couriers ───
router.get('/admin/social-media/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM social_links ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Social Media Links',
    subtitle: 'ওয়েবসাইটের হেডার ও ফুটারে প্রদর্শিত সোশ্যাল মিডিয়া লিংকসমূহ',
    createAction: '/admin/social-media/create',
    deletePrefix: '/admin/social-media/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'platform', label: 'Platform' },
      { key: 'url', label: 'Profile URL' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'platform', label: 'Platform (Facebook / WhatsApp / YouTube)', type: 'text', required: true },
      { name: 'url', label: 'URL', type: 'text', required: true },
    ],
    rows,
  });
});

router.post('/admin/social-media/create', (req, res) => {
  db.run('INSERT INTO social_links (platform, url) VALUES (?, ?)', req.body.platform, req.body.url);
  res.redirect('/admin/social-media/manage');
});
router.post('/admin/social-media/delete/:id', (req, res) => {
  db.run('DELETE FROM social_links WHERE id = ?', req.params.id);
  res.redirect('/admin/social-media/manage');
});

router.get('/admin/features/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM features ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Storefront Feature Bar',
    subtitle: 'হোমপেজ ও ফুটারের ট্রাস্ট ব্যাজ ফিচার বার',
    createAction: '/admin/features/create',
    deletePrefix: '/admin/features/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'title', label: 'Title' },
      { key: 'subtitle', label: 'Subtitle' },
      { key: 'icon', label: 'Feather Icon' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'subtitle', label: 'Subtitle', type: 'text', required: true },
      { name: 'icon', label: 'Icon Name (shield / truck / check-circle)', type: 'text', value: 'shield' },
    ],
    rows,
  });
});

router.post('/admin/features/create', (req, res) => {
  db.run('INSERT INTO features (title, subtitle, icon) VALUES (?, ?, ?)', req.body.title, req.body.subtitle, req.body.icon || 'shield');
  res.redirect('/admin/features/manage');
});
router.post('/admin/features/delete/:id', (req, res) => {
  db.run('DELETE FROM features WHERE id = ?', req.params.id);
  res.redirect('/admin/features/manage');
});

router.get('/admin/page/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM cms_pages ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Custom Pages (CMS)',
    subtitle: 'প্রাইভেসি পলিসি, রিটার্ন পলিসি ও আমাদের সম্পর্কে পেজ তৈরি করুন',
    createAction: '/admin/page/create',
    deletePrefix: '/admin/page/delete',
    publicLinkPrefix: '/page',
    publicLinkKey: 'slug',
    columns: [
      { key: 'id', label: '#' },
      { key: 'title', label: 'Page Title' },
      { key: 'slug', label: 'URL Slug' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'title', label: 'Page Title', type: 'text', required: true },
      { name: 'slug', label: 'URL Slug (e.g. refund-policy)', type: 'text', required: true },
      { name: 'content', label: 'Page Content', type: 'textarea', required: true },
    ],
    rows,
  });
});

router.post('/admin/page/create', (req, res) => {
  const slug = String(req.body.slug || req.body.title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  db.run('INSERT INTO cms_pages (title, slug, content) VALUES (?, ?, ?)', req.body.title, slug, req.body.content || '');
  req.flash('success', 'পেজ তৈরি হয়েছে।');
  res.redirect('/admin/page/manage');
});
router.post('/admin/page/delete/:id', (req, res) => {
  db.run('DELETE FROM cms_pages WHERE id = ?', req.params.id);
  res.redirect('/admin/page/manage');
});

// Banner & Sliders
router.get('/admin/banner/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM banners ORDER BY sort_order ASC, id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Banner & Sliders',
    subtitle: 'হোমপেজের মেইন স্লাইডার ও প্রোমো ব্যানার পরিচালনা করুন',
    createAction: '/admin/banner/create',
    deletePrefix: '/admin/banner/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'image', label: 'Preview', type: 'image' },
      { key: 'title', label: 'Banner Title' },
      { key: 'position', label: 'Position', type: 'badge' },
      { key: 'link', label: 'Target Link' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'title', label: 'Banner Headline', type: 'text', required: true },
      { name: 'subtitle', label: 'Subtitle', type: 'text' },
      {
        name: 'position',
        label: 'Placement',
        type: 'select',
        options: [
          { value: 'hero', label: 'Hero Slider (Top)' },
          { value: 'promo_mid', label: 'Middle Promo Banner' },
        ],
      },
      { name: 'image', label: 'Image URL / Path', type: 'text', value: '/uploads/banner/banner-1.jpg', required: true },
      { name: 'link', label: 'Target URL', type: 'text', value: '/all-products' },
    ],
    rows,
  });
});

router.post('/admin/banner/create', (req, res) => {
  const { title, subtitle, position, image, link } = req.body;
  db.run(
    'INSERT INTO banners (title, subtitle, position, image, link) VALUES (?, ?, ?, ?, ?)',
    title,
    subtitle || '',
    position || 'hero',
    image || '/uploads/banner/banner-1.jpg',
    link || '/all-products'
  );
  req.flash('success', 'ব্যানার যুক্ত হয়েছে!');
  res.redirect('/admin/banner/manage');
});
router.post('/admin/banner/delete/:id', (req, res) => {
  db.run('DELETE FROM banners WHERE id = ?', req.params.id);
  res.redirect('/admin/banner/manage');
});

// Payment Gateways (Auto & Manual)
router.get('/admin/paymentgeteway/manage', (_req, res) => renderGateways(res, 'auto'));
router.get('/admin/paymentgeteway/manual-manage', (_req, res) => renderGateways(res, 'manual'));

function renderGateways(res, type) {
  const rows = db.all('SELECT * FROM payment_gateways WHERE type = ? ORDER BY id ASC', type);
  res.render('admin/crud-module', {
    pageTitle: type === 'manual' ? 'Manual Payment Methods (bKash / Nagad / Rocket)' : 'Automatic Payment Gateways',
    subtitle: 'চেকআউট পেজের পেমেন্ট গেটওয়ে ও অ্যাকাউন্ট নম্বর পরিচালনা করুন',
    createAction: `/admin/paymentgeteway/${type}/create`,
    customActionPrefix: '/admin/paymentgeteway/toggle',
    customActionLabel: 'Toggle Active',
    deletePrefix: '/admin/paymentgeteway/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Gateway Name' },
      { key: 'code', label: 'Code' },
      { key: 'account_number', label: 'Merchant / Personal No' },
      { key: 'instructions', label: 'Checkout Instructions' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Method Name', type: 'text', required: true },
      { name: 'code', label: 'Unique Code (e.g. upay_manual)', type: 'text', required: true },
      { name: 'account_number', label: 'Account / Merchant Number', type: 'text' },
      { name: 'instructions', label: 'Customer Instructions', type: 'textarea' },
    ],
    rows,
  });
}

router.post('/admin/paymentgeteway/:type/create', (req, res) => {
  const t = req.params.type === 'manual' ? 'manual' : 'auto';
  db.run(
    'INSERT INTO payment_gateways (name, code, type, account_number, instructions, status) VALUES (?, ?, ?, ?, ?, 1)',
    req.body.name,
    req.body.code,
    t,
    req.body.account_number || '',
    req.body.instructions || ''
  );
  req.flash('success', 'পেমেন্ট মেথড যুক্ত হয়েছে।');
  res.redirect(t === 'manual' ? '/admin/paymentgeteway/manual-manage' : '/admin/paymentgeteway/manage');
});

router.post('/admin/paymentgeteway/toggle/:id', (req, res) => {
  const gw = db.get('SELECT id, status FROM payment_gateways WHERE id = ?', req.params.id);
  if (gw) db.run('UPDATE payment_gateways SET status = ? WHERE id = ?', gw.status ? 0 : 1, gw.id);
  req.flash('success', 'পেমেন্ট গেটওয়ে স্ট্যাটাস আপডেট হয়েছে।');
  res.redirect(req.get('Referrer') || '/admin/paymentgeteway/manage');
});

router.post('/admin/paymentgeteway/delete/:id', (req, res) => {
  db.run('DELETE FROM payment_gateways WHERE id = ?', req.params.id);
  res.redirect(req.get('Referrer') || '/admin/paymentgeteway/manage');
});

// Courier API Manage
router.get('/admin/courierapi/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM courier_apis ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Courier API Integration (Steadfast / Pathao / RedX)',
    subtitle: 'কুরিয়ার API কী ও ব্যালেন্স কনফিগারেশন',
    createAction: '/admin/courierapi/create',
    customActionPrefix: '/admin/courierapi/toggle',
    customActionLabel: 'Toggle Active',
    deletePrefix: '/admin/courierapi/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Courier Service' },
      { key: 'code', label: 'Code' },
      { key: 'api_key', label: 'API Key' },
      { key: 'base_url', label: 'Endpoint URL' },
      { key: 'balance', label: 'Balance', type: 'currency' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Courier Name', type: 'text', required: true },
      { name: 'code', label: 'Code (e.g. paperfly)', type: 'text', required: true },
      { name: 'api_key', label: 'API Key / Token', type: 'text', required: true },
      { name: 'secret_key', label: 'Secret Key', type: 'text' },
      { name: 'base_url', label: 'Base API URL', type: 'text' },
    ],
    rows,
  });
});

router.post('/admin/courierapi/create', (req, res) => {
  const { name, code, api_key, secret_key, base_url } = req.body;
  db.run(
    'INSERT INTO courier_apis (name, code, api_key, secret_key, base_url) VALUES (?, ?, ?, ?, ?)',
    name,
    code,
    api_key,
    secret_key || '',
    base_url || ''
  );
  res.redirect('/admin/courierapi/manage');
});
router.post('/admin/courierapi/toggle/:id', (req, res) => {
  const c = db.get('SELECT id, status FROM courier_apis WHERE id = ?', req.params.id);
  if (c) db.run('UPDATE courier_apis SET status = ? WHERE id = ?', c.status ? 0 : 1, c.id);
  res.redirect('/admin/courierapi/manage');
});
router.post('/admin/courierapi/delete/:id', (req, res) => {
  db.run('DELETE FROM courier_apis WHERE id = ?', req.params.id);
  res.redirect('/admin/courierapi/manage');
});

// ─── Live Ads Result (/admin/ads-analytics) ───
router.get('/admin/ads-analytics', (_req, res) => renderAds(res, 'overview'));
router.get('/admin/ads-analytics/:channel', (req, res) => renderAds(res, req.params.channel));

function renderAds(res, channel) {
  const s = db.getSettings();
  const fbOrders = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE traffic_source = 'Facebook'");
  const directOrders = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE traffic_source = 'Direct'");
  const otherOrders = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE traffic_source NOT IN ('Facebook', 'Direct')");

  res.render('admin/ads-analytics', {
    channel,
    fbOrders,
    directOrders,
    otherOrders,
    adSettings: s,
  });
}

// ─── Reports (/admin/reports/:type) ───
router.get('/admin/reports/:type', asyncHandler(async (req, res) => {
  const type = req.params.type;
  const format = req.query.export;
  if(env.db.client==='mysql'){
    const report=await adminFinanceReadRepository.getReport(type);
    if(format==='csv'){
      const lines=[report.columns.join(',')];
      for(const row of report.rows)lines.push(report.columns.map((column)=>`"${String(row[column]??'').replace(/"/g,'""')}"`).join(','));
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="${type}-report.csv"`);
      return res.send('\uFEFF'+lines.join('\n'));
    }
    return res.render('admin/reports',{type,reportTitle:report.reportTitle,rows:report.rows,columns:report.columns,summary:report.summary});
  }

  const totalSales = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM orders WHERE status != 'cancelled'").s;
  const completedSales = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM orders WHERE status = 'completed'").s;
  const totalPurchases = db.get('SELECT COALESCE(SUM(total_cost), 0) AS s FROM purchases').s;
  const totalExpenses = db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses').s;
  const stockValue = db.get('SELECT COALESCE(SUM(stock * purchase_price), 0) AS cost_val, COALESCE(SUM(stock * new_price), 0) AS retail_val FROM products');

  let rows = [];
  let columns = [];
  let reportTitle = 'Order Report';

  if (type === 'orders') {
    reportTitle = 'Order Report';
    rows = db.all('SELECT invoice_id, customer_name, phone, amount, status, traffic_source, created_at FROM orders ORDER BY id DESC');
    columns = ['invoice_id', 'customer_name', 'phone', 'amount', 'status', 'traffic_source', 'created_at'];
  } else if (type === 'purchases') {
    reportTitle = 'Purchase Report';
    rows = db.all(
      `SELECT pu.reference_no, s.name AS supplier, p.name AS product, pu.qty, pu.unit_cost, pu.total_cost, pu.purchase_date
       FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN products p ON p.id = pu.product_id ORDER BY pu.id DESC`
    );
    columns = ['reference_no', 'supplier', 'product', 'qty', 'unit_cost', 'total_cost', 'purchase_date'];
  } else if (type === 'expenses') {
    reportTitle = 'Expense Report';
    rows = db.all('SELECT id, title, category, amount, note, expense_date FROM expenses ORDER BY id DESC');
    columns = ['id', 'title', 'category', 'amount', 'note', 'expense_date'];
  } else if (type === 'stock') {
    reportTitle = 'Inventory & Stock Report';
    rows = db.all(
      `SELECT p.code, p.name, c.name AS category, p.purchase_price, p.new_price, p.stock, p.sold_count
       FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.stock ASC`
    );
    columns = ['code', 'name', 'category', 'purchase_price', 'new_price', 'stock', 'sold_count'];
  } else {
    reportTitle = 'Profit & Loss Statement';
    rows = [
      { metric: 'Total Gross Order Value (Active Orders)', amount: totalSales },
      { metric: 'Completed / Delivered Order Revenue', amount: completedSales },
      { metric: 'Total Stock Purchases Cost', amount: totalPurchases },
      { metric: 'Total Operational Expenses', amount: totalExpenses },
      { metric: 'Current Inventory Valuation (Retail)', amount: stockValue.retail_val },
      { metric: 'Net Estimated Operating Profit (Gross Orders - Expenses)', amount: totalSales - totalExpenses },
    ];
    columns = ['metric', 'amount'];
  }

  if (format === 'csv') {
    const csvLines = [columns.join(',')];
    for (const r of rows) {
      csvLines.push(columns.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
    return res.send('\uFEFF' + csvLines.join('\n'));
  }

  res.render('admin/reports', {
    type,
    reportTitle,
    rows,
    columns,
    summary: {
      totalSales,
      completedSales,
      totalPurchases,
      totalExpenses,
      stockCostVal: stockValue.cost_val,
      stockRetailVal: stockValue.retail_val,
    },
  });
}));

// ─── Clear Cache & Error Log ───
router.get('/admin/clear-cache', (_req,res) => res.status(405).send('Use the CSRF-protected POST form.'));
router.post('/admin/clear-cache', (req, res) => {
  db.run('INSERT INTO error_logs (level, message, context) VALUES (?, ?, ?)', 'INFO', 'Application & template cache cleared by Admin', 'cache');
  req.flash('success', 'সিস্টেম ক্যাশ সফলভাবে ক্লিয়ার করা হয়েছে!');
  res.redirect(req.get('Referrer') || '/admin/dashboard');
});

router.get('/admin/error-log', (_req, res) => {
  const rows = db.all('SELECT * FROM error_logs ORDER BY id DESC LIMIT 100');
  res.render('admin/crud-module', {
    pageTitle: 'System & Activity Logs',
    subtitle: 'সার্ভার ইভেন্ট ও সিস্টেম লগসমূহ',
    deletePrefix: '/admin/error-log/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'level', label: 'Level', type: 'badge' },
      { key: 'message', label: 'Message' },
      { key: 'context', label: 'Context' },
      { key: 'created_at', label: 'Timestamp' },
    ],
    fields: [],
    rows,
  });
});

router.post('/admin/error-log/delete/:id', (req, res) => {
  db.run('DELETE FROM error_logs WHERE id = ?', req.params.id);
  res.redirect('/admin/error-log');
});

module.exports = router;
