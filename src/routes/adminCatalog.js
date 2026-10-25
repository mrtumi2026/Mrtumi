const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();
router.use('/admin', requireAdmin);

function makeSlug(str) {
  const base = String(str || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '');
  return base || `item-${Date.now()}`;
}

// ─── Product Lists ───
function renderProductList(req, res, mode, pageTitle) {
  const q = String(req.query.q || '').trim();
  let where = 'WHERE 1=1';
  const params = [];

  if (mode === 'inhouse') where += ' AND p.vendor_id IS NULL';
  if (mode === 'vendor') where += ' AND p.vendor_id IS NOT NULL';
  if (mode === 'pending') where += " AND p.approval_status = 'pending'";
  if (mode === 'wholesale') where += ' AND (p.is_wholesale = 1 OR p.wholesale_price > 0)';

  if (q) {
    where += ' AND (p.name LIKE ? OR p.code LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }

  const products = db.all(
    `SELECT p.*, c.name AS category_name, v.shop_name AS vendor_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN vendors v ON v.id = p.vendor_id
     ${where}
     ORDER BY p.id DESC`,
    ...params
  );

  res.render('admin/products', {
    pageTitle,
    mode,
    products,
    searchQuery: q,
  });
}

router.get('/admin/inhouse-products/manage', (req, res) =>
  renderProductList(req, res, 'inhouse', 'All Inhouse Products')
);
router.get('/admin/products/manage', (req, res) =>
  renderProductList(req, res, 'vendor', 'All Vendor Products')
);
router.get('/admin/products/pending', (req, res) =>
  renderProductList(req, res, 'pending', 'Pending Approval Products')
);
router.get('/admin/products/wholesale', (req, res) =>
  renderProductList(req, res, 'wholesale', 'Wholesale Products')
);

// ─── Create / Edit Product ───
router.get('/admin/products/create', (_req, res) => {
  res.render('admin/product-form', {
    pageTitle: 'Add New Product',
    product: null,
    categories: db.all('SELECT * FROM categories ORDER BY sort_order ASC'),
    brands: db.all('SELECT * FROM brands ORDER BY id ASC'),
    vendors: db.all('SELECT * FROM vendors ORDER BY id ASC'),
  });
});

router.post('/admin/products/create', upload.single('image_file'), (req, res) => {
  const b = req.body;
  const img = req.file
    ? `/uploads/custom/${req.file.filename}`
    : b.image_url || '/uploads/product/lychee-fresh.jpg';
  const code = b.code || `P0${Math.floor(250 + Math.random() * 700)}`;
  const slug = `${makeSlug(b.name)}-${Date.now().toString().slice(-4)}`;

  db.run(
    `INSERT INTO products
    (name, slug, code, category_id, brand_id, vendor_id, old_price, new_price, purchase_price,
     wholesale_price, wholesale_min_qty, stock, unit, sizes, colors, image, short_desc, description,
     is_flash_sale, is_hot_deal, is_wholesale, approval_status, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`,
    b.name,
    slug,
    code,
    Number(b.category_id || 1),
    Number(b.brand_id || 1),
    b.vendor_id ? Number(b.vendor_id) : null,
    Number(b.old_price || 0),
    Number(b.new_price || 0),
    Number(b.purchase_price || 0),
    Number(b.wholesale_price || 0),
    Number(b.wholesale_min_qty || 0),
    Number(b.stock || 0),
    b.unit || 'কেজি',
    b.sizes || '৫০০ গ্রাম,১ কেজি,২ কেজি',
    b.colors || '',
    img,
    b.short_desc || '',
    b.description || '',
    b.is_flash_sale ? 1 : 0,
    b.is_hot_deal ? 1 : 0,
    b.is_wholesale || Number(b.wholesale_price || 0) > 0 ? 1 : 0,
    b.status === '0' ? 0 : 1
  );

  req.flash('success', `প্রোডাক্ট "${b.name}" সফলভাবে যোগ করা হয়েছে!`);
  res.redirect('/admin/inhouse-products/manage');
});

router.get('/admin/products/edit/:id', (req, res) => {
  const product = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
  if (!product) return res.redirect('/admin/inhouse-products/manage');

  res.render('admin/product-form', {
    pageTitle: `Edit Product — ${product.name}`,
    product,
    categories: db.all('SELECT * FROM categories ORDER BY sort_order ASC'),
    brands: db.all('SELECT * FROM brands ORDER BY id ASC'),
    vendors: db.all('SELECT * FROM vendors ORDER BY id ASC'),
  });
});

router.post('/admin/products/edit/:id', upload.single('image_file'), (req, res) => {
  const existing = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
  if (!existing) return res.redirect('/admin/inhouse-products/manage');

  const b = req.body;
  const img = req.file
    ? `/uploads/custom/${req.file.filename}`
    : b.image_url || existing.image;

  db.run(
    `UPDATE products SET
      name = ?, code = ?, category_id = ?, brand_id = ?, vendor_id = ?,
      old_price = ?, new_price = ?, purchase_price = ?, wholesale_price = ?, wholesale_min_qty = ?,
      stock = ?, unit = ?, sizes = ?, colors = ?, image = ?, short_desc = ?, description = ?,
      is_flash_sale = ?, is_hot_deal = ?, is_wholesale = ?, status = ?
     WHERE id = ?`,
    b.name || existing.name,
    b.code || existing.code,
    Number(b.category_id || existing.category_id),
    Number(b.brand_id || existing.brand_id),
    b.vendor_id ? Number(b.vendor_id) : null,
    Number(b.old_price || 0),
    Number(b.new_price || 0),
    Number(b.purchase_price || 0),
    Number(b.wholesale_price || 0),
    Number(b.wholesale_min_qty || 0),
    Number(b.stock || 0),
    b.unit || 'কেজি',
    b.sizes || '',
    b.colors || '',
    img,
    b.short_desc || '',
    b.description || '',
    b.is_flash_sale ? 1 : 0,
    b.is_hot_deal ? 1 : 0,
    b.is_wholesale || Number(b.wholesale_price || 0) > 0 ? 1 : 0,
    b.status === '0' ? 0 : 1,
    existing.id
  );

  req.flash('success', 'প্রোডাক্ট তথ্য সফলভাবে আপডেট হয়েছে!');
  res.redirect('/admin/inhouse-products/manage');
});

router.post('/admin/products/toggle/:id', (req, res) => {
  const p = db.get('SELECT id, status FROM products WHERE id = ?', req.params.id);
  if (p) {
    db.run('UPDATE products SET status = ? WHERE id = ?', p.status ? 0 : 1, p.id);
    req.flash('success', 'প্রোডাক্ট স্ট্যাটাস পরিবর্তন হয়েছে।');
  }
  res.redirect(req.get('Referrer') || '/admin/inhouse-products/manage');
});

router.post('/admin/products/approve/:id', (req, res) => {
  db.run("UPDATE products SET approval_status = 'approved', status = 1 WHERE id = ?", req.params.id);
  req.flash('success', 'প্রোডাক্ট সফলভাবে Approve করা হয়েছে!');
  res.redirect(req.get('Referrer') || '/admin/products/pending');
});

router.post('/admin/products/delete/:id', (req, res) => {
  db.run('DELETE FROM products WHERE id = ?', req.params.id);
  req.flash('success', 'প্রোডাক্ট ডিলিট করা হয়েছে।');
  res.redirect(req.get('Referrer') || '/admin/inhouse-products/manage');
});

// ─── Categories, Subcategories, Childcategories, Brands, Colors, Sizes ───
router.get('/admin/categories/manage', (_req, res) => {
  const rows = db.all(
    `SELECT c.*, COUNT(p.id) AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id
     GROUP BY c.id ORDER BY c.sort_order ASC, c.id ASC`
  );
  res.render('admin/crud-module', {
    pageTitle: 'Product Categories',
    subtitle: 'প্রোডাক্ট ক্যাটাগরি তৈরি, সম্পাদনা ও সাজিয়ে নিন',
    createAction: '/admin/categories/create',
    deletePrefix: '/admin/categories/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'icon', label: 'Icon' },
      { key: 'name', label: 'Category Name' },
      { key: 'slug', label: 'Slug' },
      { key: 'product_count', label: 'Products', type: 'badge' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Category Name (বাংলা / English)', type: 'text', required: true },
      { name: 'slug', label: 'URL Slug (optional)', type: 'text' },
      { name: 'icon', label: 'Emoji / Icon', type: 'text', value: '🍒' },
      { name: 'sort_order', label: 'Sort Order', type: 'number', value: '1' },
    ],
    rows,
  });
});

router.post('/admin/categories/create', (req, res) => {
  const { name, slug, icon, sort_order } = req.body;
  db.run(
    'INSERT INTO categories (name, slug, icon, sort_order) VALUES (?, ?, ?, ?)',
    name,
    slug ? makeSlug(slug) : `${makeSlug(name)}-${Date.now().toString().slice(-3)}`,
    icon || '🍒',
    Number(sort_order || 1)
  );
  req.flash('success', 'নতুন ক্যাটাগরি যুক্ত হয়েছে!');
  res.redirect('/admin/categories/manage');
});

router.post('/admin/categories/delete/:id', (req, res) => {
  db.run('DELETE FROM categories WHERE id = ?', req.params.id);
  req.flash('success', 'ক্যাটাগরি মুছে ফেলা হয়েছে।');
  res.redirect('/admin/categories/manage');
});

// Subcategories
router.get('/admin/subcategories/manage', (_req, res) => {
  const rows = db.all(
    `SELECT s.*, c.name AS category_name
     FROM subcategories s
     LEFT JOIN categories c ON c.id = s.category_id
     ORDER BY s.id DESC`
  );
  const cats = db.all('SELECT id, name FROM categories ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Subcategories',
    subtitle: 'ক্যাটাগরির অধীনে সাব-ক্যাটাগরি ব্যবস্থাপনা',
    createAction: '/admin/subcategories/create',
    deletePrefix: '/admin/subcategories/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Subcategory Name' },
      { key: 'category_name', label: 'Parent Category' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      {
        name: 'category_id',
        label: 'Parent Category',
        type: 'select',
        options: cats.map((c) => ({ value: c.id, label: c.name })),
        required: true,
      },
      { name: 'name', label: 'Subcategory Name', type: 'text', required: true },
    ],
    rows,
  });
});

