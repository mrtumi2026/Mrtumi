const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { env } = require('../config/env');
const { asyncHandler } = require('../utils/asyncHandler');
const adminOrderReadRepository = require('../repositories/adminOrderReadRepository');

const router = express.Router();
router.use('/admin', requireAdmin);

function generateInvoiceId() {
  for (let i = 0; i < 10; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const exists = db.get('SELECT id FROM orders WHERE invoice_id = ?', code);
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6);
}

// ─── POS System (/admin/order/create) ───
router.get('/admin/order/create', (_req, res) => {
  const products = db.all(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 1
     ORDER BY p.id DESC`
  );
  const categories = db.all('SELECT * FROM categories WHERE status = 1 ORDER BY sort_order ASC');
  const customers = db.all('SELECT * FROM customers ORDER BY id DESC LIMIT 100');
  const couriers = db.all('SELECT * FROM courier_apis WHERE status = 1');

  res.render('admin/pos', {
    products,
    categories,
    customers,
    couriers,
  });
});

router.post('/admin/order/create', (req, res) => {
  try {
    const {
      customer_name,
      phone,
      address,
      shipping_area,
      shipping_charge,
      discount,
      payment_method,
      status,
      courier_name,
      note,
      items_json,
    } = req.body;

    const items = JSON.parse(items_json || '[]');
    if (!customer_name || !phone || !items.length) {
      req.flash('error', 'গ্রাহকের নাম, ফোন এবং কমপক্ষে ১টি প্রোডাক্ট নির্বাচন করুন।');
      return res.redirect('/admin/order/create');
    }

    const subtotal = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 1), 0);
    const ship = Number(shipping_charge || 0);
    const disc = Number(discount || 0);
    const total = Math.max(0, subtotal + ship - disc);
    const inv = generateInvoiceId();

    const orderRes = db.run(
      `INSERT INTO orders
      (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, discount, amount,
       payment_method, payment_status, status, courier_name, traffic_source, order_type, note, is_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POS', 'pos', ?, 1)`,
      inv,
      customer_name.trim(),
      phone.trim(),
      (address || 'POS Walk-in / Phone Order').trim(),
      shipping_area || 'ঢাকার ভিতরে',
      ship,
      subtotal,
      disc,
      total,
      payment_method || 'Cash On Delivery',
      payment_method === 'Cash' ? 'paid' : 'unpaid',
      status || 'processing',
      courier_name || '',
      note || ''
    );

    const orderId = orderRes.lastInsertRowid;
    for (const it of items) {
      const qty = Math.max(1, Number(it.qty || 1));
      db.run(
        `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        orderId,
        it.id || null,
        it.name,
        it.image || '/uploads/product/lychee-fresh.jpg',
        Number(it.price || 0),
        qty,
        it.size || '১ কেজি'
      );
      if (it.id) {
        db.run(
          'UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?',
          qty,
          qty,
          it.id
        );
      }
    }

    const existingCust = db.get('SELECT id FROM customers WHERE phone = ?', phone.trim());
    if (!existingCust) {
      db.run(
        'INSERT INTO customers (name, phone, address, total_orders) VALUES (?, ?, ?, 1)',
        customer_name.trim(),
        phone.trim(),
        address || ''
      );
    } else {
      db.run('UPDATE customers SET total_orders = total_orders + 1 WHERE id = ?', existingCust.id);
    }

    req.flash('success', `POS অর্ডার #${inv} সফলভাবে তৈরি হয়েছে!`);
    res.redirect(`/admin/order/view/${orderId}`);
  } catch (err) {
    console.error('POS create error:', err);
    req.flash('error', 'অর্ডার তৈরি করতে সমস্যা হয়েছে।');
    res.redirect('/admin/order/create');
  }
});

// ─── View / Process Single Order ───
router.get('/admin/order/view/:id', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    const detail = await adminOrderReadRepository.getAdminOrderDetail(req.params.id);
    if (!detail) {
      req.flash('error', 'অর্ডার খুঁজে পাওয়া যায়নি।');
      return res.redirect('/admin/order/all');
    }
    return res.render('admin/order-detail', detail);
  }
  const order = db.get(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.badge_class, 'sb-1') AS badge_class
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.id = ?`,
    req.params.id
  );
  if (!order) {
    req.flash('error', 'অর্ডার খুঁজে পাওয়া যায়নি।');
    return res.redirect('/admin/order/all');
  }
  db.run('UPDATE orders SET is_seen = 1 WHERE id = ?', order.id);

  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  const statuses = db.all('SELECT * FROM order_statuses WHERE status = 1 ORDER BY sort_order ASC');
  const couriers = db.all('SELECT * FROM courier_apis WHERE status = 1');
  const deliveryBoys = db.all('SELECT * FROM delivery_boys WHERE status = 1');
  const allProducts = db.all('SELECT id, name, new_price, sizes FROM products WHERE status = 1 ORDER BY name ASC');

  res.render('admin/order-detail', {
    order,
    items,
    statuses,
    couriers,
    deliveryBoys,
    allProducts,
  });
}));

function recalcOrderTotals(orderId) {
  const ord = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!ord) return;
  const rows = db.all('SELECT price, qty FROM order_items WHERE order_id = ?', orderId);
  const subtotal = rows.reduce((s, r) => s + Number(r.price || 0) * Number(r.qty || 1), 0);
  const total = Math.max(0, subtotal + Number(ord.shipping_charge || 0) - Number(ord.discount || 0));
  db.run('UPDATE orders SET subtotal = ?, amount = ? WHERE id = ?', subtotal, total, orderId);
}

router.post('/admin/order/:id/item-add', (req, res) => {
  const orderId = Number(req.params.id);
  const prod = db.get('SELECT * FROM products WHERE id = ?', Number(req.body.product_id));
  const qty = Math.max(1, Number(req.body.qty || 1));
  if (prod) {
    const existing = db.get(
      'SELECT * FROM order_items WHERE order_id = ? AND product_id = ?',
      orderId,
      prod.id
    );
    if (existing) {
      db.run('UPDATE order_items SET qty = qty + ? WHERE id = ?', qty, existing.id);
    } else {
      db.run(
        `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        orderId,
        prod.id,
        prod.name,
        prod.image,
        Number(prod.new_price),
        qty,
        (prod.sizes || '১ কেজি').split(',')[0].trim()
      );
    }
    db.run('UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?', qty, qty, prod.id);
    recalcOrderTotals(orderId);
    req.flash('success', `"${prod.name}" অর্ডারে যোগ করা হয়েছে!`);
  }
  res.redirect(`/admin/order/view/${orderId}`);
});

