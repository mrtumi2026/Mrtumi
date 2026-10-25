const express = require('express');
const db = require('../db/database');

const router = express.Router();

function generateInvoiceId() {
  for (let i = 0; i < 10; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const exists = db.get('SELECT id FROM orders WHERE invoice_id = ?', code);
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6);
}

function detectTrafficSource(req) {
  const ref = String(req.get('Referrer') || req.query.utm_source || '').toLowerCase();
  if (ref.includes('facebook') || ref.includes('fb')) return 'Facebook';
  if (ref.includes('google')) return 'Google';
  if (ref.includes('tiktok')) return 'TikTok';
  if (ref && !ref.includes(req.get('host') || '')) return 'Other';
  return 'Direct';
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  const ctype = String(req.headers['content-type'] || '');
  return (
    req.xhr ||
    req.headers['x-requested-with'] === 'XMLHttpRequest' ||
    accept.includes('application/json') ||
    ctype.includes('application/json')
  );
}

function computeCartTotals(req) {
  if (!Array.isArray(req.session.cart)) req.session.cart = [];
  const cart = req.session.cart;
  const cartCount = cart.reduce((s, i) => s + (Number(i.qty) || 1), 0);
  const cartSubtotal = cart.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);

  // Recalculate coupon discount if applied
  let discount = 0;
  if (req.session.appliedCoupon && req.session.appliedCoupon.code) {
    const cpn = db.get(
      'SELECT * FROM coupons WHERE UPPER(code) = ? AND status = 1',
      String(req.session.appliedCoupon.code).toUpperCase()
    );
    if (cpn && cartSubtotal >= Number(cpn.min_purchase || 0)) {
      discount =
        cpn.type === 'percent'
          ? Math.round((cartSubtotal * Number(cpn.value)) / 100)
          : Number(cpn.value);
      req.session.appliedCoupon.discount = discount;
    } else if (cartSubtotal === 0) {
      delete req.session.appliedCoupon;
    }
  }

  return {
    cart,
    cartCount,
    cartSubtotal,
    discount,
    appliedCoupon: req.session.appliedCoupon || null,
  };
}

// ─── Storefront Home ───
router.get('/', (_req, res) => {
  const heroBanners = db.all("SELECT * FROM banners WHERE position = 'hero' AND status = 1 ORDER BY sort_order ASC");
  const promoBanners = db.all("SELECT * FROM banners WHERE position = 'promo_mid' AND status = 1 ORDER BY sort_order ASC");
  const flashProducts = db.all('SELECT * FROM products WHERE status = 1 AND is_flash_sale = 1 ORDER BY id ASC LIMIT 8');
  const hotProducts = db.all('SELECT * FROM products WHERE status = 1 AND is_hot_deal = 1 ORDER BY id DESC LIMIT 8');
  const allProducts = db.all('SELECT * FROM products WHERE status = 1 ORDER BY id ASC LIMIT 12');

  const categories = db.all('SELECT * FROM categories WHERE status = 1 ORDER BY sort_order ASC');
  const categorySections = categories
    .map((cat) => ({
      category: cat,
      products: db.all('SELECT * FROM products WHERE status = 1 AND category_id = ? ORDER BY id ASC LIMIT 6', cat.id),
    }))
    .filter((sec) => sec.products.length > 0);

  res.render('store/home', {
    heroBanners,
    promoBanners,
    flashProducts,
    hotProducts,
    categorySections,
    allProducts,
  });
});

// ─── Product Listings (All / Search / Flash / Hot / Category) ───
router.get('/all-products', (req, res) => {
  const q = String(req.query.q || '').trim();
  const sort = String(req.query.sort || 'newest');

  let orderBy = 'ORDER BY p.id DESC';
  if (sort === 'price_asc') orderBy = 'ORDER BY p.new_price ASC';
  if (sort === 'price_desc') orderBy = 'ORDER BY p.new_price DESC';

  const products = q
    ? db.all(
        `SELECT p.*, c.name AS category_name FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.status = 1 AND (p.name LIKE ? OR p.short_desc LIKE ? OR c.name LIKE ?)
         ${orderBy}`,
        `%${q}%`,
        `%${q}%`,
        `%${q}%`
      )
    : db.all(
        `SELECT p.*, c.name AS category_name FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.status = 1 ${orderBy}`
      );

  res.render('store/catalog', {
    pageTitle: q ? `"${q}" এর ফলাফল` : 'সকল প্রোডাক্ট',
    subtitle: 'বাগান থেকে সংগৃহীত শতভাগ তাজা ও ফরমালিনমুক্ত ফল',
    products,
    searchQuery: q,
    sort,
  });
});