router.post('/admin/subcategories/create', (req, res) => {
  db.run(
    'INSERT INTO subcategories (category_id, name, slug) VALUES (?, ?, ?)',
    Number(req.body.category_id || 1),
    req.body.name,
    makeSlug(req.body.name)
  );
  req.flash('success', 'সাব-ক্যাটাগরি তৈরি হয়েছে।');
  res.redirect('/admin/subcategories/manage');
});

router.post('/admin/subcategories/delete/:id', (req, res) => {
  db.run('DELETE FROM subcategories WHERE id = ?', req.params.id);
  req.flash('success', 'সাব-ক্যাটাগরি ডিলিট হয়েছে।');
  res.redirect('/admin/subcategories/manage');
});

// Childcategories
router.get('/admin/childcategories/manage', (_req, res) => {
  const rows = db.all(
    `SELECT ch.*, s.name AS subcategory_name
     FROM childcategories ch
     LEFT JOIN subcategories s ON s.id = ch.subcategory_id
     ORDER BY ch.id DESC`
  );
  const subs = db.all('SELECT id, name FROM subcategories ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Childcategories',
    subtitle: 'সাব-ক্যাটাগরির অধীনে চাইল্ড-ক্যাটাগরি ব্যবস্থাপনা',
    createAction: '/admin/childcategories/create',
    deletePrefix: '/admin/childcategories/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Childcategory Name' },
      { key: 'subcategory_name', label: 'Subcategory' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      {
        name: 'subcategory_id',
        label: 'Parent Subcategory',
        type: 'select',
        options: subs.map((s) => ({ value: s.id, label: s.name })),
        required: true,
      },
      { name: 'name', label: 'Childcategory Name', type: 'text', required: true },
    ],
    rows,
  });
});

