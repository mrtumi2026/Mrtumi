const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { env } = require('../config/env');
const catalogRepo = require('../repositories/adminCatalogRepository');
const phase06Repo = require('../repositories/phase06Repository');
const couponRepo = require('../repositories/adminCouponRepository');
const { asyncHandler } = require('../utils/asyncHandler');
const { ConflictError } = require('../utils/errors');

const router = express.Router();
const mysqlMode = () => env.db.client === 'mysql';
const actor = (req) => ({ id:req.adminUser?.id||null,ip:req.ip||'',userAgent:req.get('user-agent')||'' });
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
async function renderProductList(req, res, mode, pageTitle) {
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

  const products = mysqlMode()
    ? await catalogRepo.listProducts({mode,search:q})
    : db.all(
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
    mysqlMode:mysqlMode(),
  });
}

router.get('/admin/inhouse-products/manage', asyncHandler((req, res) =>
  renderProductList(req, res, 'inhouse', 'All Inhouse Products')
));
router.get('/admin/products/manage', asyncHandler((req, res) =>
  renderProductList(req, res, 'vendor', 'All Vendor Products')
));
router.get('/admin/products/pending', asyncHandler((req, res) =>
  renderProductList(req, res, 'pending', 'Pending Approval Products')
));
router.get('/admin/products/wholesale', asyncHandler((req, res) =>
  renderProductList(req, res, 'wholesale', 'Wholesale Products')
));

// ─── Create / Edit Product ───
router.get('/admin/products/create', (req, res) => {
  if(mysqlMode())return res.redirect('/admin/phase06#products');
  res.render('admin/product-form', {
    pageTitle: 'Add New Product',
    product: null,
    categories: db.all('SELECT * FROM categories ORDER BY sort_order ASC'),
    brands: db.all('SELECT * FROM brands ORDER BY id ASC'),
    vendors: db.all('SELECT * FROM vendors ORDER BY id ASC'),
  });
});

router.post('/admin/products/create', upload.single('image_file'), (req, res, next) => {
  if(mysqlMode()){
    if(req.file)upload.safeUnlink(req.file.path);
    return next(new ConflictError('Use the canonical Phase 06 product form to create a MySQL catalog product.'));
  }
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

router.get('/admin/products/edit/:id', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await phase06Repo.getProductForEdit(req.params.id);
    return res.redirect(`/admin/phase06/products/${encodeURIComponent(req.params.id)}/edit`);
  }
  const product = db.get('SELECT * FROM products WHERE id = ?', req.params.id);
  if (!product) return res.redirect('/admin/inhouse-products/manage');

  res.render('admin/product-form', {
    pageTitle: `Edit Product — ${product.name}`,
    product,
    categories: db.all('SELECT * FROM categories ORDER BY sort_order ASC'),
    brands: db.all('SELECT * FROM brands ORDER BY id ASC'),
    vendors: db.all('SELECT * FROM vendors ORDER BY id ASC'),
  });
}));

router.post('/admin/products/edit/:id', upload.single('image_file'), (req, res, next) => {
  if(mysqlMode()){
    if(req.file)upload.safeUnlink(req.file.path);
    return next(new ConflictError('Use the canonical Phase 06 product form to edit a MySQL catalog product.'));
  }
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

router.post('/admin/products/toggle/:id', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await catalogRepo.toggleProductStatus(req.params.id,actor(req));req.adminDomainAudit=true;
  }else{
    const p=db.get('SELECT id,status FROM products WHERE id=?',req.params.id);
    if(p)db.run('UPDATE products SET status=? WHERE id=?',p.status?0:1,p.id);
  }
  req.flash('success','প্রোডাক্ট স্ট্যাটাস পরিবর্তন হয়েছে।');
  res.redirect(req.get('Referrer')||'/admin/inhouse-products/manage');
}));

router.post('/admin/products/approve/:id', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await catalogRepo.approvePendingVendorProduct(req.params.id,actor(req));req.adminDomainAudit=true;
  }else db.run("UPDATE products SET approval_status='approved',status=1 WHERE id=?",req.params.id);
  req.flash('success','প্রোডাক্ট সফলভাবে Approve করা হয়েছে!');
  res.redirect(req.get('Referrer')||'/admin/products/pending');
}));