router.get('/flash-sales', (_req, res) => {
  const products = db.all('SELECT * FROM products WHERE status = 1 AND is_flash_sale = 1 ORDER BY id ASC');
  res.render('store/catalog', {
    pageTitle: '⚡ Flash Sale — ঝলমলে ছাড়!',
    subtitle: 'সীমিত সময়ের ধামাকা ডিসকাউন্ট — স্টক শেষ হওয়ার আগেই অর্ডার করুন',
    products,
    searchQuery: '',
    sort: 'newest',
  });
});

router.get('/hot-deals', (_req, res) => {
  const products = db.all('SELECT * FROM products WHERE status = 1 AND is_hot_deal = 1 ORDER BY id DESC');
  res.render('store/catalog', {
    pageTitle: '🔥 Hot Deal — বিশেষ অফার',
    subtitle: 'সেরা মূল্যে বাছাইকৃত প্রিমিয়াম ফলের প্যাক',
    products,
    searchQuery: '',
    sort: 'newest',
  });
});

router.get('/category/:slug', (req, res) => {
  const cat = db.get('SELECT * FROM categories WHERE slug = ?', req.params.slug);
  if (!cat) return res.redirect('/all-products');

  const products = db.all('SELECT * FROM products WHERE status = 1 AND category_id = ? ORDER BY id DESC', cat.id);
  res.render('store/catalog', {
    pageTitle: cat.name,
    subtitle: `${cat.name} ক্যাটাগরির সকল তাজা ফল`,
    products,
    searchQuery: '',
    sort: 'newest',
  });
});

// ─── Single Product Detail (/product/:slug) ───
router.get('/product/:slug', (req, res) => {
  const product = db.get(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug, b.name AS brand_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.slug = ? OR CAST(p.id AS TEXT) = ?`,
    req.params.slug,
    req.params.slug
  );
  if (!product) return res.redirect('/all-products');

  const reviews = db.all(
    "SELECT * FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY id DESC",
    product.id
  );
  const relatedProducts = db.all(
    'SELECT * FROM products WHERE status = 1 AND category_id = ? AND id != ? LIMIT 6',
    product.category_id,
    product.id
  );

  res.render('store/product', {
    product,
    reviews,
    relatedProducts,
  });
});

// ─── Dedicated Shopping Cart Page (/cart) ───
router.get('/cart', (req, res) => {
  const state = computeCartTotals(req);
  res.render('store/cart', state);
});

// ─── Cart Endpoints ───
router.post('/cart/add', (req, res) => {
  const { product_id, qty, size, color, buy_now } = req.body;
  const prod = db.get('SELECT * FROM products WHERE id = ? AND status = 1', Number(product_id));
  if (!prod) {
    if (wantsJson(req)) {
      return res.status(404).json({ success: false, message: 'পণ্য খুঁজে পাওয়া যায়নি।' });
    }
    req.flash('error', 'পণ্য খুঁজে পাওয়া যায়নি।');
    return res.redirect('/all-products');
  }

  if (Number(prod.stock) <= 0) {
    if (wantsJson(req)) {
      return res.status(400).json({ success: false, message: `"${prod.name}" বর্তমানে স্টক আউট।` });
    }
    req.flash('error', `"${prod.name}" বর্তমানে স্টক আউট।`);
    return res.redirect(req.get('Referrer') || `/product/${prod.slug}`);
  }

  const addQty = Math.max(1, Number(qty || 1));
  const chosenSize = String(size || (prod.sizes ? prod.sizes.split(',')[0].trim() : '১ কেজি')).trim();
  const chosenColor = String(color || (prod.colors ? prod.colors.split(',')[0].trim() : '')).trim();

  if (!Array.isArray(req.session.cart)) req.session.cart = [];
  const existing = req.session.cart.find(
    (it) => Number(it.product_id) === Number(prod.id) && it.size === chosenSize && it.color === chosenColor
  );

  if (existing) {
    existing.qty = Math.min(Number(prod.stock || 999), Number(existing.qty || 1) + addQty);
    existing.price =
      prod.wholesale_price > 0 && prod.wholesale_min_qty > 0 && existing.qty >= prod.wholesale_min_qty
        ? Number(prod.wholesale_price)
        : Number(prod.new_price);
  } else {
    const finalQty = Math.min(Number(prod.stock || 999), addQty);
    const unitPrice =
      prod.wholesale_price > 0 && prod.wholesale_min_qty > 0 && finalQty >= prod.wholesale_min_qty
        ? Number(prod.wholesale_price)
        : Number(prod.new_price);

    req.session.cart.push({
      key: `${prod.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      product_id: prod.id,
      name: prod.name,
      slug: prod.slug,
      image: prod.image,
      regular_price: Number(prod.new_price),
      wholesale_price: Number(prod.wholesale_price || 0),
      wholesale_min_qty: Number(prod.wholesale_min_qty || 0),
      price: unitPrice,
      qty: finalQty,
      size: chosenSize,
      color: chosenColor,
    });
  }

  const state = computeCartTotals(req);
  const isBuyNow = String(buy_now || '') === '1' || buy_now === true;

  if (wantsJson(req)) {
    return res.json({
      success: true,
      message: `"${prod.name}" কার্টে যোগ করা হয়েছে!`,
      ...state,
      sessionToken: req.sessionID,
      redirect: isBuyNow ? '/customer/checkout' : null,
    });
  }

  if (isBuyNow) {
    return res.redirect('/customer/checkout');
  }
  req.flash('success', `"${prod.name}" কার্টে যোগ করা হয়েছে!`);
  res.redirect(req.get('Referrer') || '/cart');
});