router.post('/admin/childcategories/create', (req, res) => {
  db.run(
    'INSERT INTO childcategories (subcategory_id, name, slug) VALUES (?, ?, ?)',
    Number(req.body.subcategory_id || 1),
    req.body.name,
    makeSlug(req.body.name)
  );
  req.flash('success', 'চাইল্ড-ক্যাটাগরি তৈরি হয়েছে।');
  res.redirect('/admin/childcategories/manage');
});

router.post('/admin/childcategories/delete/:id', (req, res) => {
  db.run('DELETE FROM childcategories WHERE id = ?', req.params.id);
  req.flash('success', 'চাইল্ড-ক্যাটাগরি ডিলিট হয়েছে।');
  res.redirect('/admin/childcategories/manage');
});

// Brands
router.get('/admin/brands/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM brands ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Brands',
    subtitle: 'প্রোডাক্ট ব্র্যান্ড ও অর্গানিক ফার্ম পার্টনার তালিকা',
    createAction: '/admin/brands/create',
    deletePrefix: '/admin/brands/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Brand Name' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [{ name: 'name', label: 'Brand Name', type: 'text', required: true }],
    rows,
  });
});

router.post('/admin/brands/create', (req, res) => {
  db.run('INSERT INTO brands (name, slug) VALUES (?, ?)', req.body.name, makeSlug(req.body.name));
  req.flash('success', 'ব্র্যান্ড যুক্ত হয়েছে।');
  res.redirect('/admin/brands/manage');
});

