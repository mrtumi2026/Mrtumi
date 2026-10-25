const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireReseller } = require('../middleware/auth');

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
  return res.redirect(req.session && req.session.resellerUser ? '/reseller/dashboard' : '/reseller/login');
});

router.get('/reseller/login', (req, res) => {
  if (req.session && req.session.resellerUser) {
    return res.redirect('/reseller/dashboard');
  }
  res.render('reseller/auth', { mode: 'login', error: null });
});

router.post('/reseller/login', (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
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
  if (req.session && req.session.resellerUser) {
    return res.redirect('/reseller/dashboard');
  }
  res.render('reseller/auth', { mode: 'register', error: null });
});

router.post('/reseller/register', (req, res) => {
  const { name, shop_name, phone, email, password } = req.body;
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

router.post('/reseller/logout', (req, res) => {
  delete req.session.resellerUser;
  res.redirect('/reseller/login');
});

// ─── Protected Reseller Portal Routes ───
router.use('/reseller', requireReseller);

router.get('/reseller/dashboard', (req, res) => {
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
router.get('/reseller/products', (req, res) => {
  const q = String(req.query.q || '').trim();
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
  res.render('reseller/products', { products, searchQuery: q });
});

// ─── Reseller Dropship Order Builder (Custom Selling Price + Live Profit) ───
router.get('/reseller/orders/create', (req, res) => {
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

router.post('/reseller/orders/create', (req, res) => {
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

router.get('/reseller/orders', (req, res) => {
  const orders = db.all(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.badge_class, 'sb-1') AS badge_class
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.reseller_id = ?
     ORDER BY o.id DESC`,
    req.session.resellerUser.id
  );
  res.render('reseller/orders', { orders });
});

// ─── Reseller Deposits & Withdrawals ───
router.get('/reseller/deposits', (req, res) => {
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  const transactions = db.all(
    "SELECT * FROM reseller_transactions WHERE reseller_id = ? AND type = 'deposit' ORDER BY id DESC",
    reseller.id
  );
  res.render('reseller/wallet', { mode: 'deposit', reseller, transactions });
});

router.post('/reseller/deposits/create', (req, res) => {
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

router.get('/reseller/withdrawals', (req, res) => {
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  const transactions = db.all(
    "SELECT * FROM reseller_transactions WHERE reseller_id = ? AND type = 'withdrawal' ORDER BY id DESC",
    reseller.id
  );
  res.render('reseller/wallet', { mode: 'withdrawal', reseller, transactions });
});

router.post('/reseller/withdrawals/create', (req, res) => {
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
router.get('/reseller/profile', (req, res) => {
  const reseller = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
  res.render('reseller/profile', { reseller });
});

router.post('/reseller/profile', (req, res) => {
  const { name, shop_name, phone, email, new_password } = req.body;
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