router.post('/cart/update', (req, res) => {
  const { key, qty } = req.body;
  if (Array.isArray(req.session.cart)) {
    const item = req.session.cart.find((i) => i.key === key);
    if (item) {
      const n = Number(qty);
      if (n <= 0) {
        req.session.cart = req.session.cart.filter((i) => i.key !== key);
      } else {
        const prod = db.get('SELECT * FROM products WHERE id = ?', item.product_id);
        const maxStock = prod ? Math.max(1, Number(prod.stock || 999)) : 999;
        item.qty = Math.min(maxStock, n);
        if (prod) {
          item.price =
            prod.wholesale_price > 0 && prod.wholesale_min_qty > 0 && item.qty >= prod.wholesale_min_qty
              ? Number(prod.wholesale_price)
              : Number(prod.new_price);
        }
      }
    }
  }

  const state = computeCartTotals(req);
  if (wantsJson(req)) {
    return res.json({
      success: true,
      message: 'কার্ট আপডেট করা হয়েছে।',
      ...state,
      sessionToken: req.sessionID,
    });
  }
  res.redirect(req.get('Referrer') || '/customer/checkout');
});

router.post('/cart/remove', (req, res) => {
  const { key } = req.body;
  if (Array.isArray(req.session.cart)) {
    req.session.cart = req.session.cart.filter((i) => i.key !== key);
  }
  const state = computeCartTotals(req);
  if (wantsJson(req)) {
    return res.json({
      success: true,
      message: 'পণ্যটি কার্ট থেকে সরানো হয়েছে।',
      ...state,
      sessionToken: req.sessionID,
    });
  }
  res.redirect(req.get('Referrer') || '/customer/checkout');
});

router.post('/cart/clear', (req, res) => {
  req.session.cart = [];
  delete req.session.appliedCoupon;
  if (wantsJson(req)) {
    return res.json({
      success: true,
      message: 'কার্ট খালি করা হয়েছে।',
      cart: [],
      cartCount: 0,
      cartSubtotal: 0,
      discount: 0,
    });
  }
  req.flash('success', 'শপিং কার্ট খালি করা হয়েছে।');
  res.redirect('/cart');
});

router.get('/cart/json', (req, res) => {
  const state = computeCartTotals(req);
  res.json({
    ...state,
    sessionToken: req.sessionID,
  });
});