router.post('/admin/brands/delete/:id', (req, res) => {
  db.run('DELETE FROM brands WHERE id = ?', req.params.id);
  req.flash('success', 'ব্র্যান্ড ডিলিট হয়েছে।');
  res.redirect('/admin/brands/manage');
});

// Colors
router.get('/admin/color/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM colors ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Product Colors',
    subtitle: 'প্রোডাক্ট ভ্যারিয়েন্ট কালার তালিকা',
    createAction: '/admin/color/create',
    deletePrefix: '/admin/color/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Color Name' },
      { key: 'hex_code', label: 'Preview', type: 'color' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Color Name', type: 'text', required: true },
      { name: 'hex_code', label: 'Hex Code', type: 'color', value: '#e11d48' },
    ],
    rows,
  });
});

router.post('/admin/color/create', (req, res) => {
  db.run('INSERT INTO colors (name, hex_code) VALUES (?, ?)', req.body.name, req.body.hex_code || '#dc2626');
  req.flash('success', 'কালার যুক্ত হয়েছে।');
  res.redirect('/admin/color/manage');
});

router.post('/admin/color/delete/:id', (req, res) => {
  db.run('DELETE FROM colors WHERE id = ?', req.params.id);
  req.flash('success', 'কালার ডিলিট হয়েছে।');
  res.redirect('/admin/color/manage');
});

// Sizes / Weights
router.get('/admin/size/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM sizes ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Sizes / Weight Packs',
    subtitle: 'ওজন ও প্যাক সাইজ ভ্যারিয়েন্ট (যেমন ৫০০ গ্রাম, ১ কেজি, ২ কেজি)',
    createAction: '/admin/size/create',
    deletePrefix: '/admin/size/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Size / Pack Label' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [{ name: 'name', label: 'Size / Weight Label', type: 'text', required: true }],
    rows,
  });
});

router.post('/admin/size/create', (req, res) => {
  db.run('INSERT INTO sizes (name) VALUES (?)', req.body.name);
  req.flash('success', 'সাইজ/ওজন যুক্ত হয়েছে।');
  res.redirect('/admin/size/manage');
});

router.post('/admin/size/delete/:id', (req, res) => {
  db.run('DELETE FROM sizes WHERE id = ?', req.params.id);
  req.flash('success', 'সাইজ ডিলিট হয়েছে।');
  res.redirect('/admin/size/manage');
});

// ─── Coupons ───
function renderCoupons(res, openModal = false) {
  const rows = db.all('SELECT * FROM coupons ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Discount Coupons',
    subtitle: 'চেকআউট ডিসকাউন্ট কুপন কোড তৈরি ও পরিচালনা করুন',
    createAction: '/admin/coupon/create',
    deletePrefix: '/admin/coupon/delete',
    autoOpenModal: openModal,
    columns: [
      { key: 'id', label: '#' },
      { key: 'code', label: 'Coupon Code', type: 'badge' },
      { key: 'type', label: 'Discount Type' },
      { key: 'value', label: 'Discount Value' },
      { key: 'min_purchase', label: 'Min Purchase (৳)', type: 'currency' },
      { key: 'expiry_date', label: 'Expires On' },
      { key: 'used_count', label: 'Used' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'code', label: 'Coupon Code (e.g. MANGO20)', type: 'text', required: true },
      {
        name: 'type',
        label: 'Type',
        type: 'select',
        options: [
          { value: 'percent', label: 'Percentage (%)' },
          { value: 'flat', label: 'Flat Amount (৳)' },
        ],
      },
      { name: 'value', label: 'Value', type: 'number', required: true },
      { name: 'min_purchase', label: 'Minimum Order (৳)', type: 'number', value: '500' },
      { name: 'expiry_date', label: 'Expiry Date', type: 'date', value: '2027-12-31' },
    ],
    rows,
  });
}

