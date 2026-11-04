const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireVendor } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { createRateLimiter, createLoginRateLimiters } = require('../middleware/rateLimit');
const { revokeActorSessions } = require('../repositories/sessionRepository');
const upload = require('../middleware/upload');
const { env } = require('../config/env');
const vendorPortal = require('../repositories/vendorPortalRepository');
const { generateSafeProductSlug } = require('../utils/slug');
const partnerWithdrawalRepository = require('../repositories/partnerWithdrawalRepository');
const mysqlActive = () => env.db.client === 'mysql';

const router = express.Router();
const vendorAuthLimiters = createLoginRateLimiters({ keyPrefix: 'vendor_auth', identifierFields: ['identifier'], windowMs: 15 * 60 * 1000, maxPerIp: 2000, maxPerIpAccount: 8 });

function establishVendorSession(req, vendor, callback) {
  const preserved = { cart: Array.isArray(req.session.cart) ? req.session.cart : [], locale: req.session.locale };
  req.session.regenerate((error) => {
    if (error) return callback(error);
    Object.assign(req.session, preserved);
    req.session.vendorUser = { id: Number(vendor.id), shop_name: vendor.shop_name, owner_name: vendor.owner_name, phone: vendor.phone, email: vendor.email };
    req.session.save(callback);
  });
}

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

router.post('/vendor/login', ...vendorAuthLimiters, requireCsrf, async (req, res, next) => {
  const identifier = String(req.body.identifier || '').trim();
  const password = String(req.body.password || '');

  if (mysqlActive()) {
    try {
      const { queryOne } = require('../db/mysqlPool');
      const vendor = await queryOne('SELECT id,shop_name,owner_name,phone,email,password_hash,status FROM vendors WHERE (email=? OR phone=?) AND status=1 LIMIT 1', [identifier, identifier]);
      if (!vendor || !vendor.password_hash || !await bcrypt.compare(password, vendor.password_hash)) {
        return res.status(400).render('vendor/auth', { mode: 'login', error: 'Vendor email/mobile or password is incorrect.' });
      }
      return establishVendorSession(req, vendor, (error) => {
        if (error) return next(error);
        req.flash('success', `Welcome, ${vendor.shop_name}!`);
        return res.redirect('/vendor/orders');
      });
    } catch (error) { return next(error); }
  }

  const vendor = db.get(
    'SELECT * FROM vendors WHERE email = ? OR phone = ? LIMIT 1',
    identifier,
    identifier
  );
  if (!vendor || !vendor.status) {
    return res.render('vendor/auth', {
      mode: 'login',
      error: 'ভেন্ডর ইমেইল/মোবাইল অথবা পাসওয়ার্ড সঠিক নয়। আবার চেষ্টা করুন.',
    });
  }

  const valid = Boolean(vendor.password_hash) && await bcrypt.compare(password, vendor.password_hash);

  if (!valid) {
    return res.render('vendor/auth', {
      mode: 'login',
      error: 'ভেন্ডর ইমেইল/মোবাইল অথবা পাসওয়ার্ড সঠিক নয়। আবার চেষ্টা করুন.',
    });
  }

  return establishVendorSession(req, vendor, (error) => {
    if (error) return next(error);
    req.flash('success', `স্বাগতম, ${vendor.shop_name}!`);
    return res.redirect('/vendor/dashboard');
  });
});

router.get('/vendor/register', (req, res) => {
  if (req.session && req.session.vendorUser) {
    return res.redirect('/vendor/dashboard');
  }
  res.render('vendor/auth', { mode: 'register', error: null });
});