// ─── Direct 1-Click Quick Order (from Quick Order Modal or Product Page) ───
router.post('/order/quick-submit', (req, res) => {
  const {
    product_id,
    qty,
    size,
    color,
    customer_name,
    phone,
    address,
    shipping_area,
    note,
  } = req.body;

  const prod = db.get('SELECT * FROM products WHERE id = ? AND status = 1', Number(product_id));
  if (!prod) {
    if (wantsJson(req)) {
      return res.status(404).json({ success: false, message: 'পণ্য খুঁজে পাওয়া যায়নি।' });
    }
    req.flash('error', 'পণ্য খুঁজে পাওয়া যায়নি।');
    return res.redirect('/all-products');
  }

  const cleanName = String(customer_name || '').trim();
  const cleanPhone = String(phone || '').replace(/[^\d+]/g, '').trim();
  const cleanAddr = String(address || '').trim();

  if (!cleanName || cleanPhone.length < 10 || !cleanAddr) {
    const errMsg = 'অনুগ্রহ করে নাম, সঠিক মোবাইল নম্বর (১১ সংখ্যা) এবং সম্পূর্ণ ঠিকানা লিখুন।';
    if (wantsJson(req)) {
      return res.status(400).json({ success: false, message: errMsg });
    }
    req.flash('error', errMsg);
    return res.redirect(req.get('Referrer') || `/product/${prod.slug}`);
  }

  const clientIp = req.ip || '';
  const blocked = db.get(
    'SELECT * FROM ip_blocks WHERE status = 1 AND (ip_or_phone = ? OR ip_or_phone = ?)',
    cleanPhone,
    clientIp
  );
  if (blocked) {
    const msg = 'দুঃখিত, আপনার নম্বর থেকে বর্তমানে অর্ডার গ্রহণ করা সম্ভব হচ্ছে না। হটলাইনে যোগাযোগ করুন।';
    if (wantsJson(req)) return res.status(403).json({ success: false, message: msg });
    req.flash('error', msg);
    return res.redirect('/');
  }

  const orderQty = Math.max(1, Number(qty || 1));
  const unitPrice =
    prod.wholesale_price > 0 && prod.wholesale_min_qty > 0 && orderQty >= prod.wholesale_min_qty
      ? Number(prod.wholesale_price)
      : Number(prod.new_price);

  const settings = db.getSettings();
  const insideCharge = Number(settings.inside_dhaka_charge || 60);
  const outsideCharge = Number(settings.outside_dhaka_charge || 120);
  const freeMin = Number(settings.free_shipping_min || 2500);

  const subtotal = unitPrice * orderQty;
  let shippingCharge = shipping_area === 'ঢাকার বাইরে' ? outsideCharge : insideCharge;
  if (freeMin > 0 && subtotal >= freeMin) shippingCharge = 0;

  const totalAmount = subtotal + shippingCharge;
  const inv = generateInvoiceId();
  const trafficSource = detectTrafficSource(req);
  const chosenSize = String(size || (prod.sizes ? prod.sizes.split(',')[0].trim() : '১ কেজি')).trim();
  const chosenColor = String(color || '').trim();

  const ordRes = db.run(
    `INSERT INTO orders
    (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, discount, coupon_code,
     amount, payment_method, payment_status, status, traffic_source, order_type, note, is_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?, 'ক্যাশ অন ডেলিভারি', 'unpaid', 'pending', ?, 'quick_order', ?, 0)`,
    inv,
    cleanName,
    cleanPhone,
    cleanAddr,
    shipping_area || 'ঢাকার ভিতরে',
    shippingCharge,
    subtotal,
    totalAmount,
    trafficSource,
    note || ''
  );

  db.run(
    `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ordRes.lastInsertRowid,
    prod.id,
    prod.name,
    prod.image,
    unitPrice,
    orderQty,
    chosenSize,
    chosenColor
  );

  db.run(
    'UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?',
    orderQty,
    orderQty,
    prod.id
  );

  const existingCust = db.get('SELECT id FROM customers WHERE phone = ?', cleanPhone);
  if (!existingCust) {
    db.run(
      'INSERT INTO customers (name, phone, address, ip_address, total_orders) VALUES (?, ?, ?, ?, 1)',
      cleanName,
      cleanPhone,
      cleanAddr,
      clientIp
    );
  } else {
    db.run(
      'UPDATE customers SET total_orders = total_orders + 1, address = ? WHERE id = ?',
      cleanAddr,
      existingCust.id
    );
  }

  const successUrl = `/order-success/${inv}`;
  if (wantsJson(req)) {
    return res.json({
      success: true,
      invoice_id: inv,
      redirect: successUrl,
      message: `অর্ডার #${inv} সফলভাবে সম্পন্ন হয়েছে!`,
    });
  }
  res.redirect(successUrl);
});

// ─── Coupon Validation ───
router.post('/checkout/apply-coupon', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const subtotal = (req.session.cart || []).reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);

  const coupon = db.get('SELECT * FROM coupons WHERE UPPER(code) = ? AND status = 1', code);
  if (!coupon) {
    return res.json({ success: false, message: 'কুপন কোডটি সঠিক নয় বা মেয়াদোত্তীর্ণ।' });
  }
  if (subtotal < Number(coupon.min_purchase || 0)) {
    return res.json({
      success: false,
      message: `এই কুপন ব্যবহার করতে ন্যূনতম ৳${coupon.min_purchase} অর্ডার করতে হবে।`,
    });
  }

  const discount =
    coupon.type === 'percent'
      ? Math.round((subtotal * Number(coupon.value)) / 100)
      : Number(coupon.value);

  req.session.appliedCoupon = { code: coupon.code, discount };
  return res.json({
    success: true,
    code: coupon.code,
    discount,
    message: `কুপন "${coupon.code}" প্রয়োগ হয়েছে! ছাড়: ৳${discount}`,
  });
});