router.post('/admin/order/:id/item-update/:itemId', (req, res) => {
  const orderId = Number(req.params.id);
  const item = db.get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', req.params.itemId, orderId);
  if (item) {
    const newQty = Number(req.body.qty);
    if (newQty <= 0) {
      db.run('DELETE FROM order_items WHERE id = ?', item.id);
      if (item.product_id) {
        db.run('UPDATE products SET stock = stock + ? WHERE id = ?', Number(item.qty), item.product_id);
      }
    } else {
      const diff = newQty - Number(item.qty);
      db.run('UPDATE order_items SET qty = ? WHERE id = ?', newQty, item.id);
      if (item.product_id && diff !== 0) {
        db.run('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?', diff, item.product_id);
      }
    }
    recalcOrderTotals(orderId);
    req.flash('success', 'অর্ডারের পণ্যের পরিমাণ আপডেট হয়েছে।');
  }
  res.redirect(`/admin/order/view/${orderId}`);
});

router.post('/admin/order/:id/send-courier', (req, res) => {
  const order = db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (order) {
    const courierName = String(req.body.courier_name || 'Steadfast Courier');
    const trk = `${courierName.slice(0, 3).toUpperCase()}-${order.invoice_id}-${Math.floor(100 + Math.random() * 900)}`;
    db.run(
      "UPDATE orders SET status = 'in-courier', courier_name = ?, courier_tracking_id = ?, is_seen = 1 WHERE id = ?",
      courierName,
      trk,
      order.id
    );
    req.flash('success', `অর্ডার #${order.invoice_id} সফলভাবে ${courierName}-এ বুকিং হয়েছে! Tracking: ${trk}`);
  }
  res.redirect(`/admin/order/view/${req.params.id}`);
});