router.get('/admin/coupon/manage', (_req, res) => renderCoupons(res, false));
router.get('/admin/coupon/create', (_req, res) => renderCoupons(res, true));

router.post('/admin/coupon/create', (req, res) => {
  const { code, type, value, min_purchase, expiry_date } = req.body;
  db.run(
    'INSERT INTO coupons (code, type, value, min_purchase, expiry_date) VALUES (?, ?, ?, ?, ?)',
    String(code || '').trim().toUpperCase(),
    type || 'percent',
    Number(value || 10),
    Number(min_purchase || 0),
    expiry_date || '2027-12-31'
  );
  req.flash('success', 'কুপন কোড সফলভাবে তৈরি হয়েছে!');
  res.redirect('/admin/coupon/manage');
});

router.post('/admin/coupon/delete/:id', (req, res) => {
  db.run('DELETE FROM coupons WHERE id = ?', req.params.id);
  req.flash('success', 'কুপন ডিলিট হয়েছে।');
  res.redirect('/admin/coupon/manage');
});

// ─── Reviews ───
router.get('/admin/reviews', (_req, res) => renderReviews(res, 'all'));
router.get('/admin/review/pending', (_req, res) => renderReviews(res, 'pending'));

function renderReviews(res, filter) {
  const rows =
    filter === 'pending'
      ? db.all(
          `SELECT r.*, p.name AS product_name FROM reviews r
           LEFT JOIN products p ON p.id = r.product_id
           WHERE r.status = 'pending' ORDER BY r.id DESC`
        )
      : db.all(
          `SELECT r.*, p.name AS product_name FROM reviews r
           LEFT JOIN products p ON p.id = r.product_id
           ORDER BY r.id DESC`
        );
  const products = db.all('SELECT id, name FROM products ORDER BY id ASC');

  res.render('admin/crud-module', {
    pageTitle: filter === 'pending' ? 'Pending Product Reviews' : 'All Product Reviews',
    subtitle: 'গ্রাহকের রিভিউ অ্যাপ্রুভ, ডিলিট অথবা নতুন রিভিউ যুক্ত করুন',
    createAction: '/admin/reviews/create',
    deletePrefix: '/admin/reviews/delete',
    customActionPrefix: '/admin/reviews/approve',
    customActionLabel: 'Approve',
    columns: [
      { key: 'id', label: '#' },
      { key: 'product_name', label: 'Product' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'rating', label: 'Stars (1-5)' },
      { key: 'comment', label: 'Comment' },
      { key: 'status', label: 'Status', type: 'badge' },
      { key: 'created_at', label: 'Date' },
    ],
    fields: [
      {
        name: 'product_id',
        label: 'Product',
        type: 'select',
        options: products.map((p) => ({ value: p.id, label: p.name })),
        required: true,
      },
      { name: 'customer_name', label: 'Customer Name', type: 'text', required: true },
      { name: 'rating', label: 'Rating (1-5)', type: 'number', value: '5', required: true },
      { name: 'comment', label: 'Review Text', type: 'textarea', required: true },
    ],
    rows,
  });
}

router.post('/admin/reviews/create', (req, res) => {
  const { product_id, customer_name, rating, comment } = req.body;
  db.run(
    "INSERT INTO reviews (product_id, customer_name, rating, comment, status) VALUES (?, ?, ?, ?, 'approved')",
    Number(product_id || 1),
    customer_name,
    Math.min(5, Math.max(1, Number(rating || 5))),
    comment
  );
  req.flash('success', 'রিভিউ সফলভাবে যোগ করা হয়েছে!');
  res.redirect('/admin/reviews');
});

router.post('/admin/reviews/approve/:id', (req, res) => {
  db.run("UPDATE reviews SET status = 'approved' WHERE id = ?", req.params.id);
  req.flash('success', 'রিভিউ Approve করা হয়েছে!');
  res.redirect(req.get('Referrer') || '/admin/reviews');
});

router.post('/admin/reviews/delete/:id', (req, res) => {
  db.run('DELETE FROM reviews WHERE id = ?', req.params.id);
  req.flash('success', 'রিভিউ ডিলিট হয়েছে।');
  res.redirect(req.get('Referrer') || '/admin/reviews');
});

module.exports = router;