// ─── Save Incomplete / Abandoned Checkout ───
router.post('/checkout/save-incomplete', (req, res) => {
  const { name, phone, address } = req.body;
  const cleanPhone = String(phone || '').trim();
  if (cleanPhone.length >= 10 && Array.isArray(req.session.cart) && req.session.cart.length > 0) {
    const summary = req.session.cart.map((i) => `${i.name} × ${i.qty}`).join(', ');
    const est = req.session.cart.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
    const existing = db.get(
      "SELECT id FROM incomplete_orders WHERE phone = ? AND status = 'abandoned'",
      cleanPhone
    );
    if (existing) {
      db.run(
        'UPDATE incomplete_orders SET customer_name = ?, address = ?, cart_summary = ?, estimated_amount = ? WHERE id = ?',
        name || '',
        address || '',
        summary,
        est,
        existing.id
      );
    } else {
      db.run(
        'INSERT INTO incomplete_orders (customer_name, phone, address, cart_summary, estimated_amount) VALUES (?, ?, ?, ?, ?)',
        name || '',
        cleanPhone,
        address || '',
        summary,
        est
      );
    }
  }
  res.json({ ok: true });
});

// ─── Customer Checkout Page ───
router.get('/customer/checkout', (req, res) => {
  const state = computeCartTotals(req);
  const gateways = db.all('SELECT * FROM payment_gateways WHERE status = 1 ORDER BY id ASC');
  res.render('store/checkout', {
    ...state,
    gateways,
  });
});

