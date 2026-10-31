const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireReseller } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { env } = require('../config/env');
const resellerPortal = require('../repositories/resellerPortalRepository');
const mysqlActive = () => env.db.client === 'mysql';

function activeResellerSession(req) { return req.resellerUser !== undefined ? req.resellerUser : req.session && req.session.resellerUser; }

function rotateResellerSession(req, reseller, callback) {
  const preserved = { cart: Array.isArray(req.session.cart) ? req.session.cart : [], locale: req.session.locale };
  req.session.regenerate((error) => {
    if (error) return callback(error);
    Object.assign(req.session, preserved);
    if (reseller) req.session.resellerUser = reseller;
    req.session.save(callback);
  });
}

const router = express.Router();

function generateInvoiceId() {
  for (let i = 0; i < 10; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const exists = db.get('SELECT id FROM orders WHERE invoice_id = ?', code);
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6);
}

// ─── Public Reseller Auth Routes ───
router.get('/reseller', (req, res) => {
  if (!activeResellerSession(req) && req.session) delete req.session.resellerUser;
  return res.redirect(activeResellerSession(req) ? '/reseller/dashboard' : '/reseller/login');
});

router.get('/reseller/login', (req, res) => {
  if (activeResellerSession(req)) return res.redirect('/reseller/dashboard');
  if (req.session) delete req.session.resellerUser;
  res.render('reseller/auth', { mode: 'login', error: null });
});

router.post('/reseller/login', requireCsrf, async (req, res, next) => {
  const identifier = String(req.body.identifier || '').trim();
  if (mysqlActive()) { try { const reseller = await resellerPortal.authenticate(identifier, req.body.password); if (!reseller) return res.status(401).render('reseller/auth', { mode: 'login', error: 'রিসেলার লগইন তথ্য সঠিক নয় অথবা অ্যাকাউন্ট নিষ্ক্রিয়।' }); return rotateResellerSession(req, reseller, error => { if (error) return next(error); req.flash('success', `স্বাগতম রিসেলার প্যানেলে, ${reseller.name}!`); return res.redirect('/reseller/dashboard'); }); } catch (error) { return next(error); } }
  const password = String(req.body.password || '');

  const reseller = db.get(
    'SELECT * FROM resellers WHERE email = ? OR phone = ? LIMIT 1',
    identifier,
    identifier
  );
  if (!reseller || !reseller.status) {
    return res.render('reseller/auth', {
      mode: 'login',
      error: 'রিসেলার ইমেইল/মোবাইল নম্বর খুঁজে পাওয়া যায়নি।',
    });
  }

  const valid = Boolean(reseller.password_hash) && bcrypt.compareSync(password, reseller.password_hash);

  if (!valid) {
    return res.render('reseller/auth', {
      mode: 'login',
      error: 'পাসওয়ার্ড সঠিক নয়। আবার চেষ্টা করুন।',
    });
  }

  req.session.resellerUser = {
    id: reseller.id,
    name: reseller.name,
    shop_name: reseller.shop_name,
    phone: reseller.phone,
    email: reseller.email,
  };
  req.flash('success', `স্বাগতম রিসেলার প্যানেলে, ${reseller.name}!`);
  res.redirect('/reseller/dashboard');
});

router.get('/reseller/register', (req, res) => {
  if (activeResellerSession(req)) return res.redirect('/reseller/dashboard');
  if (req.session) delete req.session.resellerUser;
  res.render('reseller/auth', { mode: 'register', error: null });
});