// ─── Printable Invoice ───
router.get('/admin/order/invoice/:id', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    const invoice = await adminOrderReadRepository.getAdminInvoice(req.params.id);
    if (!invoice) return res.redirect('/admin/order/all');
    return res.render('admin/order-invoice', invoice);
  }
  const order = db.get(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.id = ?`,
    req.params.id
  );
  if (!order) return res.redirect('/admin/order/all');
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  return res.render('admin/order-invoice', { order, items });
}));

// ─── Update Order ───
router.post('/admin/order/update/:id', (req, res) => {
  const order = db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.redirect('/admin/order/all');

  const {
    customer_name,
    phone,
    address,
    shipping_charge,
    discount,
    status,
    payment_status,
    courier_name,
    courier_tracking_id,
    delivery_boy_id,
    admin_note,
  } = req.body;

  const ship = Number(shipping_charge ?? order.shipping_charge);
  const disc = Number(discount ?? order.discount);
  const total = Math.max(0, Number(order.subtotal) + ship - disc);

  let tracking = courier_tracking_id || order.courier_tracking_id || '';
  if (courier_name && !tracking && status === 'in-courier') {
    tracking = `${courier_name.slice(0, 3).toUpperCase()}-${order.invoice_id}-${Math.floor(100 + Math.random() * 900)}`;
  }

  db.run(
    `UPDATE orders
     SET customer_name = ?, phone = ?, address = ?, shipping_charge = ?, discount = ?, amount = ?,
         status = ?, payment_status = ?, courier_name = ?, courier_tracking_id = ?, delivery_boy_id = ?, admin_note = ?
     WHERE id = ?`,
    customer_name || order.customer_name,
    phone || order.phone,
    address || order.address,
    ship,
    disc,
    total,
    status || order.status,
    payment_status || order.payment_status,
    courier_name || '',
    tracking,
    delivery_boy_id ? Number(delivery_boy_id) : null,
    admin_note || '',
    order.id
  );
  creditEarningsOnOrderCompleted(order, status || order.status);

  req.flash('success', `অর্ডার #${order.invoice_id} সফলভাবে আপডেট হয়েছে!`);
  res.redirect(`/admin/order/view/${order.id}`);
});

// ─── Quick Status Change & Bulk Actions ───
function creditEarningsOnOrderCompleted(prevOrder, newStatus) {
  if (!prevOrder || prevOrder.status === 'completed' || newStatus !== 'completed') return;

  // 1. Credit Reseller Profit if reseller order
  if (prevOrder.reseller_id && Number(prevOrder.reseller_profit || 0) > 0) {
    db.run(
      'UPDATE resellers SET balance = balance + ? WHERE id = ?',
      Number(prevOrder.reseller_profit),
      prevOrder.reseller_id
    );
  }

  // 2. Credit Vendor Earnings (minus commission) for vendor items in this order
  const items = db.all(
    `SELECT oi.price, oi.qty, p.vendor_id, v.commission_rate
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     JOIN vendors v ON v.id = p.vendor_id
     WHERE oi.order_id = ? AND p.vendor_id IS NOT NULL`,
    prevOrder.id
  );
  for (const it of items) {
    const gross = Number(it.price || 0) * Number(it.qty || 1);
    const comm = (gross * Number(it.commission_rate || 10)) / 100;
    const net = Math.max(0, Math.round(gross - comm));
    db.run('UPDATE vendors SET balance = balance + ? WHERE id = ?', net, it.vendor_id);
  }
}