router.post('/vendor/register', requireCsrf, async (req, res, next) => {
  const { shop_name, owner_name, phone, email, address, password } = req.body;
  if (mysqlActive()) {
    try {
      const vendor=await vendorPortal.register({shop_name,owner_name,phone,email,address,password});
      return establishVendorSession(req,vendor,error=>{ if(error)return next(error); req.flash('success','ভেন্ডর অ্যাকাউন্ট তৈরি হয়েছে। পণ্য যোগ করা যাবে; অ্যাডমিন পর্যালোচনা শেষে পণ্য প্রকাশিত হবে।'); return res.redirect('/vendor/products'); });
    } catch(error) { if(error.code==='DB_DUPLICATE_ENTRY'||error.code==='VALIDATION_ERROR') return res.status(400).render('vendor/auth',{mode:'register',error:error.message}); return next(error); }
  }
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
router.use('/vendor', requireVendor, async (req,res,next)=>{
  if(!mysqlActive())return next();
  try{
    const vendor=await require('../db/mysqlPool').queryOne('SELECT status,lifecycle_status FROM vendors WHERE id=?',[req.session.vendorUser.id]);
    if(!vendor||Number(vendor.status)!==1){req.flash('error','Vendor account is unavailable.');return res.redirect('/vendor/login');}
    if(vendor.lifecycle_status==='active')return next();
    const viewOnlySuspended=['suspended','deactivated'].includes(vendor.lifecycle_status)&&req.method==='GET'&&(req.path.startsWith('/vendor/orders')||req.path.startsWith('/vendor/withdrawals')||/^\/vendor\/order-items\/\d+$/.test(req.path));
    if(viewOnlySuspended)return next();
    req.flash('error','This capability is locked until vendor onboarding and verification requirements are complete.');return res.redirect('/vendor/onboarding');
  }catch(error){return next(error);}
});

router.get('/vendor/dashboard', (req, res) => {
  if(mysqlActive())return res.redirect('/vendor/onboarding');
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
    `SELECT oi.price, oi.qty, o.status AS order_status
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
  if (mysqlActive()) { try { const sql = require('../db/mysqlPool'); const [categories, brands] = await Promise.all([sql.queryAll('SELECT id,name_bn AS name,status FROM categories WHERE status=1 ORDER BY sort_order,id'), sql.queryAll('SELECT id,name_bn AS name,status FROM brands WHERE status=1 ORDER BY id')]); return res.render('vendor/product-form', { product: null, categories, brands, variants: [] }); } catch (error) { return next(error); } }
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
    generateSafeProductSlug(b.slug || b.name, b.name_en, code),
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
  if (mysqlActive()) { try { const sql = require('../db/mysqlPool'); const product = (await vendorPortal.listProducts(req.session.vendorUser.id)).find(row => Number(row.id) === Number(req.params.id)); if (!product) return res.redirect('/vendor/products'); const [categories, brands] = await Promise.all([sql.queryAll('SELECT id,name_bn AS name,status FROM categories WHERE status=1 ORDER BY sort_order,id'), sql.queryAll('SELECT id,name_bn AS name,status FROM brands WHERE status=1 ORDER BY id')]); return res.render('vendor/product-form', { product, categories, brands, variants: await vendorPortal.listVariants(req.session.vendorUser.id, req.params.id) }); } catch (error) { return next(error); } }
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

router.post('/vendor/products/:id/variants', requireCsrf, async (req, res, next) => {
  if (!mysqlActive()) return res.status(409).send('Variant management requires MySQL.');
  try { await vendorPortal.saveVariant(req.session.vendorUser.id, req.params.id, req.body); req.flash('success', 'Variant saved.'); return res.redirect(`/vendor/products/edit/${req.params.id}`); } catch (error) { return next(error); }
});
router.post('/vendor/products/:id/variants/:variantId', requireCsrf, async (req, res, next) => {
  if (!mysqlActive()) return res.status(409).send('Variant management requires MySQL.');
  try { await vendorPortal.saveVariant(req.session.vendorUser.id, req.params.id, req.body, { variantId: req.params.variantId }); req.flash('success', 'Variant updated.'); return res.redirect(`/vendor/products/edit/${req.params.id}`); } catch (error) { return next(error); }
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
    `SELECT oi.*, o.id AS order_id, o.invoice_id,
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

// Multi-courier quote comparison and recommendation for vendor
router.get('/vendor/sub-orders/:subOrderId/courier-quotes', async (req, res, next) => {
  if (!mysqlActive()) { return res.status(400).json({ error: 'Requires MySQL workflow' }); }
  try {
    const courierRepo = require('../repositories/courierIntegrationRepository');
    const quotes = await courierRepo.getShipmentQuotesAndRecommendation({
      subOrderId: req.params.subOrderId,
      actor: { vendorId: req.session.vendorUser.id }
    });
    return res.json({ success: true, data: quotes });
  } catch (error) { return next(error); }
});

// Multi-courier one-click booking for vendor
router.post('/vendor/sub-orders/:subOrderId/one-click-book', requireCsrf, async (req, res, next) => {
  if (!mysqlActive()) { req.flash('error', 'Requires MySQL workflow.'); return res.redirect('/vendor/orders'); }
  try {
    const courierRepo = require('../repositories/courierIntegrationRepository');
    const result = await courierRepo.executeOneClickBooking({
      subOrderId: req.params.subOrderId,
      courierCode: req.body.courier_code,
      idempotencyKey: req.body.idempotency_key,
      note: req.body.note,
      actor: { vendorId: req.session.vendorUser.id }
    });
    if (req.accepts('json') && !req.body.redirect) {
      return res.json({ success: true, data: result });
    }
    req.flash('success', `কুরিয়ার বুকিং সফল হয়েছে (${result.courierName}, ট্র্যাকিং: ${result.trackingId})। পার্সেল কুরিয়ার রাইডারের কাছে হস্তান্তরের পর 'হস্তান্তর নিশ্চিত করুন' ক্লিক করুন।`);
    return res.redirect('/vendor/orders');
  } catch (error) { return next(error); }
});

// Multi-courier tracking sync for vendor
router.post('/vendor/sub-orders/:subOrderId/track-sync', requireCsrf, async (req, res, next) => {
  if (!mysqlActive()) { req.flash('error', 'Requires MySQL workflow.'); return res.redirect('/vendor/orders'); }
  try {
    const courierRepo = require('../repositories/courierIntegrationRepository');
    const result = await courierRepo.syncShipmentTracking({
      subOrderId: req.params.subOrderId,
      actor: { vendorId: req.session.vendorUser.id }
    });
    if (req.accepts('json') && !req.body.redirect) {
      return res.json({ success: true, data: result });
    }
    req.flash('success', 'কুরিয়ার ট্র্যাকিং স্ট্যাটাস আপডেট করা হয়েছে।');
    return res.redirect('/vendor/orders');
  } catch (error) { return next(error); }
});

// Independent vendor sub-order fulfillment; a vendor can only mutate its own sub-orders.
router.post('/vendor/sub-orders/:subOrderId/booking-result', requireCsrf, async (req,res,next) => {
  if(!mysqlActive()){req.flash('error','Shipment booking records require the MySQL workflow.');return res.redirect('/vendor/orders');}
  try { await require('../repositories/vendorOrderRepository').recordBookingResult({subOrderId:req.params.subOrderId,courierCode:req.body.courier_code,trackingReference:req.body.tracking_reference,resultCode:req.body.result_code,note:req.body.note,actor:{vendorId:req.session.vendorUser.id}}); req.flash('success','Courier booking result recorded; this does not confirm pickup.'); return res.redirect('/vendor/orders'); } catch(error){return next(error);}
});
router.post('/vendor/sub-orders/:subOrderId/handover', requireCsrf, async (req,res,next) => {
  if(!mysqlActive()){req.flash('error','Shipment handover requires the MySQL workflow.');return res.redirect('/vendor/orders');}
  try { await require('../repositories/vendorOrderRepository').recordPhysicalHandover({subOrderId:req.params.subOrderId,note:req.body.note,actor:{vendorId:req.session.vendorUser.id}}); req.flash('success','Physical courier handover recorded.'); return res.redirect('/vendor/orders'); } catch(error){return next(error);}
});
router.post('/vendor/sub-orders/:subOrderId/status', requireCsrf, async (req, res, next) => {
  if (!mysqlActive()) { req.flash('error', 'Sub-order fulfillment is only available through the MySQL workflow.'); return res.redirect('/vendor/orders'); }
  try {
    await require('../repositories/vendorOrderRepository').transitionSubOrder({
      subOrderId: req.params.subOrderId,
      toStatus: req.body.to_status,
      carrier: req.body.carrier,
      trackingCode: req.body.tracking_code,
      note: req.body.note,
      actor: { vendorId: req.session.vendorUser.id },
    });
    req.flash('success', 'Vendor sub-order status updated.');
    return res.redirect('/vendor/orders');
  } catch (error) { return next(error); }
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
router.get('/vendor/withdrawals', async (req, res, next) => {
  if (mysqlActive()) {
    try {
      const {queryOne}=require('../db/mysqlPool');
      const [row,withdrawals,payoutAccounts]=await Promise.all([queryOne('SELECT id,shop_name,owner_name,phone,email,balance_paisa/100 AS balance,lifecycle_status,payout_verified_at FROM vendors WHERE id=? AND status=1',[req.session.vendorUser.id]),partnerWithdrawalRepository.listVendorWithdrawals(req.session.vendorUser.id),require('../repositories/vendorOnboardingRepository').listPayoutAccounts(req.session.vendorUser.id)]);
      if(!row){req.flash('error','ভেন্ডর অ্যাকাউন্ট পাওয়া যায়নি।');return res.redirect('/vendor/login');}
      return res.render('vendor/withdrawals',{vendor:row,withdrawals,payoutAccounts});
    } catch(error){return next(error);}
  }
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  const withdrawals = db.all(
    'SELECT * FROM vendor_withdrawals WHERE vendor_id = ? ORDER BY id DESC',
    vendor.id
  );
  res.render('vendor/withdrawals', { vendor, withdrawals });
});

router.post('/vendor/withdrawals/request', requireCsrf, async (req, res, next) => {
  if (mysqlActive()) {
    try {
      await partnerWithdrawalRepository.requestVendorWithdrawal(req.session.vendorUser.id, { amount: req.body.amount, payoutAccountId: req.body.payout_account_id }, { ip: req.ip, userAgent: req.get('user-agent') });
      req.flash('success', 'উইথড্র রিকোয়েস্ট অ্যাডমিনের কাছে পাঠানো হয়েছে।');
      return res.redirect('/vendor/withdrawals');
    } catch (error) {
      if (['CONFLICT', 'NOT_FOUND'].includes(error.code) || error instanceof TypeError || error instanceof RangeError) { req.flash('error', error.message); return res.redirect('/vendor/withdrawals'); }
      return next(error);
    }
  }
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
router.get('/vendor/profile', async (req, res, next) => {
  if(mysqlActive()){try{return res.render('vendor/profile',{vendor:await require('../repositories/vendorOnboardingRepository').getVendorProfile(req.session.vendorUser.id),mysqlMode:true,geoData:require('../utils/bangladeshGeo').getGeoData()});}catch(error){return next(error);}}
  const vendor = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
  res.render('vendor/profile', { vendor,mysqlMode:false });
});

router.post('/vendor/profile', requireCsrf, async (req, res,next) => {
  if(mysqlActive()){try{await require('../repositories/vendorOnboardingRepository').updateVendorProfile(req.session.vendorUser.id,req.body,{type:'vendor',id:req.session.vendorUser.id,sessionId:req.sessionID,currentPassword:req.body.current_password,ip:req.ip,userAgent:req.get('user-agent')});req.flash('success','Vendor profile updated. Your verified mobile number was not changed.');return res.redirect('/vendor/profile');}catch(error){if(error.code==='VALIDATION_ERROR'||error.code==='CONFLICT'){req.flash('error',error.message);return res.redirect('/vendor/profile');}return next(error);}}
  const { shop_name, owner_name, phone, email, address, new_password } = req.body;
  const vendorId = req.session.vendorUser.id;
  const currentVendor = db.get('SELECT password_hash FROM vendors WHERE id=?', vendorId);
  if (new_password && (!currentVendor || !currentVendor.password_hash || !req.body.current_password || !await bcrypt.compare(String(req.body.current_password), currentVendor.password_hash))) {
    req.flash('error', 'বর্তমান পাসওয়ার্ড সঠিক নয়।');
    return res.redirect('/vendor/profile');
  }
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
    await revokeActorSessions('vendor', vendorId, req.sessionID);
  }
  req.flash('success', 'শপ প্রোফাইল সফলভাবে আপডেট হয়েছে!');
  res.redirect('/vendor/profile');
});

module.exports = router;