router.post('/admin/products/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Hard deletion of catalog products is disabled; archive products from Phase 06 to preserve stock and order history.'));
  db.run('DELETE FROM products WHERE id=?',req.params.id);
  req.flash('success','প্রোডাক্ট ডিলিট করা হয়েছে।');
  res.redirect(req.get('Referrer')||'/admin/inhouse-products/manage');
});

// ─── Categories, Subcategories, Childcategories, Brands, Colors, Sizes ───
router.get('/admin/categories/manage', asyncHandler(async (_req, res) => {
  const rows = mysqlMode() ? await catalogRepo.listTaxonomy('categories') : db.all(
    `SELECT c.*, COUNT(p.id) AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id
     GROUP BY c.id ORDER BY c.sort_order ASC, c.id ASC`
  );
  res.render('admin/crud-module', {
    pageTitle: 'Product Categories',
    subtitle: 'প্রোডাক্ট ক্যাটাগরি তৈরি, সম্পাদনা ও সাজিয়ে নিন',
    createAction: '/admin/categories/create',
    deletePrefix: mysqlMode() ? null : '/admin/categories/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'icon', label: 'Icon' },
      { key: 'name', label: 'Category Name' },
      { key: 'slug', label: 'Slug' },
      { key: 'product_count', label: 'Products', type: 'badge' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Category Name (বাংলা)', type: 'text', required: true },
      { name: 'name_en', label: 'Category Name (English)', type: 'text' },
      { name: 'slug', label: 'URL Slug (optional)', type: 'text' },
      { name: 'icon', label: 'Emoji / Icon', type: 'text', value: '🍒' },
      { name: 'sort_order', label: 'Sort Order', type: 'number', value: '1' },
    ],
    rows,
  });
}));

router.post('/admin/categories/create', asyncHandler(async (req, res) => {
  const { name, slug, icon, sort_order } = req.body;
  if(mysqlMode()){
    await catalogRepo.createTaxonomy('categories',{...req.body,name,slug,icon,sort_order},actor(req));req.adminDomainAudit=true;
    req.flash('success','নতুন ক্যাটাগরি যুক্ত হয়েছে!');return res.redirect('/admin/categories/manage');
  }
  db.run(
    'INSERT INTO categories (name, slug, icon, sort_order) VALUES (?, ?, ?, ?)',
    name,
    slug ? makeSlug(slug) : `${makeSlug(name)}-${Date.now().toString().slice(-3)}`,
    icon || '🍒',
    Number(sort_order || 1)
  );
  req.flash('success', 'নতুন ক্যাটাগরি যুক্ত হয়েছে!');
  res.redirect('/admin/categories/manage');
}));

router.post('/admin/categories/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Category deletion is disabled to preserve product and taxonomy references.'));
  db.run('DELETE FROM categories WHERE id = ?', req.params.id);
  req.flash('success', 'ক্যাটাগরি মুছে ফেলা হয়েছে।');
  res.redirect('/admin/categories/manage');
});

// Subcategories
router.get('/admin/subcategories/manage', asyncHandler(async (_req, res) => {
  const rows = mysqlMode() ? await catalogRepo.listTaxonomy('subcategories') : db.all(
    `SELECT s.*, c.name AS category_name
     FROM subcategories s
     LEFT JOIN categories c ON c.id = s.category_id
     ORDER BY s.id DESC`
  );
  const cats = mysqlMode() ? await catalogRepo.listTaxonomy('categories') : db.all('SELECT id, name FROM categories ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Subcategories',
    subtitle: 'ক্যাটাগরির অধীনে সাব-ক্যাটাগরি ব্যবস্থাপনা',
    createAction: '/admin/subcategories/create',
    deletePrefix: mysqlMode() ? null : '/admin/subcategories/delete',
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
      { name: 'name', label: 'Subcategory Name (বাংলা)', type: 'text', required: true },
      { name: 'name_en', label: 'Subcategory Name (English)', type: 'text' },
    ],
    rows,
  });
}));