router.post('/admin/order/status-quick', (req, res) => {
  const { order_id, status } = req.body;
  if (order_id && status) {
    const prev = db.get('SELECT * FROM orders WHERE id = ?', order_id);
    db.run('UPDATE orders SET status = ?, is_seen = 1 WHERE id = ?', status, order_id);
    creditEarningsOnOrderCompleted(prev, status);
    req.flash('success', 'অর্ডার স্ট্যাটাস পরিবর্তন হয়েছে।');
  }
  res.redirect(req.get('Referrer') || '/admin/order/all');
});

router.post('/admin/order/bulk-action', (req, res) => {
  let ids = req.body.order_ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map((x) => Number(x)).filter(Boolean);

  const action = String(req.body.bulk_action || '');
  if (!ids.length || !action) {
    req.flash('error', 'অর্ডার এবং অ্যাকশন নির্বাচন করুন।');
    return res.redirect(req.get('Referrer') || '/admin/order/all');
  }

  if (action === 'delete') {
    for (const id of ids) {
      db.run('DELETE FROM order_items WHERE order_id = ?', id);
      db.run('DELETE FROM orders WHERE id = ?', id);
    }
    req.flash('success', `${ids.length} টি অর্ডার ডিলিট করা হয়েছে।`);
  } else if (action.startsWith('courier:')) {
    const courierName = action.split(':')[1];
    for (const id of ids) {
      const ord = db.get('SELECT invoice_id FROM orders WHERE id = ?', id);
      const trk = `${courierName.slice(0, 3).toUpperCase()}-${ord ? ord.invoice_id : id}-${Math.floor(100 + Math.random() * 900)}`;
      db.run(
        "UPDATE orders SET status = 'in-courier', courier_name = ?, courier_tracking_id = ?, is_seen = 1 WHERE id = ?",
        courierName,
        trk,
        id
      );
    }
    req.flash('success', `${ids.length} টি অর্ডার সফলভাবে ${courierName}-এ পাঠানো হয়েছে!`);
  } else {
    for (const id of ids) {
      db.run('UPDATE orders SET status = ?, is_seen = 1 WHERE id = ?', action, id);
    }
    req.flash('success', `${ids.length} টি অর্ডারের স্ট্যাটাস আপডেট হয়েছে!`);
  }

  res.redirect(req.get('Referrer') || '/admin/order/all');
});

router.post('/admin/order/delete/:id', (req, res) => {
  db.run('DELETE FROM order_items WHERE order_id = ?', req.params.id);
  db.run('DELETE FROM orders WHERE id = ?', req.params.id);
  req.flash('success', 'অর্ডার সফলভাবে মুছে ফেলা হয়েছে।');
  res.redirect(req.get('Referrer') || '/admin/order/all');
});

