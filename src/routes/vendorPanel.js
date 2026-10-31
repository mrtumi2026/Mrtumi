const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireVendor } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const upload = require('../middleware/upload');
const { env } = require('../config/env');
const vendorPortal = require('../repositories/vendorPortalRepository');
const mysqlActive = () => env.db.client === 'mysql';

const router = express.Router();

function requireCsrfAndCleanupUploadedFile(req, res, next) {
  return requireCsrf(req, res, (error) => {
    if (error && req.file && req.file.path) upload.safeUnlink(req.file.path);
    return next(error);
  });
}

function makeSlug(str) {
  return (
    String(str || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '') +
    '-' +
    Math.floor(100 + Math.random() * 900)
  );
}

// ─── Public Vendor Auth Routes ───
router.get('/vendor', (req, res) => {
  return res.redirect(req.session && req.session.vendorUser ? '/vendor/dashboard' : '/vendor/login');
});

router.get('/vendor/login', (req, res) => {
  if (req.session && req.session.vendorUser) {
    return res.redirect('/vendor/dashboard');
  }
  res.render('vendor/auth', { mode: 'login', error: null });
});

router.post('/vendor/login', requireCsrf, (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
  const password = String(req.body.password || '');

  const vendor = db.get(
    'SELECT * FROM vendors WHERE email = ? OR phone = ? LIMIT 1',
    identifier,
    identifier
  );
  if (!vendor || !vendor.status) {
    return res.render('vendor/auth', {
      mode: 'login',
      error: 'ভেন্ডর ইমেইল/মোবাইল নম্বর খুঁজে পাওয়া যায়নি অথবা অ্যাকাউন্ট নিষ্ক্রিয়।',
    });
  }

  const valid = Boolean(vendor.password_hash) && bcrypt.compareSync(password, vendor.password_hash);

  if (!valid) {
    return res.render('vendor/auth', {
      mode: 'login',
      error: 'পাসওয়ার্ড সঠিক নয়। আবার চেষ্টা করুন।',
    });
  }

  req.session.vendorUser = {
    id: vendor.id,
    shop_name: vendor.shop_name,
    owner_name: vendor.owner_name,
    phone: vendor.phone,
    email: vendor.email,
  };
  req.flash('success', `স্বাগতম, ${vendor.shop_name}!`);
  res.redirect('/vendor/dashboard');
});

router.get('/vendor/register', (req, res) => {
  if (req.session && req.session.vendorUser) {
    return res.redirect('/vendor/dashboard');
  }
  res.render('vendor/auth', { mode: 'register', error: null });
});