router.post('/admin/subcategories/create', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await catalogRepo.createTaxonomy('subcategories',req.body,actor(req));req.adminDomainAudit=true;
    req.flash('success','সাব-ক্যাটাগরি তৈরি হয়েছে।');return res.redirect('/admin/subcategories/manage');
  }
  db.run(
    'INSERT INTO subcategories (category_id, name, slug) VALUES (?, ?, ?)',
    Number(req.body.category_id || 1),
    req.body.name,
    makeSlug(req.body.name)
  );
  req.flash('success', 'সাব-ক্যাটাগরি তৈরি হয়েছে।');
  res.redirect('/admin/subcategories/manage');
}));

router.post('/admin/subcategories/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Subcategory deletion is disabled to preserve product and taxonomy references.'));
  db.run('DELETE FROM subcategories WHERE id = ?', req.params.id);
  req.flash('success', 'সাব-ক্যাটাগরি ডিলিট হয়েছে।');
  res.redirect('/admin/subcategories/manage');
});

// Childcategories
router.get('/admin/childcategories/manage', asyncHandler(async (_req, res) => {
  const rows = mysqlMode() ? await catalogRepo.listTaxonomy('childcategories') : db.all(
    `SELECT ch.*, s.name AS subcategory_name
     FROM childcategories ch
     LEFT JOIN subcategories s ON s.id = ch.subcategory_id
     ORDER BY ch.id DESC`
  );
  const subs = mysqlMode() ? await catalogRepo.listTaxonomy('subcategories') : db.all('SELECT id, name FROM subcategories ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Childcategories',
    subtitle: 'সাব-ক্যাটাগরির অধীনে চাইল্ড-ক্যাটাগরি ব্যবস্থাপনা',
    createAction: '/admin/childcategories/create',
    deletePrefix: mysqlMode() ? null : '/admin/childcategories/delete',
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
      { name: 'name', label: 'Childcategory Name (বাংলা)', type: 'text', required: true },
      { name: 'name_en', label: 'Childcategory Name (English)', type: 'text' },
    ],
    rows,
  });
}));

router.post('/admin/childcategories/create', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await catalogRepo.createTaxonomy('childcategories',req.body,actor(req));req.adminDomainAudit=true;
    req.flash('success','চাইল্ড-ক্যাটাগরি তৈরি হয়েছে।');return res.redirect('/admin/childcategories/manage');
  }
  db.run(
    'INSERT INTO childcategories (subcategory_id, name, slug) VALUES (?, ?, ?)',
    Number(req.body.subcategory_id || 1),
    req.body.name,
    makeSlug(req.body.name)
  );
  req.flash('success', 'চাইল্ড-ক্যাটাগরি তৈরি হয়েছে।');
  res.redirect('/admin/childcategories/manage');
}));

router.post('/admin/childcategories/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Childcategory deletion is disabled to preserve product and taxonomy references.'));
  db.run('DELETE FROM childcategories WHERE id = ?', req.params.id);
  req.flash('success', 'চাইল্ড-ক্যাটাগরি ডিলিট হয়েছে।');
  res.redirect('/admin/childcategories/manage');
});

// Brands
router.get('/admin/brands/manage', asyncHandler(async (_req, res) => {
  const rows = mysqlMode() ? await catalogRepo.listTaxonomy('brands') : db.all('SELECT * FROM brands ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Brands',
    subtitle: 'প্রোডাক্ট ব্র্যান্ড ও অর্গানিক ফার্ম পার্টনার তালিকা',
    createAction: '/admin/brands/create',
    deletePrefix: mysqlMode() ? null : '/admin/brands/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Brand Name' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name:'name',label:'Brand Name (বাংলা)',type:'text',required:true },
      { name:'name_en',label:'Brand Name (English)',type:'text' },
    ],
    rows,
  });
}));

router.post('/admin/brands/create', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await catalogRepo.createTaxonomy('brands',req.body,actor(req));req.adminDomainAudit=true;
    req.flash('success','ব্র্যান্ড যুক্ত হয়েছে।');return res.redirect('/admin/brands/manage');
  }
  db.run('INSERT INTO brands (name, slug) VALUES (?, ?)', req.body.name, makeSlug(req.body.name));
  req.flash('success', 'ব্র্যান্ড যুক্ত হয়েছে।');
  res.redirect('/admin/brands/manage');
}));