// ─── Reseller Orders ───
router.get('/admin/reseller-orders', (req, res) => {
  const orders = db.all(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.badge_class, 'sb-1') AS badge_class
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.order_type = 'reseller' OR o.reseller_id IS NOT NULL
     ORDER BY o.id DESC`
  );
  const statuses = db.all('SELECT * FROM order_statuses WHERE status = 1 ORDER BY sort_order ASC');
  res.render('admin/orders', {
    pageTitle: 'Reseller Orders',
    statusFilter: 'reseller',
    orders,
    statuses,
    searchQuery: '',
    statusCounts: {},
  });
});

// ─── Incomplete Orders ───
router.get('/admin/incomplete-orders', (_req, res) => {
  const rows = db.all('SELECT * FROM incomplete_orders ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Incomplete / Abandoned Orders',
    subtitle: 'চেকআউট ফর্ম পূরণ শুরু করে অসম্পূর্ণ রাখা অর্ডারসমূহ (এক ক্লিকে অর্ডারে রূপান্তর করুন)',
    createAction: '/admin/incomplete-orders/create',
    deletePrefix: '/admin/incomplete-orders/delete',
    customActionPrefix: '/admin/incomplete-orders/convert',
    customActionLabel: 'Convert to Order',
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'cart_summary', label: 'Items' },
      { key: 'estimated_amount', label: 'Amount (৳)', type: 'currency' },
      { key: 'status', label: 'Status', type: 'badge' },
      { key: 'created_at', label: 'Captured At' },
    ],
    fields: [
      { name: 'customer_name', label: 'Customer Name', type: 'text', required: true },
      { name: 'phone', label: 'Phone Number', type: 'text', required: true },
      { name: 'address', label: 'Address', type: 'text' },
      { name: 'cart_summary', label: 'Cart Items', type: 'text', required: true },
      { name: 'estimated_amount', label: 'Estimated Amount (৳)', type: 'number', required: true },
    ],
    rows,
  });
});

router.post('/admin/incomplete-orders/create', (req, res) => {
  const { customer_name, phone, address, cart_summary, estimated_amount } = req.body;
  db.run(
    'INSERT INTO incomplete_orders (customer_name, phone, address, cart_summary, estimated_amount) VALUES (?, ?, ?, ?, ?)',
    customer_name || 'Guest',
    phone || '',
    address || '',
    cart_summary || '',
    Number(estimated_amount || 0)
  );
  req.flash('success', 'Incomplete order record যোগ করা হয়েছে।');
  res.redirect('/admin/incomplete-orders');
});

router.post('/admin/incomplete-orders/convert/:id', (req, res) => {
  const inc = db.get('SELECT * FROM incomplete_orders WHERE id = ?', req.params.id);
  if (inc) {
    const inv = generateInvoiceId();
    const amt = Number(inc.estimated_amount || 500);
    const ordRes = db.run(
      `INSERT INTO orders
      (invoice_id, customer_name, phone, address, subtotal, amount, status, traffic_source, note, is_seen)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'Abandoned Recovery', ?, 1)`,
      inv,
      inc.customer_name || 'Recovered Customer',
      inc.phone,
      inc.address || 'ঢাকা',
      amt,
      amt + 60,
      `Recovered from Incomplete Order: ${inc.cart_summary}`
    );
    db.run(
      `INSERT INTO order_items (order_id, product_id, product_name, price, qty)
       VALUES (?, 1, ?, ?, 1)`,
      ordRes.lastInsertRowid,
      inc.cart_summary || 'দেশি লিচু ফ্রেশ প্যাক',
      amt
    );
    db.run("UPDATE incomplete_orders SET status = 'converted' WHERE id = ?", inc.id);
    req.flash('success', `অর্ডার #${inv} হিসেবে সফলভাবে কনভার্ট করা হয়েছে!`);
  }
  res.redirect('/admin/incomplete-orders');
});

router.post('/admin/incomplete-orders/delete/:id', (req, res) => {
  db.run('DELETE FROM incomplete_orders WHERE id = ?', req.params.id);
  req.flash('success', 'রেকর্ড মুছে ফেলা হয়েছে।');
  res.redirect('/admin/incomplete-orders');
});

// ─── Order Status Manage ───
router.get('/admin/orderstatus/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM order_statuses ORDER BY sort_order ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Order Status Management',
    subtitle: 'অর্ডার প্রসেসিং স্ট্যাটাস ও ব্যাজ কালার কাস্টমাইজ করুন',
    createAction: '/admin/orderstatus/create',
    deletePrefix: '/admin/orderstatus/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Status Name' },
      { key: 'slug', label: 'Slug' },
      { key: 'color', label: 'Color', type: 'color' },
      { key: 'sort_order', label: 'Sort Order' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Status Name', type: 'text', required: true },
      { name: 'slug', label: 'Slug (e.g. hold)', type: 'text', required: true },
      { name: 'color', label: 'Color Hex', type: 'color', value: '#3b82f6' },
      { name: 'sort_order', label: 'Sort Order', type: 'number', value: '8' },
    ],
    rows,
  });
});