router.post('/customer/checkout', (req, res) => {
  const {
    customer_name,
    phone,
    address,
    shipping_area,
    note,
    payment_method,
    trx_id,
    sender_number,
    cart_backup_json,
  } = req.body;

  let cart = Array.isArray(req.session.cart) ? req.session.cart : [];
  if (!cart.length && cart_backup_json) {
    try {
      const parsed = JSON.parse(cart_backup_json);
      if (Array.isArray(parsed) && parsed.length) {
        cart = parsed;
      }
    } catch (_e) {}
  }

  if (!cart.length) {
    req.flash('error', 'আপনার কার্ট খালি! প্রথমে পছন্দের পণ্য কার্টে যোগ করুন।');
    return res.redirect('/all-products');
  }

  const cleanName = String(customer_name || '').trim();
  const cleanPhone = String(phone || '').replace(/[^\d+]/g, '').trim();
  const cleanAddress = String(address || '').trim();

  if (!cleanName || cleanPhone.length < 10 || !cleanAddress) {
    req.flash('error', 'অনুগ্রহ করে আপনার পূর্ণ নাম, ১১ সংখ্যার মোবাইল নম্বর এবং সম্পূর্ণ ঠিকানা সঠিকভাবে দিন।');
    return res.redirect('/customer/checkout');
  }

  const clientIp = req.ip || '';

  // Check IP / Phone Block
  const blocked = db.get(
    'SELECT * FROM ip_blocks WHERE status = 1 AND (ip_or_phone = ? OR ip_or_phone = ?)',
    cleanPhone,
    clientIp
  );
  if (blocked) {
    req.flash('error', 'দুঃখিত, আপনার নম্বর থেকে বর্তমানে অর্ডার গ্রহণ করা সম্ভব হচ্ছে না। হটলাইনে যোগাযোগ করুন।');
    return res.redirect('/customer/checkout');
  }

  const settings = db.getSettings();
  const insideCharge = Number(settings.inside_dhaka_charge || 60);
  const outsideCharge = Number(settings.outside_dhaka_charge || 120);
  const freeMin = Number(settings.free_shipping_min || 2500);

  const subtotal = cart.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
  let shippingCharge = shipping_area === 'ঢাকার বাইরে' ? outsideCharge : insideCharge;
  if (freeMin > 0 && subtotal >= freeMin) shippingCharge = 0;

  const appliedCoupon = req.session.appliedCoupon || null;
  const discount = appliedCoupon ? Number(appliedCoupon.discount || 0) : 0;
  const totalAmount = Math.max(0, subtotal + shippingCharge - discount);

  const inv = generateInvoiceId();
  const trafficSource = detectTrafficSource(req);

  const ordRes = db.run(
    `INSERT INTO orders
    (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, discount, coupon_code,
     amount, payment_method, payment_status, trx_id, sender_number, status, traffic_source, order_type, note, is_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'website', ?, 0)`,
    inv,
    cleanName,
    cleanPhone,
    cleanAddress,
    shipping_area || 'ঢাকার ভিতরে',
    shippingCharge,
    subtotal,
    discount,
    appliedCoupon ? appliedCoupon.code : '',
    totalAmount,
    payment_method || 'ক্যাশ অন ডেলিভারি',
    trx_id ? 'verification_pending' : 'unpaid',
    trx_id || '',
    sender_number || '',
    trafficSource,
    note || ''
  );

  const orderId = ordRes.lastInsertRowid;
  for (const item of cart) {
    db.run(
      `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId,
      item.product_id,
      item.name,
      item.image,
      Number(item.price),
      Number(item.qty),
      item.size || '১ কেজি',
      item.color || ''
    );
    db.run(
      'UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?',
      Number(item.qty),
      Number(item.qty),
      item.product_id
    );
  }

  if (appliedCoupon) {
    db.run('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', appliedCoupon.code);
  }

  // Mark abandoned order resolved if any
  db.run("DELETE FROM incomplete_orders WHERE phone = ? AND status = 'abandoned'", cleanPhone);

  // Upsert customer
  const existingCust = db.get('SELECT id FROM customers WHERE phone = ?', cleanPhone);
  if (!existingCust) {
    db.run(
      'INSERT INTO customers (name, phone, address, ip_address, total_orders) VALUES (?, ?, ?, ?, 1)',
      cleanName,
      cleanPhone,
      cleanAddress,
      clientIp
    );
  } else {
    db.run(
      'UPDATE customers SET total_orders = total_orders + 1, address = ? WHERE id = ?',
      cleanAddress,
      existingCust.id
    );
  }

  req.session.cart = [];
  delete req.session.appliedCoupon;

  res.redirect(`/order-success/${inv}`);
});

router.get('/order-success/:invoiceId', (req, res) => {
  const order = db.get(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.invoice_id = ?`,
    req.params.invoiceId
  );
  if (!order) return res.redirect('/');
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  res.render('store/order-success', { order, items });
});

// Allow customer to cancel order while still pending
router.post('/order/:invoiceId/cancel', (req, res) => {
  const order = db.get('SELECT * FROM orders WHERE invoice_id = ?', req.params.invoiceId);
  if (!order) return res.redirect('/track-order');

  if (order.status !== 'pending') {
    req.flash('error', 'এই অর্ডারটি ইতিমধ্যে প্রসেসিংয়ে চলে গেছে, বাতিল করতে হটলাইনে কল করুন।');
    return res.redirect(`/track-order?q=${order.invoice_id}`);
  }

  db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  for (const it of items) {
    if (it.product_id) {
      db.run(
        'UPDATE products SET stock = stock + ?, sold_count = MAX(0, sold_count - ?) WHERE id = ?',
        Number(it.qty || 1),
        Number(it.qty || 1),
        it.product_id
      );
    }
  }
  req.flash('success', `অর্ডার #${order.invoice_id} বাতিল করা হয়েছে।`);
  res.redirect(`/track-order?q=${order.invoice_id}`);
});

// ─── Order Tracking (/track-order, /order-track, /site/order-track) ───
router.get(['/track-order', '/order-track', '/site/order-track'], (req, res) => {
  const query = String(req.query.q || '').trim().replace(/^#/, '');
  let orders = [];
  if (query) {
    orders = db.all(
      `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.color, '#f59e0b') AS status_color
       FROM orders o
       LEFT JOIN order_statuses os ON os.slug = o.status
       WHERE o.invoice_id = ? OR o.phone = ?
       ORDER BY o.id DESC`,
      query,
      query
    );
    for (const o of orders) {
      o.items = db.all('SELECT * FROM order_items WHERE order_id = ?', o.id);
    }
  }
  res.render('store/track-order', { query, orders });
});

// ─── Single Product Landing Page (/campaign/:slug) ───
router.get('/campaign/:slug', (req, res) => {
  const campaign = db.get('SELECT * FROM campaigns WHERE slug = ? AND status = 1', req.params.slug);
  if (!campaign) return res.redirect('/');
  const product = db.get('SELECT * FROM products WHERE id = ?', campaign.product_id) || db.get('SELECT * FROM products LIMIT 1');
  res.render('store/campaign', { campaign, product });
});

router.post('/campaign/:slug/order', (req, res) => {
  const campaign = db.get('SELECT * FROM campaigns WHERE slug = ?', req.params.slug);
  if (!campaign) return res.redirect('/');
  const product = db.get('SELECT * FROM products WHERE id = ?', campaign.product_id);

  const { customer_name, phone, address, shipping_area, qty } = req.body;
  const orderQty = Math.max(1, Number(qty || 1));
  const ship = shipping_area === 'ঢাকার বাইরে' ? 120 : 60;
  const subtotal = Number(campaign.offer_price) * orderQty;
  const total = subtotal + ship;
  const inv = generateInvoiceId();

  const ordRes = db.run(
    `INSERT INTO orders
    (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, amount,
     payment_method, status, traffic_source, order_type, note, is_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ক্যাশ অন ডেলিভারি', 'pending', 'Landing Page', 'landing', ?, 0)`,
    inv,
    customer_name,
    phone,
    address,
    shipping_area || 'ঢাকার ভিতরে',
    ship,
    subtotal,
    total,
    `Campaign: ${campaign.title}`
  );
  db.run(
    `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size)
     VALUES (?, ?, ?, ?, ?, ?, 'স্পেশাল প্যাক')`,
    ordRes.lastInsertRowid,
    product ? product.id : 1,
    product ? product.name : campaign.title,
    product ? product.image : campaign.banner_image,
    Number(campaign.offer_price),
    orderQty
  );
  res.redirect(`/order-success/${inv}`);
});

// ─── Blogs & CMS Pages ───
router.get('/blogs', (_req, res) => {
  const blogs = db.all('SELECT * FROM blogs WHERE status = 1 ORDER BY id DESC');
  res.render('store/page', { mode: 'blogs', blogs, page: null });
});

router.get('/blog/:slug', (req, res) => {
  const blog = db.get('SELECT * FROM blogs WHERE slug = ?', req.params.slug);
  if (!blog) return res.redirect('/blogs');
  res.render('store/page', { mode: 'blog_detail', blogs: [], page: blog });
});

router.get('/page/:slug', (req, res) => {
  const page = db.get('SELECT * FROM cms_pages WHERE slug = ?', req.params.slug);
  if (!page) return res.redirect('/');
  res.render('store/page', { mode: 'cms', blogs: [], page });
});

// ─── Customer APIs (Live Support Chat, Complaint, Reviews, Social Proof Toast, Sitemap) ───
router.post('/api/store-assistant', (req, res) => {
  const msg = String(req.body.message || '').trim();
  const q = msg.toLowerCase();

  const numMatch = msg.match(/\d{5,11}/);
  if (numMatch) {
    const token = numMatch[0];
    const ord = db.get('SELECT * FROM orders WHERE invoice_id = ? OR phone = ? ORDER BY id DESC LIMIT 1', token, token);
    if (ord) {
      return res.json({
        success: true,
        reply: `📦 অর্ডার পাওয়া গেছে!\n• ইনভয়েস: #${ord.invoice_id}\n• নাম: ${ord.customer_name}\n• মোট মূল্য: ৳${ord.amount}\n• বর্তমান স্ট্যাটাস: ${ord.status.toUpperCase()}${ord.courier_tracking_id ? '\n• কুরিয়ার ট্র্যাকিং: ' + ord.courier_tracking_id : ''}`,
      });
    }
  }

  if (q.includes('দাম') || q.includes('লিচু') || q.includes('প্রোডাক্ট') || q.includes('খুঁজুন')) {
    const prods = db.all('SELECT name, new_price FROM products WHERE status = 1 LIMIT 5');
    return res.json({
      success: true,
      reply:
        '🍒 আমাদের জনপ্রিয় তাজা ফলসমূহ:\n' +
        prods.map((p) => `• ${p.name} — ৳${p.new_price}`).join('\n') +
        '\n\nযেকোনো পণ্যের "🛒 কার্টে যোগ" বা "অর্ডার করুন" বাটনে ক্লিক করে খুব সহজেই অর্ডার করতে পারবেন!',
    });
  }

  if (q.includes('ট্র্যাক') || q.includes('track')) {
    return res.json({
      success: true,
      reply: '📦 অর্ডার ট্র্যাক করতে আপনার ৫ সংখ্যার Invoice নম্বর (যেমন: 32721) অথবা অর্ডারের মোবাইল নম্বর এখানে লিখে পাঠান!',
    });
  }

  if (q.includes('রিফান্ড') || q.includes('refund') || q.includes('রিটার্ন')) {
    return res.json({
      success: true,
      reply: '💰 রিটার্ন ও রিফান্ড নীতি: ডেলিভারি ম্যানের সামনে ফল চেক করে নিন। কোনো সমস্যা থাকলে সাথে সাথে রিটার্ন অথবা ২৪ ঘণ্টার মধ্যে জানালে ১০০% রিপ্লেসমেন্ট/রিফান্ড পাবেন।',
    });
  }

  res.json({
    success: true,
    reply:
      req.locale === 'en'
        ? 'Welcome to Mr. Tumi Grocery & Gift! 😊\nHow can we help you today?\n• Search product prices & stock\n• Enter your Invoice ID or phone number to track an order\n• Click Feedback/Complaint in the footer for support.'
        : 'স্বাগতম মি. তুমি গ্রোসারি অ্যান্ড গিফট-এ! 😊\nআপনি নিচের যেকোনো বিষয়ে জানতে পারেন:\n• পণ্যের দাম ও স্টক তথ্য জানতে নাম লিখুন\n• অর্ডার ট্র্যাক করতে ইনভয়েস বা মোবাইল নম্বর লিখুন\n• অভিযোগ বা পরামর্শ জানাতে ফুটারের সহায়তা বাটনে ক্লিক করুন।',
  });
});

router.post('/api/complaint', (req, res) => {
  const { name, phone, invoice_id, details } = req.body;
  if (!name || !phone || !details) {
    return res.status(400).json({ success: false, message: 'নাম, মোবাইল ও বিস্তারিত তথ্য আবশ্যক।' });
  }
  db.run(
    'INSERT INTO complaints (name, phone, invoice_id, details) VALUES (?, ?, ?, ?)',
    name.trim(),
    phone.trim(),
    (invoice_id || '').trim(),
    details.trim()
  );
  res.json({ success: true, message: 'আপনার অভিযোগ সফলভাবে জমা হয়েছে। আমাদের সাপোর্ট টিম দ্রুত যোগাযোগ করবে।' });
});

router.post('/api/contact', (req, res) => {
  const { name, phone, email, subject, message } = req.body;
  if (name && message) {
    db.run(
      'INSERT INTO contact_messages (name, phone, email, subject, message) VALUES (?, ?, ?, ?, ?)',
      name,
      phone || '',
      email || '',
      subject || '',
      message
    );
  }
  req.flash('success', 'আপনার বার্তা সফলভাবে পাঠানো হয়েছে!');
  res.redirect(req.get('Referrer') || '/');
});

router.post('/api/newsletter', (req, res) => {
  const val = String(req.body.email_or_phone || '').trim();
  if (val) {
    try {
      db.run('INSERT INTO newsletter_subscribers (email_or_phone) VALUES (?)', val);
    } catch (_e) {}
  }
  req.flash('success', 'নিউজলেটারে সাবস্ক্রাইব করার জন্য ধন্যবাদ!');
  res.redirect(req.get('Referrer') || '/');
});

router.post('/api/review', (req, res) => {
  const { product_id, customer_name, rating, comment } = req.body;
  if (product_id && customer_name && comment) {
    db.run(
      "INSERT INTO reviews (product_id, customer_name, rating, comment, status) VALUES (?, ?, ?, ?, 'pending')",
      Number(product_id),
      customer_name.trim(),
      Math.min(5, Math.max(1, Number(rating || 5))),
      comment.trim()
    );
    req.flash('success', 'আপনার রিভিউ জমা হয়েছে! অ্যাডমিন অনুমোদনের পর প্রদর্শিত হবে।');
  }
  res.redirect(req.get('Referrer') || '/');
});

router.get('/api/recent-verified-order', (_req, res) => {
  const s = db.getSettings();
  if (s.sale_notification_enabled === '0') {
    return res.json({ enabled: false });
  }
  const ord = db.get(
    `SELECT o.customer_name, o.address, oi.product_name, oi.product_image, p.slug
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN products p ON p.id = oi.product_id
     ORDER BY RANDOM() LIMIT 1`
  );
  if (!ord) return res.json({ enabled: false });
  res.json({
    enabled: true,
    customer: ord.customer_name,
    location: ord.address,
    product: ord.product_name,
    image: ord.product_image || '/uploads/product/lychee-fresh.jpg',
    url: ord.slug ? `/product/${ord.slug}` : '/all-products',
  });
});

router.get('/sitemap.xml', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const prods = db.all('SELECT slug FROM products WHERE status = 1');
  const cats = db.all('SELECT slug FROM categories WHERE status = 1');
  const urls = [
    `${baseUrl}/`,
    `${baseUrl}/all-products`,
    `${baseUrl}/flash-sales`,
    `${baseUrl}/hot-deals`,
    `${baseUrl}/cart`,
    ...cats.map((c) => `${baseUrl}/category/${c.slug}`),
    ...prods.map((p) => `${baseUrl}/product/${p.slug}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;
  res.type('application/xml').send(xml);
});

module.exports = router;