router.post('/admin/brands/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Brand deletion is disabled to preserve product references.'));
  db.run('DELETE FROM brands WHERE id = ?', req.params.id);
  req.flash('success', 'ব্র্যান্ড ডিলিট হয়েছে।');
  res.redirect('/admin/brands/manage');
});

// Colors
router.get('/admin/color/manage', asyncHandler(async (_req, res) => {
  const rows = mysqlMode() ? await catalogRepo.listTaxonomy('colors') : db.all('SELECT * FROM colors ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Product Colors',
    subtitle: 'প্রোডাক্ট ভ্যারিয়েন্ট কালার তালিকা',
    createAction: '/admin/color/create',
    deletePrefix: mysqlMode() ? null : '/admin/color/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Color Name' },
      { key: 'hex_code', label: 'Preview', type: 'color' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name:'name',label:'Color Name (বাংলা)',type:'text',required:true },
      { name:'name_en',label:'Color Name (English)',type:'text' },
      { name:'hex_code',label:'Hex Code',type:'color',value:'#e11d48' },
    ],
    rows,
  });
}));

router.post('/admin/color/create', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await catalogRepo.createTaxonomy('colors',req.body,actor(req));req.adminDomainAudit=true;
    req.flash('success','কালার যুক্ত হয়েছে।');return res.redirect('/admin/color/manage');
  }
  db.run('INSERT INTO colors (name, hex_code) VALUES (?, ?)', req.body.name, req.body.hex_code || '#dc2626');
  req.flash('success', 'কালার যুক্ত হয়েছে।');
  res.redirect('/admin/color/manage');
}));

router.post('/admin/color/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Color deletion is disabled to preserve catalog history.'));
  db.run('DELETE FROM colors WHERE id = ?', req.params.id);
  req.flash('success', 'কালার ডিলিট হয়েছে।');
  res.redirect('/admin/color/manage');
});

// Sizes / Weights
router.get('/admin/size/manage', asyncHandler(async (_req, res) => {
  const rows = mysqlMode() ? await catalogRepo.listTaxonomy('sizes') : db.all('SELECT * FROM sizes ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Sizes / Weight Packs',
    subtitle: 'ওজন ও প্যাক সাইজ ভ্যারিয়েন্ট (যেমন ৫০০ গ্রাম, ১ কেজি, ২ কেজি)',
    createAction: '/admin/size/create',
    deletePrefix: mysqlMode() ? null : '/admin/size/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Size / Pack Label' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      {name:'name',label:'Size / Weight Label (বাংলা)',type:'text',required:true},
      {name:'name_en',label:'Size / Weight Label (English)',type:'text'},
    ],
    rows,
  });
}));

router.post('/admin/size/create', asyncHandler(async (req, res) => {
  if(mysqlMode()){
    await catalogRepo.createTaxonomy('sizes',req.body,actor(req));req.adminDomainAudit=true;
    req.flash('success','সাইজ/ওজন যুক্ত হয়েছে।');return res.redirect('/admin/size/manage');
  }
  db.run('INSERT INTO sizes (name) VALUES (?)', req.body.name);
  req.flash('success', 'সাইজ/ওজন যুক্ত হয়েছে।');
  res.redirect('/admin/size/manage');
}));

router.post('/admin/size/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Size deletion is disabled to preserve catalog history.'));
  db.run('DELETE FROM sizes WHERE id = ?', req.params.id);
  req.flash('success', 'সাইজ ডিলিট হয়েছে।');
  res.redirect('/admin/size/manage');
});