router.post('/admin/orderstatus/create', (req, res) => {
  const { name, slug, color, sort_order } = req.body;
  const cleanSlug = String(slug || name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  db.run(
    'INSERT INTO order_statuses (name, slug, color, sort_order) VALUES (?, ?, ?, ?)',
    name,
    cleanSlug,
    color || '#3b82f6',
    Number(sort_order || 8)
  );
  req.flash('success', 'নতুন অর্ডার স্ট্যাটাস তৈরি হয়েছে।');
  res.redirect('/admin/orderstatus/manage');
});

router.post('/admin/orderstatus/delete/:id', (req, res) => {
  db.run('DELETE FROM order_statuses WHERE id = ?', req.params.id);
  req.flash('success', 'স্ট্যাটাস ডিলিট হয়েছে।');
  res.redirect('/admin/orderstatus/manage');
});

// ─── IP / Phone Block ───
router.get('/admin/customer/ip-block', (_req, res) => {
  const rows = db.all('SELECT * FROM ip_blocks ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'IP & Phone Block List',
    subtitle: 'ফেইক অর্ডার প্রতিরোধে সন্দেহজনক IP অ্যাড্রেস অথবা মোবাইল নম্বর ব্লক করুন',
    createAction: '/admin/customer/ip-block/create',
    deletePrefix: '/admin/customer/ip-block/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'ip_or_phone', label: 'Blocked IP / Phone' },
      { key: 'reason', label: 'Reason' },
      { key: 'status', label: 'Active', type: 'status' },
      { key: 'created_at', label: 'Blocked At' },
    ],
    fields: [
      { name: 'ip_or_phone', label: 'IP Address or Phone Number', type: 'text', required: true },
      { name: 'reason', label: 'Block Reason', type: 'text', value: 'Repeated fake orders' },
    ],
    rows,
  });
});

router.post('/admin/customer/ip-block/create', (req, res) => {
  db.run(
    'INSERT INTO ip_blocks (ip_or_phone, reason) VALUES (?, ?)',
    String(req.body.ip_or_phone || '').trim(),
    req.body.reason || 'Fake order prevention'
  );
  req.flash('success', 'IP / মোবাইল নম্বর সফলভাবে ব্লক তালিকায় যুক্ত হয়েছে।');
  res.redirect('/admin/customer/ip-block');
});

router.post('/admin/customer/ip-block/delete/:id', (req, res) => {
  db.run('DELETE FROM ip_blocks WHERE id = ?', req.params.id);
  req.flash('success', 'ব্লক তালিকা থেকে সরানো হয়েছে।');
  res.redirect('/admin/customer/ip-block');
});