router.post('/vendor/register', requireCsrf, (req, res) => {
  const { shop_name, owner_name, phone, email, address, password } = req.body;
  if (!shop_name || !owner_name || !phone || !password) {
    return res.render('vendor/auth', {
      mode: 'register',
      error: 'শপের নাম, মালিকের নাম, মোবাইল এবং পাসওয়ার্ড আবশ্যক।',
    });
  }

  const exists = db.get('SELECT id FROM vendors WHERE phone = ?', phone.trim());
  if (exists) {
    return res.render('vendor/auth', {
      mode: 'register',
      error: 'এই মোবাইল নম্বর দিয়ে ইতিমধ্যে একটি ভেন্ডর অ্যাকাউন্ট রয়েছে। লগইন করুন।',
    });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.run(
    `INSERT INTO vendors (shop_name, owner_name, phone, email, address, commission_rate, balance, password_hash, verified, status)
     VALUES (?, ?, ?, ?, ?, 10, 0, ?, 0, 1)`,
    shop_name.trim(),
    owner_name.trim(),
    phone.trim(),
    (email || '').trim(),
    (address || '').trim(),
    hash
  );

  const newVendor = db.get('SELECT * FROM vendors WHERE id = ?', result.lastInsertRowid);
  req.session.vendorUser = {
    id: newVendor.id,
    shop_name: newVendor.shop_name,
    owner_name: newVendor.owner_name,
    phone: newVendor.phone,
    email: newVendor.email,
  };
  req.flash('success', 'ভেন্ডর অ্যাকাউন্ট সফলভাবে তৈরি হয়েছে! অ্যাডমিন ভেরিফিকেশনের পর শপ ভেরিফায়েড ব্যাজ পাবে।');
  res.redirect('/vendor/dashboard');
});

router.post('/vendor/logout', requireCsrf, (req, res) => {
  delete req.session.vendorUser;
  res.redirect('/vendor/login');
});

// ─── Protected Vendor Portal Routes ───
router.use('/vendor', requireVendor);

router.get('/vendor/dashboard', (req, res) => {
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  const totalProducts = db.get('SELECT COUNT(*) AS c FROM products WHERE vendor_id = ?', vendor.id).c;
  const approvedProducts = db.get(
    "SELECT COUNT(*) AS c FROM products WHERE vendor_id = ? AND approval_status = 'approved'",
    vendor.id
  ).c;
  const pendingProducts = db.get(
    "SELECT COUNT(*) AS c FROM products WHERE vendor_id = ? AND approval_status = 'pending'",
    vendor.id
  ).c;

  const orderLines = db.all(
    `SELECT oi.*, o.invoice_id, o.customer_name, o.phone, o.status AS order_status, o.created_at
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     JOIN orders o ON o.id = oi.order_id
     WHERE p.vendor_id = ?
     ORDER BY o.id DESC`,
    vendor.id
  );

  const grossSales = orderLines
    .filter((l) => l.order_status !== 'cancelled')
    .reduce((s, l) => s + Number(l.price) * Number(l.qty), 0);
  const netEstimated = Math.round(grossSales * (1 - Number(vendor.commission_rate || 10) / 100));

  const pendingWithdrawals = db.get(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM vendor_withdrawals WHERE vendor_id = ? AND status = 'pending'",
    vendor.id
  ).s;

  const myProducts = db.all(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.vendor_id = ?
     ORDER BY p.id DESC LIMIT 6`,
    vendor.id
  );

  res.render('vendor/dashboard', {
    vendor,
    totalProducts,
    approvedProducts,
    pendingProducts,
    totalOrders: orderLines.length,
    grossSales,
    netEstimated,
    pendingWithdrawals,
    recentOrderLines: orderLines.slice(0, 8),
    myProducts,
  });
});

// ─── Vendor Products Management ───
router.get('/vendor/products', async (req, res, next) => {
  const vendorId = req.session.vendorUser.id;
  if (mysqlActive()) { try { return res.render('vendor/products', { products: await vendorPortal.listProducts(vendorId) }); } catch (error) { return next(error); } }
  const products = db.all(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.vendor_id = ?
     ORDER BY p.id DESC`,
    vendorId
  );
  res.render('vendor/products', { products });
});

router.get('/vendor/products/create', async (_req, res, next) => {
  if (mysqlActive()) { try { const sql = require('../db/mysqlPool'); const [categories, brands] = await Promise.all([sql.queryAll('SELECT id,name_bn AS name,status FROM categories WHERE status=1 ORDER BY sort_order,id'), sql.queryAll('SELECT id,name_bn AS name,status FROM brands WHERE status=1 ORDER BY id')]); return res.render('vendor/product-form', { product: null, categories, brands }); } catch (error) { return next(error); } }
  const categories = db.all('SELECT * FROM categories WHERE status = 1 ORDER BY sort_order ASC');
  const brands = db.all('SELECT * FROM brands WHERE status = 1');
  res.render('vendor/product-form', { product: null, categories, brands });
});

router.post('/vendor/products/create', upload.single('image'), requireCsrfAndCleanupUploadedFile, async (req, res, next) => {
  if (mysqlActive()) { try { await vendorPortal.saveProduct(req.session.vendorUser.id, { ...req.body, image_url: req.file ? `/uploads/custom/${req.file.filename}` : req.body.image_url }); req.flash('success', 'Product submitted for review.'); return res.redirect('/vendor/products'); } catch (error) { return next(error); } }
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  const b = req.body;
  const imgPath = req.file ? `/uploads/custom/${req.file.filename}` : '/uploads/product/lychee-fresh.jpg';
  const code = `VP${Math.floor(1000 + Math.random() * 9000)}`;
  const approval = vendor && vendor.verified ? 'approved' : 'pending';

  db.run(
    `INSERT INTO products
    (name, slug, code, category_id, brand_id, vendor_id, old_price, new_price, purchase_price, wholesale_price, wholesale_min_qty,
     stock, sizes, colors, image, short_desc, description, approval_status, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    b.name.trim(),
    makeSlug(b.name),
    code,
    Number(b.category_id || 1),
    Number(b.brand_id || 1),
    vendor.id,
    Number(b.old_price || 0),
    Number(b.new_price || 0),
    Number(b.purchase_price || 0),
    Number(b.wholesale_price || 0),
    Number(b.wholesale_min_qty || 0),
    Number(b.stock || 50),
    b.sizes || '১ কেজি',
    b.colors || '',
    imgPath,
    b.short_desc || '',
    b.description || '',
    approval
  );

  req.flash(
    'success',
    approval === 'approved'
      ? 'প্রোডাক্ট সফলভাবে যোগ হয়েছে এবং স্টোরফ্রন্টে লাইভ হয়েছে!'
      : 'প্রোডাক্ট জমা হয়েছে! অ্যাডমিন অনুমোদনের পর স্টোরফ্রন্টে প্রদর্শিত হবে।'
  );
  res.redirect('/vendor/products');
});

router.get('/vendor/products/edit/:id', async (req, res, next) => {
  if (mysqlActive()) { try { const sql = require('../db/mysqlPool'); const product = (await vendorPortal.listProducts(req.session.vendorUser.id)).find(row => Number(row.id) === Number(req.params.id)); if (!product) return res.redirect('/vendor/products'); const [categories, brands] = await Promise.all([sql.queryAll('SELECT id,name_bn AS name,status FROM categories WHERE status=1 ORDER BY sort_order,id'), sql.queryAll('SELECT id,name_bn AS name,status FROM brands WHERE status=1 ORDER BY id')]); return res.render('vendor/product-form', { product, categories, brands }); } catch (error) { return next(error); } }
  const product = db.get(
    'SELECT * FROM products WHERE id = ? AND vendor_id = ?',
    req.params.id,
    req.session.vendorUser.id
  );
  if (!product) return res.redirect('/vendor/products');
  const categories = db.all('SELECT * FROM categories WHERE status = 1 ORDER BY sort_order ASC');
  const brands = db.all('SELECT * FROM brands WHERE status = 1');
  res.render('vendor/product-form', { product, categories, brands });
});

router.post('/vendor/products/edit/:id', upload.single('image'), requireCsrfAndCleanupUploadedFile, async (req, res, next) => {
  if (mysqlActive()) { try { await vendorPortal.saveProduct(req.session.vendorUser.id, { ...req.body, image_url: req.file ? `/uploads/custom/${req.file.filename}` : req.body.image_url }, { id: req.params.id }); req.flash('success', 'Product updated.'); return res.redirect('/vendor/products'); } catch (error) { return next(error); } }
  const existing = db.get(
    'SELECT * FROM products WHERE id = ? AND vendor_id = ?',
    req.params.id,
    req.session.vendorUser.id
  );
  if (!existing) return res.redirect('/vendor/products');

  const b = req.body;
  const imgPath = req.file ? `/uploads/custom/${req.file.filename}` : existing.image;

  db.run(
    `UPDATE products
     SET name = ?, category_id = ?, brand_id = ?, old_price = ?, new_price = ?, wholesale_price = ?, wholesale_min_qty = ?,
         stock = ?, sizes = ?, colors = ?, image = ?, short_desc = ?, description = ?, status = ?
     WHERE id = ? AND vendor_id = ?`,
    b.name.trim(),
    Number(b.category_id || existing.category_id),
    Number(b.brand_id || existing.brand_id),
    Number(b.old_price || 0),
    Number(b.new_price || existing.new_price),
    Number(b.wholesale_price || 0),
    Number(b.wholesale_min_qty || 0),
    Number(b.stock || 0),
    b.sizes || existing.sizes,
    b.colors || '',
    imgPath,
    b.short_desc || '',
    b.description || '',
    b.status === '0' ? 0 : 1,
    existing.id,
    req.session.vendorUser.id
  );

  req.flash('success', 'প্রোডাক্ট তথ্য আপডেট করা হয়েছে!');
  res.redirect('/vendor/products');
});

router.post('/vendor/products/:id/inventory', requireCsrf, async (req, res, next) => {
  if (mysqlActive()) { try { await vendorPortal.adjustInventory(req.session.vendorUser.id, req.params.id, req.body.quantity, req.body.reason); req.flash('success', 'Inventory adjusted and recorded.'); return res.redirect('/vendor/products'); } catch (error) { return next(error); } }
  req.flash('error', 'Inventory ledger operation is unavailable in legacy mode.'); return res.redirect('/vendor/products');
});

router.post('/vendor/products/:id/status', requireCsrf, async (req, res, next) => {
  if (mysqlActive()) { try { await vendorPortal.setProductStatus(req.session.vendorUser.id, req.params.id, req.body.status); req.flash('success', 'Product status updated.'); return res.redirect('/vendor/products'); } catch (error) { return next(error); } }
  if (req.body.status === '0') db.run('UPDATE products SET status=0 WHERE id=? AND vendor_id=?', req.params.id, req.session.vendorUser.id); else db.run('UPDATE products SET status=1 WHERE id=? AND vendor_id=?', req.params.id, req.session.vendorUser.id);
  return res.redirect('/vendor/products');
});

router.post('/vendor/products/delete/:id', requireCsrf, async (req, res, next) => {
  if (mysqlActive()) { try { await vendorPortal.setProductStatus(req.session.vendorUser.id, req.params.id, 0); req.flash('success', 'Product deactivated.'); return res.redirect('/vendor/products'); } catch (error) { return next(error); } }
  db.run('DELETE FROM products WHERE id = ? AND vendor_id = ?', req.params.id, req.session.vendorUser.id);
  req.flash('success', 'প্রোডাক্ট মুছে ফেলা হয়েছে।');
  res.redirect('/vendor/products');
});

// ─── Vendor Orders ───
router.get('/vendor/orders', async (req, res, next) => {
  if (mysqlActive()) { try { const vendor = await require('../db/mysqlPool').queryOne('SELECT id,shop_name,owner_name,commission_rate_bps/100 AS commission_rate FROM vendors WHERE id=? AND status=1', [req.session.vendorUser.id]); if (!vendor) return res.redirect('/vendor/login'); return res.render('vendor/orders', { vendor, orderLines: await vendorPortal.listOrderItems(vendor.id) }); } catch (error) { return next(error); } }
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  const orderLines = db.all(
    `SELECT oi.*, o.id AS order_id, o.invoice_id, o.customer_name, o.phone, o.address,
            o.status AS order_status, o.courier_name, o.courier_tracking_id, o.created_at
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     JOIN orders o ON o.id = oi.order_id
     WHERE p.vendor_id = ?
     ORDER BY o.id DESC`,
    vendor.id
  );
  res.render('vendor/orders', { vendor, orderLines });
});

router.get('/vendor/order-items/:itemId', async (req, res, next) => {
  if (!mysqlActive()) return res.status(404).send('Not found');
  try { return res.json({ item: await vendorPortal.getOrderItem(req.session.vendorUser.id, req.params.itemId) }); } catch (error) { return next(error); }
});

// Explicitly scoped item fulfillment; parent-order status is derived in the repository from all lines.
router.post('/vendor/order-items/:itemId/fulfillment', requireCsrf, async (req, res, next) => {
  if (!mysqlActive()) { req.flash('error', 'Item fulfillment is only available through the MySQL workflow.'); return res.redirect('/vendor/orders'); }
  try { await vendorPortal.transitionOrderItem(req.session.vendorUser.id, req.params.itemId, req.body.fulfillment_status, { note: req.body.note }); req.flash('success', 'Order item fulfillment updated.'); return res.redirect('/vendor/orders'); } catch (error) { if (error.statusCode === 404) { req.flash('error', 'Order item not found.'); return res.redirect('/vendor/orders'); } return next(error); }
});

// Legacy parent-order endpoint remains fail-closed in every database mode.
router.post('/vendor/orders/mark-ready/:orderId', requireCsrf, (req, res) => {
  req.flash('error', 'অর্ডারের স্ট্যাটাস পরিবর্তন নীতিমালা অনুমোদিত না হওয়া পর্যন্ত বন্ধ রয়েছে।');
  return res.redirect('/vendor/orders');
});

// ─── Vendor Wallet & Withdrawals ───
router.get('/vendor/withdrawals', (req, res) => {
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  const withdrawals = db.all(
    'SELECT * FROM vendor_withdrawals WHERE vendor_id = ? ORDER BY id DESC',
    vendor.id
  );
  res.render('vendor/withdrawals', { vendor, withdrawals });
});

router.post('/vendor/withdrawals/request', requireCsrf, (req, res) => {
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  const amount = Number(req.body.amount || 0);
  const method = String(req.body.method || 'bKash').trim();
  const accountNumber = String(req.body.account_number || '').trim();
  const note = String(req.body.note || '').trim();

  if (amount < 100 || !accountNumber) {
    req.flash('error', 'ন্যূনতম ৳১০০ এবং সঠিক অ্যাকাউন্ট নম্বর দিন।');
    return res.redirect('/vendor/withdrawals');
  }
  if (amount > Number(vendor.balance || 0)) {
    req.flash('error', 'আপনার ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই।');
    return res.redirect('/vendor/withdrawals');
  }

  db.run('UPDATE vendors SET balance = balance - ? WHERE id = ?', amount, vendor.id);
  db.run(
    "INSERT INTO vendor_withdrawals (vendor_id, amount, method, account_number, note, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    vendor.id,
    amount,
    method,
    accountNumber,
    note
  );
  req.flash('success', `৳${amount} উইথড্র রিকোয়েস্ট সফলভাবে অ্যাডমিনের কাছে পাঠানো হয়েছে!`);
  res.redirect('/vendor/withdrawals');
});

// ─── Vendor Shop Profile ───
router.get('/vendor/profile', (req, res) => {
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  res.render('vendor/profile', { vendor });
});

router.post('/vendor/profile', requireCsrf, (req, res) => {
  const { shop_name, owner_name, phone, email, address, new_password } = req.body;
  const vendorId = req.session.vendorUser.id;
  db.run(
    'UPDATE vendors SET shop_name = ?, owner_name = ?, phone = ?, email = ?, address = ? WHERE id = ?',
    shop_name.trim(),
    owner_name.trim(),
    phone.trim(),
    (email || '').trim(),
    (address || '').trim(),
    vendorId
  );
  if (new_password && new_password.trim().length >= 6) {
    const hash = bcrypt.hashSync(new_password.trim(), 10);
    db.run('UPDATE vendors SET password_hash = ? WHERE id = ?', hash, vendorId);
  }
  req.flash('success', 'শপ প্রোফাইল সফলভাবে আপডেট হয়েছে!');
  res.redirect('/vendor/profile');
});

module.exports = router;