// ─── Coupons ───
async function renderCoupons(res, openModal = false) {
  const rows = mysqlMode()
    ? await couponRepo.listCoupons()
    : db.all('SELECT * FROM coupons ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Discount Coupons',
    subtitle: 'চেকআউট ডিসকাউন্ট কুপন কোড তৈরি ও পরিচালনা করুন',
    createAction: '/admin/coupon/create',
    deletePrefix: mysqlMode() ? null : '/admin/coupon/delete',
    mysqlMode: mysqlMode(),
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

router.get('/admin/coupon/manage', asyncHandler(async (_req, res) => renderCoupons(res, false)));
router.get('/admin/coupon/create', asyncHandler(async (_req, res) => renderCoupons(res, true)));

router.post('/admin/coupon/create', asyncHandler(async (req, res) => {
  if (mysqlMode()) {
    await couponRepo.createCoupon(req.body, actor(req));
    req.adminDomainAudit = true;
  } else {
    const { code, type, value, min_purchase, expiry_date } = req.body;
    db.run(
      'INSERT INTO coupons (code, type, value, min_purchase, expiry_date) VALUES (?, ?, ?, ?, ?)',
      String(code || '').trim().toUpperCase(),
      type || 'percent',
      Number(value || 10),
      Number(min_purchase || 0),
      expiry_date || '2027-12-31'
    );
  }
  req.flash('success', 'কুপন কোড সফলভাবে তৈরি হয়েছে!');
  res.redirect('/admin/coupon/manage');
}));

router.post('/admin/coupon/delete/:id', (req, res, next) => {
  if (mysqlMode()) return next(new ConflictError('Coupon deletion is disabled to preserve coupon and order history.'));
  db.run('DELETE FROM coupons WHERE id = ?', req.params.id);
  req.flash('success', 'কুপন ডিলিট হয়েছে।');
  res.redirect('/admin/coupon/manage');
});

// ─── Reviews ───
router.get('/admin/reviews', asyncHandler((_req, res) => renderReviews(res, 'all')));
router.get('/admin/review/pending', asyncHandler((_req, res) => renderReviews(res, 'pending')));

async function renderReviews(res, filter) {
  const rows = mysqlMode()
    ? await catalogRepo.listReviews(filter)
    : filter === 'pending'
      ? db.all(`SELECT r.*,p.name AS product_name FROM reviews r LEFT JOIN products p ON p.id=r.product_id WHERE r.status='pending' ORDER BY r.id DESC`)
      : db.all(`SELECT r.*,p.name AS product_name FROM reviews r LEFT JOIN products p ON p.id=r.product_id ORDER BY r.id DESC`);
  const products = mysqlMode()
    ? await catalogRepo.listReviewProductOptions()
    : db.all('SELECT id, name FROM products ORDER BY id ASC');

  res.render('admin/crud-module', {
    pageTitle: filter === 'pending' ? 'Pending Product Reviews' : 'All Product Reviews',
    subtitle: 'গ্রাহকের রিভিউ অ্যাপ্রুভ, ডিলিট অথবা নতুন রিভিউ যুক্ত করুন',
    createAction: '/admin/reviews/create',
    deletePrefix: mysqlMode() ? null : '/admin/reviews/delete',
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

router.post('/admin/reviews/create', asyncHandler(async (req, res) => {
  const { product_id, customer_name, rating, comment } = req.body;
  if(mysqlMode()){
    await catalogRepo.createReview(req.body,actor(req));req.adminDomainAudit=true;
    req.flash('success','রিভিউ সফলভাবে যোগ করা হয়েছে!');return res.redirect('/admin/reviews');
  }
  db.run(
    "INSERT INTO reviews (product_id, customer_name, rating, comment, status) VALUES (?, ?, ?, ?, 'approved')",
    Number(product_id || 1),
    customer_name,
    Math.min(5, Math.max(1, Number(rating || 5))),
    comment
  );
  req.flash('success', 'রিভিউ সফলভাবে যোগ করা হয়েছে!');
  res.redirect('/admin/reviews');
}));

router.post('/admin/reviews/approve/:id', asyncHandler(async (req, res) => {
  if(mysqlMode()){await catalogRepo.approveReview(req.params.id,actor(req));req.adminDomainAudit=true;}
  else db.run("UPDATE reviews SET status = 'approved' WHERE id = ?", req.params.id);
  req.flash('success', 'রিভিউ Approve করা হয়েছে!');
  res.redirect(req.get('Referrer') || '/admin/reviews');
}));

router.post('/admin/reviews/delete/:id', (req, res, next) => {
  if(mysqlMode())return next(new ConflictError('Review deletion is disabled to preserve customer feedback history.'));
  db.run('DELETE FROM reviews WHERE id = ?', req.params.id);
  req.flash('success', 'রিভিউ ডিলিট হয়েছে।');
  res.redirect(req.get('Referrer') || '/admin/reviews');
});

module.exports = router;