// ─── Refunds ───
router.get('/admin/refunds', (req, res) => {
  const statusFilter = req.query.status || '';
  const rows = statusFilter
    ? db.all('SELECT * FROM refunds WHERE status = ? ORDER BY id DESC', statusFilter)
    : db.all('SELECT * FROM refunds ORDER BY id DESC');

  res.render('admin/crud-module', {
    pageTitle: statusFilter ? `Refunds (${statusFilter.toUpperCase()})` : 'All Refunds',
    subtitle: 'কাস্টমার রিফান্ড রিকোয়েস্ট যাচাই, অ্যাপ্রুভ এবং প্রসেস করুন',
    createAction: '/admin/refunds/create',
    deletePrefix: '/admin/refunds/delete',
    customActionPrefix: '/admin/refunds/advance',
    customActionLabel: 'Approve / Process',
    columns: [
      { key: 'id', label: '#' },
      { key: 'invoice_id', label: 'Invoice #' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'phone', label: 'Phone' },
      { key: 'amount', label: 'Refund Amount', type: 'currency' },
      { key: 'method', label: 'Method' },
      { key: 'reason', label: 'Reason' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    fields: [
      { name: 'invoice_id', label: 'Order Invoice #', type: 'text', required: true },
      { name: 'customer_name', label: 'Customer Name', type: 'text', required: true },
      { name: 'phone', label: 'Phone Number', type: 'text', required: true },
      { name: 'amount', label: 'Amount (৳)', type: 'number', required: true },
      { name: 'method', label: 'Refund Method (bKash/Nagad/Bank)', type: 'text', value: 'bKash' },
      { name: 'reason', label: 'Reason', type: 'textarea', required: true },
    ],
    rows,
  });
});

router.post('/admin/refunds/create', (req, res) => {
  const { invoice_id, customer_name, phone, amount, method, reason } = req.body;
  db.run(
    'INSERT INTO refunds (invoice_id, customer_name, phone, amount, method, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    invoice_id,
    customer_name,
    phone,
    Number(amount || 0),
    method || 'bKash',
    reason || '',
    'pending'
  );
  req.flash('success', 'রিফান্ড রিকোয়েস্ট তৈরি হয়েছে।');
  res.redirect('/admin/refunds');
});

router.post('/admin/refunds/advance/:id', (req, res) => {
  const ref = db.get('SELECT * FROM refunds WHERE id = ?', req.params.id);
  if (ref) {
    const nextStatus =
      ref.status === 'pending' ? 'approved' : ref.status === 'approved' ? 'processed' : 'processed';
    db.run('UPDATE refunds SET status = ? WHERE id = ?', nextStatus, ref.id);
    req.flash('success', `রিফান্ড স্ট্যাটাস "${nextStatus.toUpperCase()}" করা হয়েছে।`);
  }
  res.redirect(req.get('Referrer') || '/admin/refunds');
});

router.post('/admin/refunds/delete/:id', (req, res) => {
  db.run('DELETE FROM refunds WHERE id = ?', req.params.id);
  req.flash('success', 'রিফান্ড রেকর্ড ডিলিট হয়েছে।');
  res.redirect('/admin/refunds');
});

// ─── Orders List by Status (/admin/order/:status) ───
router.get('/admin/order/:status', asyncHandler(async (req, res) => {
  const statusParam = req.params.status;
  const q = String(req.query.q || '').trim();
  const titleMap = {
    all: 'All Orders',
    pending: 'Pending Orders',
    processing: 'Processing Orders',
    'on-the-way': 'On The Way Orders',
    'in-courier': 'In Courier Orders',
    completed: 'Completed Orders',
    unpaid: 'Unpaid Orders',
    cancelled: 'Cancelled Orders',
  };

  if (env.db.client === 'mysql') {
    const data = await adminOrderReadRepository.listAdminOrders({ statusParam, searchQuery: q });
    return res.render('admin/orders', {
      pageTitle: titleMap[statusParam] || `Orders (${statusParam})`,
      statusFilter: statusParam,
      searchQuery: q,
      ...data,
    });
  }

  let where = 'WHERE 1=1';
  const params = [];
  if (statusParam && statusParam !== 'all') {
    if (statusParam === 'unpaid') {
      where += " AND (o.payment_status = 'unpaid' OR o.status = 'unpaid')";
    } else {
      where += ' AND o.status = ?';
      params.push(statusParam);
    }
  }
  if (q) {
    where += ' AND (o.invoice_id LIKE ? OR o.customer_name LIKE ? OR o.phone LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const orders = db.all(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.badge_class, 'sb-1') AS badge_class
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     ${where}
     ORDER BY o.id DESC`,
    ...params
  );
  const statuses = db.all('SELECT * FROM order_statuses WHERE status = 1 ORDER BY sort_order ASC');
  const countRows = db.all('SELECT status, COUNT(*) AS c FROM orders GROUP BY status');
  const statusCounts = { all: db.get('SELECT COUNT(*) AS c FROM orders').c };
  for (const row of countRows) statusCounts[row.status] = row.c;
  return res.render('admin/orders', {
    pageTitle: titleMap[statusParam] || `Orders (${statusParam})`,
    statusFilter: statusParam,
    orders,
    statuses,
    searchQuery: q,
    statusCounts,
  });
}));

module.exports = router;