router.post('/reseller/register', requireCsrf, async (req, res, next) => {
  const { name, shop_name, phone, email, password } = req.body;
  if (mysqlActive()) { try { const reseller = await resellerPortal.register({ name, shop_name, phone, email, password }); return rotateResellerSession(req, reseller, error => { if (error) return next(error); req.flash('success', 'রিসেলার অ্যাকাউন্ট তৈরি হয়েছে। যাচাইকরণের পর আর্থিক সুবিধা চালু হবে।'); return res.redirect('/reseller/dashboard'); }); } catch (error) { return next(error); } }
  if (!name || !phone || !password) {
    return res.render('reseller/auth', {
      mode: 'register',
      error: 'নাম, মোবাইল নম্বর এবং পাসওয়ার্ড আবশ্যক।',
    });
  }

  const exists = db.get('SELECT id FROM resellers WHERE phone = ?', phone.trim());
  if (exists) {
    return res.render('reseller/auth', {
      mode: 'register',
      error: 'এই মোবাইল নম্বরে ইতিমধ্যে রিসেলার অ্যাকাউন্ট রয়েছে। লগইন করুন।',
    });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.run(
    `INSERT INTO resellers (name, shop_name, phone, email, balance, deposit_amount, password_hash, verified, status)
     VALUES (?, ?, ?, ?, 0, 0, ?, 0, 1)`,
    name.trim(),
    (shop_name || '').trim(),
    phone.trim(),
    (email || '').trim(),
    hash
  );

  const newReseller = db.get('SELECT * FROM resellers WHERE id = ?', result.lastInsertRowid);
  req.session.resellerUser = {
    id: newReseller.id,
    name: newReseller.name,
    shop_name: newReseller.shop_name,
    phone: newReseller.phone,
    email: newReseller.email,
  };
  req.flash('success', 'রিসেলার অ্যাকাউন্ট তৈরি হয়েছে! এখন পাইকারি ক্যাটালগ থেকে অর্ডার প্লেস করতে পারবেন।');
  res.redirect('/reseller/dashboard');
});

router.post('/reseller/logout', requireCsrf, (req, res, next) => {
  return rotateResellerSession(req, null, error => { if (error) return next(error); return res.redirect('/reseller/login'); });
});

// ─── Protected Reseller Portal Routes ───
router.use('/reseller', (req,res,next)=>{if(mysqlActive()){res.locals.allowOrderCreation=false;res.locals.allowFinancialMutations=false;}next();}, requireReseller);

router.get('/reseller/dashboard', async (req, res, next) => {
  if (mysqlActive()) { try { const id=req.session.resellerUser.id; const [reseller,summary,orders,hotProducts]=await Promise.all([resellerPortal.getProfile(id),resellerPortal.getDashboardSummary(id),resellerPortal.listOrders(id,{page:1,perPage:8}),resellerPortal.listPublicProducts()]); return res.render('reseller/dashboard',{reseller,totalOrders:Number(summary.total_orders||0),deliveredCount:Number(summary.delivered_orders||0),pendingCount:Number(summary.pending_orders||0),totalEstimatedProfit:0,recentOrders:orders.orders,hotProducts:hotProducts.slice(0,6),allowOrderCreation:false,recordedMargin:true,canonicalDashboard:true}); } catch(error) { return next(error); } }
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  const myOrders = db.all(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.badge_class, 'sb-1') AS badge_class
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.reseller_id = ?
     ORDER BY o.id DESC`,
    reseller.id
  );

  const deliveredOrders = myOrders.filter((o) => o.status === 'completed');
  const pendingOrders = myOrders.filter((o) => o.status === 'pending' || o.status === 'processing');
  const totalEstimatedProfit = myOrders
    .filter((o) => o.status !== 'cancelled')
    .reduce((s, o) => s + Number(o.reseller_profit || 0), 0);

  const hotProducts = db.all(
    `SELECT p.*, c.name AS category_name,
            CASE WHEN p.wholesale_price > 0 THEN p.wholesale_price ELSE ROUND(p.new_price * 0.85) END AS reseller_cost
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 1
     ORDER BY p.sold_count DESC, p.id ASC LIMIT 6`
  );

  res.render('reseller/dashboard', {
    canonicalDashboard: false,
    reseller,
    totalOrders: myOrders.length,
    deliveredCount: deliveredOrders.length,
    pendingCount: pendingOrders.length,
    totalEstimatedProfit,
    recentOrders: myOrders.slice(0, 8),
    hotProducts,
  });
});

// ─── Reseller Wholesale Product Catalog ───
router.get('/reseller/products', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (mysqlActive()) { try { const products=await resellerPortal.listPublicProducts(q); return res.render('reseller/products',{products,searchQuery:q,allowOrderCreation:false,canonicalCatalog:true}); } catch(error) { return next(error); } }
  const products = db.all(
    `SELECT p.*, c.name AS category_name,
            CASE WHEN p.wholesale_price > 0 THEN p.wholesale_price ELSE ROUND(p.new_price * 0.85) END AS reseller_cost
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 1 AND (? = '' OR p.name LIKE ? OR c.name LIKE ?)
     ORDER BY p.id ASC`,
    q,
    `%${q}%`,
    `%${q}%`
  );
  res.render('reseller/products', { products, searchQuery: q, canonicalCatalog: false });
});

// ─── Reseller Dropship Order Builder (Custom Selling Price + Live Profit) ───
router.get('/reseller/orders/create', (req, res, next) => {
  if (mysqlActive()) return res.status(409).render('reseller/unsupported-operation',{message:'অর্ডার তৈরি আপাতত বন্ধ। অনুমোদিত reseller-order pricing, stock allocation ও audit rules সংজ্ঞায়িত না হওয়া পর্যন্ত কোনো financial/order mutation গ্রহণ করা হবে না।'});
  const products = db.all(
    `SELECT p.*,
            CASE WHEN p.wholesale_price > 0 THEN p.wholesale_price ELSE ROUND(p.new_price * 0.85) END AS reseller_cost
     FROM products p
     WHERE p.status = 1 AND p.stock > 0
     ORDER BY p.id ASC`
  );
  const selectedId = Number(req.query.product_id || (products[0] ? products[0].id : 0));
  const settings = db.getSettings();
  res.render('reseller/order-create', {
    products,
    selectedId,
    insideCharge: Number(settings.inside_dhaka_charge || 60),
    outsideCharge: Number(settings.outside_dhaka_charge || 120),
  });
});

router.post('/reseller/orders/create', requireCsrf, (req, res) => {
  if (mysqlActive()) return res.status(409).render('reseller/unsupported-operation',{message:'অর্ডার তৈরি আপাতত বন্ধ। অনুমোদিত reseller-order pricing, stock allocation ও audit rules সংজ্ঞায়িত না হওয়া পর্যন্ত কোনো financial/order mutation গ্রহণ করা হবে না।'});
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  const {
    product_id,
    qty,
    size,
    selling_unit_price,
    customer_name,
    phone,
    address,
    shipping_area,
    note,
  } = req.body;

  const prod = db.get(
    `SELECT p.*,
            CASE WHEN p.wholesale_price > 0 THEN p.wholesale_price ELSE ROUND(p.new_price * 0.85) END AS reseller_cost
     FROM products p WHERE p.id = ? AND p.status = 1`,
    Number(product_id)
  );
  if (!prod) {
    req.flash('error', 'পণ্য নির্বাচন সঠিক নয়।');
    return res.redirect('/reseller/orders/create');
  }

  const orderQty = Math.max(1, Number(qty || 1));
  const unitCost = Number(prod.reseller_cost);
  const sellUnit = Math.max(unitCost, Number(selling_unit_price || prod.new_price));
  const profit = Math.max(0, (sellUnit - unitCost) * orderQty);

  const settings = db.getSettings();
  const ship =
    shipping_area === 'ঢাকার বাইরে'
      ? Number(settings.outside_dhaka_charge || 120)
      : Number(settings.inside_dhaka_charge || 60);

  const subtotal = sellUnit * orderQty;
  const totalAmount = subtotal + ship;
  const inv = generateInvoiceId();

  const ordRes = db.run(
    `INSERT INTO orders
    (invoice_id, reseller_id, reseller_profit, customer_name, phone, address, shipping_area, shipping_charge,
     subtotal, discount, amount, payment_method, status, traffic_source, order_type, note, is_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Cash On Delivery', 'pending', 'Reseller', 'reseller', ?, 0)`,
    inv,
    reseller.id,
    profit,
    customer_name.trim(),
    phone.trim(),
    address.trim(),
    shipping_area || 'ঢাকার ভিতরে',
    ship,
    subtotal,
    totalAmount,
    `[Reseller: ${reseller.shop_name || reseller.name}] ${note || ''}`.trim()
  );

  db.run(
    `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ordRes.lastInsertRowid,
    prod.id,
    prod.name,
    prod.image,
    sellUnit,
    orderQty,
    size || (prod.sizes ? prod.sizes.split(',')[0].trim() : '১ কেজি')
  );

  db.run(
    'UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?',
    orderQty,
    orderQty,
    prod.id
  );

  req.flash('success', `রিসেলার অর্ডার #${inv} প্লেস হয়েছে! ডেলিভারি শেষে আপনার ওয়ালেটে লাভ ৳${profit} যুক্ত হবে।`);
  res.redirect('/reseller/orders');
});

router.get('/reseller/orders/:id', async (req, res, next) => {
  if (!mysqlActive()) return res.redirect('/reseller/orders');
  try { const data=await resellerPortal.getOrderDetails(req.session.resellerUser.id,req.params.id); return res.render('reseller/order-detail',{...data,order:data.order,items:data.items}); } catch(error) { if(error.statusCode===404) return res.status(404).render('reseller/unsupported-operation',{message:'অর্ডার পাওয়া যায়নি।'}); return next(error); }
});

router.get('/reseller/orders', async (req, res, next) => {
  if (mysqlActive()) { try { const result=await resellerPortal.listOrders(req.session.resellerUser.id,{page:req.query.page||1,perPage:20,status:req.query.status||'',search:req.query.q||''}); return res.render('reseller/orders',{...result,orders:result.orders,canonicalOrders:true}); } catch(error) { return next(error); } }
  const orders = db.all(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.badge_class, 'sb-1') AS badge_class
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.reseller_id = ?
     ORDER BY o.id DESC`,
    req.session.resellerUser.id
  );
  res.render('reseller/orders', { orders, canonicalOrders: false });
});

// ─── Reseller Deposits & Withdrawals ───
router.get('/reseller/transactions', async (req,res,next)=>{
  if(!mysqlActive()) return res.redirect('/reseller/deposits');
  try{const id=req.session.resellerUser.id;const [reseller,result]=await Promise.all([resellerPortal.getProfile(id),resellerPortal.listTransactions(id,req.query.type||'',{page:req.query.page||1})]);return res.render('reseller/wallet',{mode:'history',reseller,transactions:result.transactions,pagination:result,canonicalWallet:true,transactionType:result.type});}catch(error){return next(error);}
});
router.get('/reseller/deposits', async (req, res, next) => {
  if (mysqlActive()) { try { const id=req.session.resellerUser.id; const [reseller,result]=await Promise.all([resellerPortal.getProfile(id),resellerPortal.listTransactions(id,'deposit',{page:req.query.page||1})]); return res.render('reseller/wallet',{mode:'deposit',reseller,transactions:result.transactions,pagination:result,canonicalWallet:true}); } catch(error) { return next(error); } }
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  const transactions = db.all(
    "SELECT * FROM reseller_transactions WHERE reseller_id = ? AND type = 'deposit' ORDER BY id DESC",
    reseller.id
  );
  res.render('reseller/wallet', { mode: 'deposit', reseller, transactions, canonicalWallet: false });
});

router.post('/reseller/deposits/create', requireCsrf, (req, res) => {
  if (mysqlActive()) return res.status(409).render('reseller/unsupported-operation',{message:'ডিপোজিট আবেদন বন্ধ। অনুমোদিত wallet reconciliation, review ও audit policy না থাকায় কোনো অর্থ-সম্পর্কিত পরিবর্তন করা হবে না।'});
  const resellerId = req.session.resellerUser.id;
  const amount = Number(req.body.amount || 0);
  const method = String(req.body.method || 'bKash').trim();
  const trxId = String(req.body.trx_id || '').trim();

  if (amount < 100 || !trxId) {
    req.flash('error', 'ন্যূনতম ৳১০০ এবং সঠিক TrxID প্রদান করুন।');
    return res.redirect('/reseller/deposits');
  }

  db.run(
    "INSERT INTO reseller_transactions (reseller_id, type, amount, method, trx_id, status) VALUES (?, 'deposit', ?, ?, ?, 'pending')",
    resellerId,
    amount,
    method,
    trxId
  );
  req.flash('success', `৳${amount} ডিপোজিট রিকোয়েস্ট জমা হয়েছে! অ্যাডমিন অনুমোদন করলে ব্যালেন্সে যোগ হবে।`);
  res.redirect('/reseller/deposits');
});

router.get('/reseller/withdrawals', async (req, res, next) => {
  if (mysqlActive()) { try { const id=req.session.resellerUser.id; const [reseller,result]=await Promise.all([resellerPortal.getProfile(id),resellerPortal.listTransactions(id,'withdrawal',{page:req.query.page||1})]); return res.render('reseller/wallet',{mode:'withdrawal',reseller,transactions:result.transactions,pagination:result,canonicalWallet:true}); } catch(error) { return next(error); } }
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  const transactions = db.all(
    "SELECT * FROM reseller_transactions WHERE reseller_id = ? AND type = 'withdrawal' ORDER BY id DESC",
    reseller.id
  );
  res.render('reseller/wallet', { mode: 'withdrawal', reseller, transactions, canonicalWallet: false });
});

router.post('/reseller/withdrawals/create', requireCsrf, (req, res) => {
  if (mysqlActive()) return res.status(409).render('reseller/unsupported-operation',{message:'উইথড্র আবেদন বন্ধ। অনুমোদিত settlement calculation, approval ও audit policy না থাকায় কোনো অর্থ-সম্পর্কিত পরিবর্তন করা হবে না।'});
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  const amount = Number(req.body.amount || 0);
  const method = String(req.body.method || 'bKash').trim();
  const accountNo = String(req.body.trx_id || '').trim();

  if (amount < 100 || !accountNo) {
    req.flash('error', 'ন্যূনতম ৳১০০ এবং বিকাশ/নগদ অ্যাকাউন্ট নম্বর দিন।');
    return res.redirect('/reseller/withdrawals');
  }
  if (amount > Number(reseller.balance || 0)) {
    req.flash('error', 'আপনার কমিশন ব্যালেন্সে পর্যাপ্ত টাকা নেই।');
    return res.redirect('/reseller/withdrawals');
  }

  db.run('UPDATE resellers SET balance = balance - ? WHERE id = ?', amount, reseller.id);
  db.run(
    "INSERT INTO reseller_transactions (reseller_id, type, amount, method, trx_id, status) VALUES (?, 'withdrawal', ?, ?, ?, 'pending')",
    reseller.id,
    amount,
    method,
    accountNo
  );
  req.flash('success', `৳${amount} কমিশন উইথড্র রিকোয়েস্ট পাঠানো হয়েছে!`);
  res.redirect('/reseller/withdrawals');
});

// ─── Reseller Profile ───
router.get('/reseller/profile', async (req, res, next) => {
  if (mysqlActive()) { try { return res.render('reseller/profile', { reseller: await resellerPortal.getProfile(req.session.resellerUser.id), canonicalProfile: true }); } catch (error) { return next(error); } }
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  res.render('reseller/profile', { reseller });
});

router.post('/reseller/profile', requireCsrf, async (req, res, next) => {
  const { name, shop_name, phone, email, new_password } = req.body;
  if (mysqlActive()) { try { const updated = await resellerPortal.updateProfile(req.session.resellerUser.id, { name, shop_name, email, new_password }); const current = await resellerPortal.getProfile(updated.id); const sessionUser = { id: current.id, name: current.name, shop_name: current.shop_name, phone: current.phone, email: current.email }; return rotateResellerSession(req, sessionUser, error => { if (error) return next(error); req.flash('success', 'রিসেলার প্রোফাইল আপডেট হয়েছে।'); return res.redirect('/reseller/profile'); }); } catch (error) { return next(error); } }
  const rId = req.session.resellerUser.id;
  db.run(
    'UPDATE resellers SET name = ?, shop_name = ?, phone = ?, email = ? WHERE id = ?',
    name.trim(),
    (shop_name || '').trim(),
    phone.trim(),
    (email || '').trim(),
    rId
  );
  if (new_password && new_password.trim().length >= 6) {
    const hash = bcrypt.hashSync(new_password.trim(), 10);
    db.run('UPDATE resellers SET password_hash = ? WHERE id = ?', hash, rId);
  }
  req.flash('success', 'রিসেলার প্রোফাইল আপডেট হয়েছে!');
  res.redirect('/reseller/profile');
});

module.exports = router;
