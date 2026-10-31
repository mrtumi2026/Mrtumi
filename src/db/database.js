const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const { DatabaseError } = require('../utils/errors');

let lazyRawDb = null;

/**
 * Lazily opens the non-production SQLite prototype ONLY when `DB_CLIENT=sqlite`
 * in development/test. Never loads `node:sqlite` or touches `data/pholbazar.db`
 * when `DB_CLIENT=mysql` or `NODE_ENV=production`.
 */
function assertSqliteAllowed() {
  // Fail closed with an operational 503: legacy callers must migrate to async MySQL
  // repositories, and production must never fall back to a local SQLite database.
  const runtimeNodeEnv = String(process.env.NODE_ENV || env.nodeEnv || '').toLowerCase();
  const runtimeDbClient = String(process.env.DB_CLIENT || env.db.client || '').toLowerCase();

  if (env.isProduction || runtimeNodeEnv === 'production') {
    throw new DatabaseError(
      'SQLITE_PROHIBITED_IN_PRODUCTION',
      'SQLite is strictly prohibited in production. Configure DB_CLIENT=mysql for BestWebHostBD MySQL.',
      503
    );
  }
  if (env.db.client === 'mysql' || runtimeDbClient === 'mysql') {
    throw new DatabaseError(
      'SQLITE_CALLER_NOT_MIGRATED',
      'Legacy synchronous SQLite API called while DB_CLIENT=mysql is active. Use async MySQL repositories instead.',
      503
    );
  }
}

function getRawDb() {
  assertSqliteAllowed();
  if (!lazyRawDb) {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = env.db.sqlitePath;
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    lazyRawDb = new DatabaseSync(dbPath);
    lazyRawDb.exec('PRAGMA journal_mode = WAL;');
    lazyRawDb.exec('PRAGMA foreign_keys = ON;');
    lazyRawDb.exec('PRAGMA busy_timeout = 5000;');
  }
  return lazyRawDb;
}

function sanitizeParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

function all(sql, ...params) {
  const stmt = getRawDb().prepare(sql);
  const rows = stmt.all(...sanitizeParams(params));
  return rows.map((r) => ({ ...r }));
}

function get(sql, ...params) {
  const stmt = getRawDb().prepare(sql);
  const row = stmt.get(...sanitizeParams(params));
  return row ? { ...row } : null;
}

function run(sql, ...params) {
  const stmt = getRawDb().prepare(sql);
  return stmt.run(...sanitizeParams(params));
}

function exec(sql) {
  return getRawDb().exec(sql);
}

function initializeDatabase() {
  exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'Admin Head',
      avatar TEXT DEFAULT '/uploads/default/user.svg',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      permissions TEXT DEFAULT '["all"]',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      module TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      district TEXT DEFAULT 'ঢাকা',
      password_hash TEXT DEFAULT '',
      total_orders INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1,
      is_blocked INTEGER DEFAULT 0,
      ip_address TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS ip_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_or_phone TEXT NOT NULL,
      reason TEXT DEFAULT 'Suspicious / Fake Order',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      icon TEXT DEFAULT '🍒',
      image TEXT DEFAULT '/uploads/product/lychee-fresh.jpg',
      front_view INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS childcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subcategory_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      logo TEXT DEFAULT '/uploads/settings/logo.svg',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      hex_code TEXT DEFAULT '#dc2626',
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      commission_rate REAL DEFAULT 10,
      balance REAL DEFAULT 0,
      verified INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS vendor_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT DEFAULT 'bKash',
      account_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS resellers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      shop_name TEXT DEFAULT '',
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      balance REAL DEFAULT 0,
      deposit_amount REAL DEFAULT 0,
      verified INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS reseller_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reseller_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- 'deposit' or 'withdrawal'
      amount REAL NOT NULL,
      method TEXT DEFAULT 'bKash',
      trx_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      code TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      subcategory_id INTEGER DEFAULT NULL,
      brand_id INTEGER DEFAULT 1,
      vendor_id INTEGER DEFAULT NULL, -- NULL = Inhouse
      old_price REAL DEFAULT 0,
      new_price REAL NOT NULL,
      purchase_price REAL DEFAULT 0,
      wholesale_price REAL DEFAULT 0,
      wholesale_min_qty INTEGER DEFAULT 0,
      stock INTEGER DEFAULT 100,
      sold_count INTEGER DEFAULT 0,
      unit TEXT DEFAULT 'কেজি',
      sizes TEXT DEFAULT '৫০০ গ্রাম,১ কেজি,২ কেজি',
      colors TEXT DEFAULT 'লাল,গোলাপি',
      image TEXT DEFAULT '/uploads/product/lychee-fresh.jpg',
      gallery TEXT DEFAULT '[]',
      short_desc TEXT DEFAULT '',
      description TEXT DEFAULT '',
      is_flash_sale INTEGER DEFAULT 1,
      is_hot_deal INTEGER DEFAULT 1,
      is_wholesale INTEGER DEFAULT 0,
      approval_status TEXT DEFAULT 'approved', -- 'approved' | 'pending'
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS order_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      badge_class TEXT DEFAULT 'sb-1',
      color TEXT DEFAULT '#f59e0b',
      sort_order INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL UNIQUE,
      customer_id INTEGER DEFAULT NULL,
      reseller_id INTEGER DEFAULT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      shipping_area TEXT DEFAULT 'ঢাকার ভিতরে',
      shipping_charge REAL DEFAULT 60,
      subtotal REAL NOT NULL,
      discount REAL DEFAULT 0,
      coupon_code TEXT DEFAULT '',
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'Cash On Delivery',
      payment_status TEXT DEFAULT 'unpaid',
      trx_id TEXT DEFAULT '',
      sender_number TEXT DEFAULT '',
      status TEXT DEFAULT 'pending', -- pending, processing, on-the-way, in-courier, completed, unpaid, cancelled
      courier_name TEXT DEFAULT '',
      courier_tracking_id TEXT DEFAULT '',
      traffic_source TEXT DEFAULT 'Direct', -- Direct, Facebook, Google, Other
      order_type TEXT DEFAULT 'website', -- website, pos, reseller, landing
      note TEXT DEFAULT '',
      admin_note TEXT DEFAULT '',
      is_seen INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER DEFAULT NULL,
      product_name TEXT NOT NULL,
      product_image TEXT DEFAULT '/uploads/product/lychee-fresh.jpg',
      price REAL NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      size TEXT DEFAULT '১ কেজি',
      color TEXT DEFAULT '',
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS incomplete_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT DEFAULT '',
      phone TEXT NOT NULL,
      address TEXT DEFAULT '',
      cart_summary TEXT DEFAULT '',
      estimated_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'abandoned',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      method TEXT DEFAULT 'bKash',
      status TEXT DEFAULT 'pending', -- pending, approved, processed, rejected
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      type TEXT DEFAULT 'percent', -- percent | flat
      value REAL NOT NULL,
      min_purchase REAL DEFAULT 0,
      expiry_date TEXT DEFAULT '2027-12-31',
      used_count INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      rating INTEGER DEFAULT 5,
      comment TEXT NOT NULL,
      status TEXT DEFAULT 'approved', -- pending | approved
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS blogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      category TEXT DEFAULT 'ফল ও স্বাস্থ্য',
      image TEXT DEFAULT '/uploads/banner/banner-1.jpg',
      excerpt TEXT DEFAULT '',
      content TEXT NOT NULL,
      author TEXT DEFAULT 'Admin',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT DEFAULT '',
      phone TEXT NOT NULL,
      address TEXT DEFAULT '',
      balance_due REAL DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference_no TEXT NOT NULL,
      supplier_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      paid_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'received',
      purchase_date TEXT DEFAULT (date('now', 'localtime')),
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      designation TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      base_salary REAL DEFAULT 15000,
      join_date TEXT DEFAULT '2026-01-01',
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS attendances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      att_date TEXT NOT NULL,
      check_in TEXT DEFAULT '09:00 AM',
      check_out TEXT DEFAULT '06:00 PM',
      status TEXT DEFAULT 'Present'
    );

    CREATE TABLE IF NOT EXISTS leaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      leave_type TEXT DEFAULT 'Casual Leave',
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS salaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      basic_amount REAL NOT NULL,
      bonus REAL DEFAULT 0,
      deduction REAL DEFAULT 0,
      net_salary REAL NOT NULL,
      status TEXT DEFAULT 'paid',
      paid_at TEXT DEFAULT (date('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS bonuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      amount REAL NOT NULL,
      bonus_date TEXT DEFAULT (date('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS fund_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name TEXT DEFAULT 'Main Cash / Bank Fund',
      type TEXT NOT NULL, -- 'credit' | 'debit'
      amount REAL NOT NULL,
      note TEXT DEFAULT '',
      tx_date TEXT DEFAULT (date('now', 'localtime')),
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'অপারেশন',
      amount REAL NOT NULL,
      note TEXT DEFAULT '',
      expense_date TEXT DEFAULT (date('now', 'localtime')),
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS delivery_boys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      area TEXT DEFAULT 'ঢাকা সিটি',
      vehicle_type TEXT DEFAULT 'মোটরসাইকেল',
      commission_per_order REAL DEFAULT 40,
      balance REAL DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS delivery_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_boy_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT DEFAULT 'bKash',
      account_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS delivery_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      division TEXT NOT NULL,
      district TEXT NOT NULL,
      upazila TEXT NOT NULL,
      delivery_charge REAL DEFAULT 120,
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      product_id INTEGER NOT NULL,
      headline TEXT NOT NULL,
      subheadline TEXT DEFAULT '',
      banner_image TEXT DEFAULT '/uploads/banner/banner-1.jpg',
      offer_price REAL NOT NULL,
      regular_price REAL DEFAULT 0,
      benefits TEXT DEFAULT 'বাগান থেকে সরাসরি সংগৃহীত শতভাগ ফরমালিনমুক্ত লিচু|সারা বাংলাদেশে দ্রুত হোম ডেলিভারি|পণ্য হাতে পেয়ে মূল্য পরিশোধের সুবিধা',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      position TEXT DEFAULT 'hero', -- hero | promo_mid | promo_bottom
      image TEXT NOT NULL,
      link TEXT DEFAULT '/all-products',
      status INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      invoice_id TEXT DEFAULT '',
      details TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      admin_reply TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      subject TEXT DEFAULT '',
      message TEXT NOT NULL,
      status TEXT DEFAULT 'unread',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_or_phone TEXT NOT NULL UNIQUE,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS sms_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      message TEXT NOT NULL,
      gateway TEXT DEFAULT 'BulkSMSBD',
      status TEXT DEFAULT 'Delivered',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS payment_gateways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      type TEXT DEFAULT 'auto', -- 'auto' | 'manual'
      account_number TEXT DEFAULT '',
      instructions TEXT DEFAULT '',
      app_key TEXT DEFAULT '',
      app_secret TEXT DEFAULT '',
      sandbox INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS courier_apis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      api_key TEXT DEFAULT '',
      secret_key TEXT DEFAULT '',
      base_url TEXT DEFAULT '',
      balance REAL DEFAULT 0,
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS cms_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      icon TEXT DEFAULT 'shield',
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS social_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      url TEXT NOT NULL,
      icon TEXT DEFAULT 'facebook',
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'INFO',
      message TEXT NOT NULL,
      context TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  try {
    exec('ALTER TABLE orders ADD COLUMN delivery_boy_id INTEGER DEFAULT NULL;');
  } catch (_e) {}
  try {
    exec("ALTER TABLE orders ADD COLUMN reseller_profit REAL DEFAULT 0;");
  } catch (_e) {}
  try {
    exec("ALTER TABLE vendors ADD COLUMN password_hash TEXT DEFAULT '';");
  } catch (_e) {}
  try {
    exec("ALTER TABLE resellers ADD COLUMN password_hash TEXT DEFAULT '';");
  } catch (_e) {}

  // Safe additive non-production SQLite parity columns & tables for Phases 06–18
  const additiveAlterStatements = [
    "ALTER TABLE products ADD COLUMN barcode TEXT DEFAULT NULL;",
    "ALTER TABLE products ADD COLUMN childcategory_id INTEGER DEFAULT NULL;",
    "ALTER TABLE products ADD COLUMN product_type TEXT DEFAULT 'grocery';",
    "ALTER TABLE products ADD COLUMN name_en TEXT DEFAULT '';",
    "ALTER TABLE products ADD COLUMN short_desc_en TEXT DEFAULT '';",
    "ALTER TABLE products ADD COLUMN description_en TEXT DEFAULT '';",
    "ALTER TABLE products ADD COLUMN stock_reserved INTEGER DEFAULT 0;",
    "ALTER TABLE products ADD COLUMN vendor_stock_on_hand INTEGER DEFAULT 0;",
    "ALTER TABLE products ADD COLUMN vendor_stock_reserved INTEGER DEFAULT 0;",
    "ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER DEFAULT 10;",
    "ALTER TABLE products ADD COLUMN is_gift_eligible INTEGER DEFAULT 0;",
    "ALTER TABLE products ADD COLUMN is_archived INTEGER DEFAULT 0;",
    "ALTER TABLE suppliers ADD COLUMN supplier_code TEXT DEFAULT NULL;",
    "ALTER TABLE suppliers ADD COLUMN contact_person TEXT DEFAULT '';",
    "ALTER TABLE suppliers ADD COLUMN email TEXT DEFAULT '';",
    "ALTER TABLE suppliers ADD COLUMN tax_or_trade_id TEXT DEFAULT '';",
    "ALTER TABLE suppliers ADD COLUMN notes TEXT DEFAULT '';",
    "ALTER TABLE purchases ADD COLUMN subtotal REAL DEFAULT 0;",
    "ALTER TABLE purchases ADD COLUMN discount REAL DEFAULT 0;",
    "ALTER TABLE purchases ADD COLUMN shipping_charge REAL DEFAULT 0;",
    "ALTER TABLE purchases ADD COLUMN note TEXT DEFAULT '';",
    "ALTER TABLE purchases ADD COLUMN cancelled_reason TEXT DEFAULT '';",
    "ALTER TABLE purchases ADD COLUMN created_by_user_id INTEGER DEFAULT NULL;",
    "ALTER TABLE categories ADD COLUMN name_en TEXT DEFAULT '';",
    "ALTER TABLE subcategories ADD COLUMN name_en TEXT DEFAULT '';",
    "ALTER TABLE childcategories ADD COLUMN name_en TEXT DEFAULT '';",
    "ALTER TABLE brands ADD COLUMN name_en TEXT DEFAULT '';",
    "ALTER TABLE coupons ADD COLUMN max_discount REAL DEFAULT NULL;",
    "ALTER TABLE coupons ADD COLUMN usage_limit INTEGER DEFAULT NULL;",
  ];
  for (const stmt of additiveAlterStatements) {
    try {
      exec(stmt);
    } catch (_e) {
      // Column already exists
    }
  }

  exec(`
    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant_sku TEXT NOT NULL UNIQUE,
      size_label TEXT DEFAULT '',
      color_label TEXT DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      stock_on_hand INTEGER NOT NULL DEFAULT 0,
      stock_reserved INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      variant_id INTEGER DEFAULT NULL,
      ordered_qty INTEGER NOT NULL,
      received_qty INTEGER NOT NULL DEFAULT 0,
      returned_qty INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      receipt_no TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT 'receipt',
      total_qty INTEGER NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      received_by_user_id INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant_id INTEGER DEFAULT NULL,
      stock_pool TEXT NOT NULL DEFAULT 'warehouse',
      vendor_id INTEGER DEFAULT NULL,
      movement_type TEXT NOT NULL,
      qty_delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      unit_cost REAL DEFAULT NULL,
      reference_type TEXT DEFAULT NULL,
      reference_id INTEGER DEFAULT NULL,
      reason TEXT NOT NULL DEFAULT '',
      actor_user_id INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS stock_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant_id INTEGER DEFAULT NULL,
      stock_pool TEXT NOT NULL DEFAULT 'warehouse',
      qty INTEGER NOT NULL,
      reservation_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(reservation_key, product_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id INTEGER DEFAULT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT DEFAULT NULL,
      before_json TEXT DEFAULT NULL,
      after_json TEXT DEFAULT NULL,
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  if (env.seedDemoData) {
    seedIfEmpty();
  }

  // Ensure any seeded accounts lacking a password hash receive a non-guessable hash
  const blankVendor = get("SELECT id FROM vendors WHERE password_hash IS NULL OR password_hash = '' LIMIT 1");
  if (blankVendor) {
    const vHash = bcrypt.hashSync(crypto.randomBytes(12).toString('base64url'), 10);
    run("UPDATE vendors SET password_hash = ? WHERE password_hash IS NULL OR password_hash = ''", vHash);
  }
  const blankReseller = get("SELECT id FROM resellers WHERE password_hash IS NULL OR password_hash = '' LIMIT 1");
  if (blankReseller) {
    const rHash = bcrypt.hashSync(crypto.randomBytes(12).toString('base64url'), 10);
    run("UPDATE resellers SET password_hash = ? WHERE password_hash IS NULL OR password_hash = ''", rHash);
  }
  // Link initial demo products to Vendor #1 only when demo data is seeded
  if (env.seedDemoData) {
    const vendorProdCount = get('SELECT COUNT(*) AS c FROM products WHERE vendor_id IS NOT NULL').c;
    if (vendorProdCount === 0) {
      run('UPDATE products SET vendor_id = 1 WHERE id IN (3, 4, 12)');
    }
  }
}

function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    String(key),
    String(value ?? '')
  );
}

function seedIfEmpty() {
  const adminCount = get('SELECT COUNT(*) AS cnt FROM users').cnt;
  if (adminCount > 0) return;

  const bootstrapPass =
    env.bootstrapAdminPassword && env.bootstrapAdminPassword.length >= 8
      ? env.bootstrapAdminPassword
      : crypto.randomBytes(12).toString('base64url');
  const hash = bcrypt.hashSync(bootstrapPass, 10);

  if (env.isDevelopment && !env.bootstrapAdminPassword) {
    console.log(
      `[DEV BOOTSTRAP] Created local admin (${env.bootstrapAdminEmail}). Set BOOTSTRAP_ADMIN_PASSWORD in .env to customize.`
    );
  }

  run(
    'INSERT INTO users (name, email, phone, password_hash, role, avatar, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'Admin',
    env.bootstrapAdminEmail,
    '01700000000',
    hash,
    'Admin Head',
    '/uploads/default/user.svg',
    1
  );
  run(
    'INSERT INTO users (name, email, phone, password_hash, role, avatar, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'Order Manager',
    'manager@mrtumi.local',
    '01811223344',
    bcrypt.hashSync(crypto.randomBytes(12).toString('base64url'), 10),
    'Manager',
    '/uploads/default/user.svg',
    1
  );

  // Roles & Permissions
  run('INSERT INTO roles (name, permissions) VALUES (?, ?)', 'Super Admin', '["all"]');
  run('INSERT INTO roles (name, permissions) VALUES (?, ?)', 'Order Manager', '["orders","pos","customers","fraud_check"]');
  run('INSERT INTO roles (name, permissions) VALUES (?, ?)', 'Inventory Staff', '["products","purchases","suppliers"]');

  const perms = [
    ['dashboard.view', 'Dashboard'],
    ['orders.manage', 'Orders'],
    ['pos.access', 'POS System'],
    ['products.manage', 'Products'],
    ['crm.manage', 'CRM / HR'],
    ['finance.manage', 'Fund & Expenses'],
    ['settings.manage', 'Site Settings'],
    ['reports.view', 'Reports'],
  ];
  for (const [name, mod] of perms) {
    run('INSERT INTO permissions (name, module) VALUES (?, ?)', name, mod);
  }

  // Default Settings (Mr. Tumi Grocery & Gift — Temporary Logo Placeholders active)
  const defaultSettings = {
    site_name: 'মি. তুমি গ্রোসারি অ্যান্ড গিফট',
    site_tagline: 'নিত্যপ্রয়োজনীয় গ্রোসারি ও প্রিয়জনের উপহার — বিশ্বস্ত ডেলিভারিতে ঘরে বসেই',
    site_phone: '01711-009988',
    site_whatsapp: '8801711009988',
    site_email: 'support@mrtumi.com',
    site_address: 'ঢাকা, বাংলাদেশ',
    currency_symbol: '৳',
    inside_dhaka_charge: '60',
    outside_dhaka_charge: '120',
    free_shipping_min: '2500',
    special_notice:
      '🛒 মি. তুমি গ্রোসারি অ্যান্ড গিফট-এ স্বাগতম! তাজা গ্রোসারি, উপহার সামগ্রী ও কম্বো প্যাকে দ্রুত হোম ডেলিভারি সারা বাংলাদেশে।',
    flash_sale_end: '2027-06-30T23:59:59',
    hot_deal_end: '2027-07-15T23:59:59',
    logo_dark: '/uploads/brand/mrtumi-placeholder-logo.svg',
    logo_light: '/uploads/brand/mrtumi-placeholder-logo-light.svg',
    favicon: '/uploads/brand/mrtumi-placeholder-favicon.svg',
    bulksms_api_key: '',
    bulksms_sender_id: '',
    bulksms_balance: '0.00',
    bdcourier_api_key: '',
    bdcourier_plan: 'Not Configured',
    bdcourier_calls: '0',
    bdcourier_due_date: '—',
    steadfast_balance: '৳0.00',
    steadfast_in_review: '0',
    order_restriction_enabled: '1',
    max_orders_per_hour: '5',
    duplicate_order_block_minutes: '10',
    sale_notification_enabled: '1',
    popup_offer_enabled: '0',
    popup_offer_title: 'প্রথম অর্ডারে ১০% ছাড়! কোড: FRESH10',
    popup_offer_image: '/uploads/banner/banner-1.jpg',
    gtm_id: '',
    fb_pixel_id: '',
    fb_capi_token: '',
    tiktok_pixel_id: '',
    gemini_enabled: '1',
    gemini_model: 'gemini-2.5-flash',
    seo_meta_title: 'Mr. Tumi Grocery & Gift | মি. তুমি গ্রোসারি অ্যান্ড গিফট',
    seo_meta_description: 'নিত্যপ্রয়োজনীয় গ্রোসারি, প্রিমিয়াম গিফট হ্যাম্পার ও কম্বো প্যাক অর্ডার করুন সারা বাংলাদেশে হোম ডেলিভারিতে।',
    seo_keywords: 'Mr. Tumi Grocery & Gift, মি. তুমি, গ্রোসারি, গিফট বক্স, অনলাইন শপ বাংলাদেশ',
    smtp_host: 'smtp.gmail.com',
    smtp_port: '587',
    smtp_user: 'orders@mrtumi.com',
    smtp_from_name: 'Mr. Tumi Grocery & Gift',
    fb_ads_spend: '14500',
    fb_ads_roas: '4.6',
    google_ads_spend: '6200',
    google_ads_roas: '3.8',
    tiktok_ads_spend: '3800',
    tiktok_ads_roas: '3.2',
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    setSetting(k, v);
  }

  // Order Statuses (matching exact .sb-1 to .sb-7 classes from HTML)
  const statuses = [
    ['Pending', 'pending', 'sb-1', '#f59e0b', 1],
    ['Processing', 'processing', 'sb-2', '#3b82f6', 2],
    ['On The Way', 'on-the-way', 'sb-3', '#8b5cf6', 3],
    ['In Courier', 'in-courier', 'sb-4', '#f97316', 4],
    ['Unpaid', 'unpaid', 'sb-5', '#06b6d4', 5],
    ['Completed', 'completed', 'sb-6', '#22c55e', 6],
    ['Cancelled', 'cancelled', 'sb-7', '#ef4444', 7],
  ];
  for (const [name, slug, cls, color, order] of statuses) {
    run(
      'INSERT INTO order_statuses (name, slug, badge_class, color, sort_order) VALUES (?, ?, ?, ?, ?)',
      name,
      slug,
      cls,
      color,
      order
    );
  }

  // Categories (exact 6 categories from Dashboard - ফল বাজার.html)
  const cats = [
    ['দিনাজপুর লিচু', 'dinajpur-lichu', '🍒', '/uploads/product/lychee-fresh.jpg', 1],
    ['প্রিমিয়াম লিচু', 'premium-lichu', '🎁', '/uploads/product/lychee-box.jpg', 2],
    ['রাজশাহী লিচু', 'rajshahi-lichu', '🌿', '/uploads/product/lychee-organic.jpg', 3],
    ['বোম্বাই লিচু', 'bombai-lichu', '❤️', '/uploads/product/lychee-fresh.jpg', 4],
    ['বেদানা লিচু', 'bedana-lichu', '✨', '/uploads/product/lychee-box.jpg', 5],
    ['চায়না-৩ লিচু', 'china-3-lichu', '🥭', '/uploads/product/mango-organic.jpg', 6],
  ];
  for (const [name, slug, icon, img, sort] of cats) {
    run(
      'INSERT INTO categories (name, slug, icon, image, sort_order) VALUES (?, ?, ?, ?, ?)',
      name,
      slug,
      icon,
      img,
      sort
    );
  }

  run('INSERT INTO subcategories (category_id, name, slug) VALUES (?, ?, ?)', 1, 'বিরল বাগানের লিচু', 'birol-lichu');
  run('INSERT INTO subcategories (category_id, name, slug) VALUES (?, ?, ?)', 2, 'গিফট বক্স স্পেশাল', 'gift-box-special');
  run('INSERT INTO childcategories (subcategory_id, name, slug) VALUES (?, ?, ?)', 1, 'এক্সপোর্ট কোয়ালিটি', 'export-quality');

  run('INSERT INTO brands (name, slug) VALUES (?, ?)', 'মি. তুমি সিলেক্ট', 'mr-tumi-select');
  run('INSERT INTO brands (name, slug) VALUES (?, ?)', 'দিনাজপুর ফার্মস', 'dinajpur-farms');

  run('INSERT INTO colors (name, hex_code) VALUES (?, ?)', 'টুকটুকে লাল', '#dc2626');
  run('INSERT INTO colors (name, hex_code) VALUES (?, ?)', 'গোলাপি লাল', '#ec4899');
  run('INSERT INTO colors (name, hex_code) VALUES (?, ?)', 'সোনালী হলুদ', '#f59e0b');

  run('INSERT INTO sizes (name) VALUES (?)', '৫০০ গ্রাম (৫০ পিস)');
  run('INSERT INTO sizes (name) VALUES (?)', '১ কেজি (১০০ পিস)');
  run('INSERT INTO sizes (name) VALUES (?)', '২ কেজি ফ্যামিলি প্যাক');
  run('INSERT INTO sizes (name) VALUES (?)', '৫ কেজি কম্বো বক্স');

  // Vendors & Resellers
  run(
    'INSERT INTO vendors (shop_name, owner_name, phone, email, address, commission_rate, balance, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'দিনাজপুর অর্গানিক বাগান',
    'মোঃ রফিকুল ইসলাম',
    '01712345678',
    'rafiq@orchard.bd',
    'বিরল, দিনাজপুর',
    8,
    12400,
    1
  );
  run(
    'INSERT INTO vendors (shop_name, owner_name, phone, email, address, commission_rate, balance, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'রাজশাহী ম্যাংগো হাউস',
    'তানভীর আহমেদ',
    '01819876543',
    'tanvir@rajmango.bd',
    'বানেশ্বর, রাজশাহী',
    10,
    5600,
    0
  );

  run(
    'INSERT INTO resellers (name, shop_name, phone, email, balance, deposit_amount, verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'সাদিয়া সুলতানা',
    'ফ্রেশ ফুড কর্নার',
    '01911223344',
    'sadia@reseller.bd',
    3250,
    1000,
    1
  );

  // 16 Products matching Dashboard - ফল বাজার.html (11 in দিনাজপুর লিচু, 5 in প্রিমিয়াম লিচু!)
  const descTemplate = `গ্রীষ্মের আগমন মানেই জিভে জল আনা দেশি লিচুর মিষ্টি ঘ্রাণ! আপনার জন্য নিয়ে এসেছি বাগান থেকে সরাসরি সংগৃহীত প্রিমিয়াম মানের তাজা ফল।
• শতভাগ ফরমালিন ও ক্ষতিকর কেমিক্যালমুক্ত।
• বাগান থেকে পাড়ার ২৪ ঘণ্টার মধ্যে বিশেষ ব্রিদ্যাবল বক্সে প্যাকিং।
• রসালো, ছোট বিচি ও মিষ্টি স্বাদের নিশ্চয়তা।
• পরিবার ও প্রিয়জনদের উপহার দেওয়ার জন্য সেরা ফুড-গ্রেড প্যাকেজিং।`;

  const productsSeed = [
    // Category 1: দিনাজপুর লিচু (11 products)
    ['দেশি লিচু ফ্রেশ প্যাক', 'desi-licu-fresh-pack-246', 'P0246', 1, null, 1500, 1300, 950, 1180, 5, 961, 10, '/uploads/product/lychee-fresh.jpg', 1, 1, 1],
    ['লিচু কম্বো ফ্যামিলি বক্স', 'licu-combo-family-box-240', 'P0240', 1, null, 1900, 1300, 920, 1150, 5, 975, 8, '/uploads/product/lychee-box.jpg', 1, 1, 1],
    ['মিষ্টি রসাল লিচু প্যাক', 'mishti-rosal-licu-pack-239', 'P0239', 1, null, 1900, 1300, 900, 1150, 5, 978, 6, '/uploads/product/lychee-fresh.jpg', 1, 1, 0],
    ['গোলাপি লিচু রেগুলার প্যাক', 'golapi-licu-regular-238', 'P0238', 1, null, 450, 330, 220, 290, 10, 978, 12, '/uploads/product/lychee-organic.jpg', 1, 1, 0],
    ['অর্গানিক দেশি বাগান প্যাক', 'organic-desi-bagan-237', 'P0237', 1, null, 1600, 1300, 920, 1150, 5, 979, 4, '/uploads/product/lychee-organic.jpg', 1, 0, 0],
    ['লাল টুকটুকে লিচু প্যাক', 'lal-tuktuke-licu-236', 'P0236', 1, null, 1050, 850, 600, 760, 5, 982, 5, '/uploads/product/lychee-fresh.jpg', 0, 1, 0],
    ['হোম ডেলিভারি লিচু প্যাক', 'home-delivery-licu-pack-235', 'P0235', 1, null, 850, 650, 450, 580, 6, 985, 9, '/uploads/product/lychee-box.jpg', 1, 1, 1],
    ['বাছাই করা বড় দিনাজপুর লিচু', 'bachai-kora-boro-dinajpur-234', 'P0234', 1, null, 500, 350, 230, 310, 10, 980, 7, '/uploads/product/lychee-fresh.jpg', 0, 1, 0],
    ['দিনাজপুর প্রিমিয়াম লিচু', 'dinajpur-premium-licu-233', 'P0233', 1, null, 1900, 1300, 940, 1180, 5, 970, 11, '/uploads/product/lychee-box.jpg', 1, 1, 1],
    ['দিনাজপুর লিচু বাজেট প্যাক', 'dinajpur-licu-budget-pack-232', 'P0232', 1, null, 1200, 230, 160, 200, 10, 990, 19, '/uploads/product/lychee-organic.jpg', 1, 1, 0],
    ['দিনাজপুর বোম্বাই লিচু', 'dinajpur-bombai-licu-231', 'P0231', 1, 1, 260, 220, 150, 195, 10, 965, 14, '/uploads/product/lychee-fresh.jpg', 0, 1, 0],

    // Category 2: প্রিমিয়াম লিচু (5 products)
    ['গোলাপি লিচু স্পেশাল', 'golapi-licu-special-245', 'P0245', 2, null, 1550, 1300, 940, 1160, 5, 972, 6, '/uploads/product/lychee-box.jpg', 1, 1, 1],
    ['অর্গানিক বাগানের লিচু', 'organic-baganer-licu-244', 'P0244', 2, null, 680, 520, 360, 460, 6, 974, 8, '/uploads/product/lychee-organic.jpg', 1, 1, 0],
    ['প্রিমিয়াম লাল লিচু', 'premium-lal-licu-243', 'P0243', 2, null, 1500, 1250, 890, 1120, 5, 998, 5, '/uploads/product/lychee-fresh.jpg', 1, 1, 1],
    ['বাছাই করা বড় লিচু', 'bachai-kora-boro-licu-242', 'P0242', 2, null, 1600, 1300, 920, 1160, 5, 974, 7, '/uploads/product/lychee-box.jpg', 1, 1, 0],
    ['বাগান থেকে তাজা লিচু', 'bagan-theke-taja-licu-241', 'P0241', 2, 1, 1900, 1300, 920, 1150, 5, 977, 10, '/uploads/product/mango-organic.jpg', 1, 1, 1],
  ];

  for (const p of productsSeed) {
    run(
      `INSERT INTO products
      (name, slug, code, category_id, vendor_id, old_price, new_price, purchase_price, wholesale_price, wholesale_min_qty, stock, sold_count, image, is_flash_sale, is_hot_deal, is_wholesale, short_desc, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p[0],
      p[1],
      p[2],
      p[3],
      p[4],
      p[5],
      p[6],
      p[7],
      p[8],
      p[9],
      p[10],
      p[11],
      p[12],
      p[13],
      p[14],
      p[15],
      'বাগান থেকে সরাসরি সংগৃহীত ১০০% ফরমালিনমুক্ত সুস্বাদু ও রসালো তাজা ফল।',
      descTemplate
    );
  }

  // Customers + 30 Orders (matching exact dashboard counts: 30 total, Direct: 22, Facebook: 7, Other: 1, and exact top 9 invoices!)
  const topOrders = [
    ['32721', 'dbazar support', '01711223301', 'উত্তরা সেক্টর ১০, ঢাকা', 520, 'pending', 'Direct', '2026-10-14 14:20:00'],
    ['65215', 'Jononi Madical Hall', '01815667788', 'সদর রোড, দিনাজপুর', 240, 'pending', 'Facebook', '2026-07-17 18:10:00'],
    ['26687', 'Jononi Madical Hall', '01815667788', 'সদর রোড, দিনাজপুর', 240, 'pending', 'Direct', '2026-07-17 17:45:00'],
    ['84366', 'Md abdul Rashid', '01922334455', 'মিরপুর ১০, ঢাকা', 102, 'pending', 'Direct', '2026-07-17 15:12:00'],
    ['65297', 'shahin hasan', '01677889900', 'ধানমন্ডি ২৭, ঢাকা', 1400, 'pending', 'Facebook', '2026-07-17 13:05:00'],
    ['93037', 'shahin hasan', '01677889900', 'ধানমন্ডি ২৭, ঢাকা', 1400, 'pending', 'Direct', '2026-07-17 12:58:00'],
    ['78892', 'International Academy For Talents School', '01755443322', 'বনানী, ঢাকা', 350, 'pending', 'Direct', '2026-07-16 11:30:00'],
    ['76920', 'International Academy For Talents School', '01755443322', 'বনানী, ঢাকা', 1350, 'pending', 'Facebook', '2026-07-15 16:40:00'],
    ['76103', 'Md Ashikullah', '01533445566', 'রাজশাহী সদর', 1360, 'pending', 'Direct', '2026-07-14 10:15:00'],
  ];

  // Plus 21 more orders so total = 30 (with realistic mix & exact traffic distribution: 22 Direct, 7 Facebook, 1 Other)
  const extraNames = [
    ['মাহমুদুল হাসান', '01712998877', 'মোহাম্মদপুর, ঢাকা', 1360, 'Direct', '2026-10-24 19:30:00'],
    ['নুসরাত জাহান', '01823887766', 'বসুন্ধরা আবাসিক এলাকা, ঢাকা', 1360, 'Facebook', '2026-10-23 15:20:00'],
    ['কামরুল ইসলাম', '01934776655', 'আগ্রাবাদ, চট্টগ্রাম', 1420, 'Direct', '2026-10-22 11:10:00'],
    ['ফারহানা ইয়াসমিন', '01645665544', 'গুলশান ২, ঢাকা', 2660, 'Facebook', '2026-10-21 17:45:00'],
    ['তানভীর হোসেন', '01756554433', 'সিলেট সদর', 640, 'Direct', '2026-10-20 12:05:00'],
    ['রাশেদুল করিম', '01867443322', 'খুলনা সদর', 1420, 'Other', '2026-10-19 20:15:00'],
    ['সাবরিনা আক্তার', '01778332211', 'বাড্ডা, ঢাকা', 710, 'Direct', '2026-10-18 09:40:00'],
    ['জাহিদুল আলম', '01989221100', 'কুমিল্লা কান্দিরপাড়', 1420, 'Facebook', '2026-10-17 14:55:00'],
    ['আরিফুল হক', '01790112233', 'গাজীপুর চৌরাস্তা', 1420, 'Direct', '2026-10-16 18:22:00'],
    ['শারমিন সুলতানা', '01811334455', 'নারায়ণগঞ্জ চাষাঢ়া', 580, 'Facebook', '2026-10-15 16:00:00'],
    ['মোঃ সাইফুল ইসলাম', '01722445566', 'রংপুর সদর', 1420, 'Direct', '2026-07-13 11:20:00'],
    ['নাজমুল হুদা', '01933556677', 'বগুড়া সাতমাথা', 970, 'Direct', '2026-07-12 13:40:00'],
    ['তাসনুভা রহমান', '01644667788', 'মালিবাগ, ঢাকা', 1360, 'Direct', '2026-07-11 19:05:00'],
    ['ইমরান হোসেন', '01755778899', 'যাত্রাবাড়ী, ঢাকা', 410, 'Direct', '2026-07-10 10:50:00'],
    ['রুবাইয়া খান', '01866889900', 'কল্যাণপুর, ঢাকা', 1360, 'Direct', '2026-07-09 15:30:00'],
    ['সোহেল রানা', '01977990011', 'ময়মনসিংহ সদর', 1420, 'Direct', '2026-07-08 12:15:00'],
    ['আফরোজা বেগম', '01788001122', 'সাভার, ঢাকা', 770, 'Direct', '2026-07-07 17:10:00'],
    ['মেহেদী হাসান', '01899112233', 'টঙ্গী, গাজীপুর', 1370, 'Direct', '2026-07-06 14:25:00'],
    ['হাবিবুর রহমান', '01710223344', 'যশোর সদর', 1420, 'Direct', '2026-07-05 11:45:00'],
    ['তানজিলা আক্তার', '01921334455', 'রামপুরা, ঢাকা', 580, 'Direct', '2026-07-04 16:35:00'],
    ['আব্দুল্লাহ আল মামুন', '01732445566', 'ফরিদপুর সদর', 1420, 'Direct', '2026-07-03 09:50:00'],
  ];

  // Insert extra older/recent orders first so topOrders have the highest IDs and appear at top of Recent Orders!
  let invCounter = 41010;
  for (const [name, phone, addr, amt, src, dt] of [...extraNames].reverse()) {
    invCounter += 217;
    const ship = addr.includes('ঢাকা') ? 60 : 120;
    const sub = Math.max(amt - ship, 100);
    const res = run(
      `INSERT INTO orders
      (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, amount, status, traffic_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      String(invCounter),
      name,
      phone,
      addr,
      ship === 60 ? 'ঢাকার ভিতরে' : 'ঢাকার বাইরে',
      ship,
      sub,
      amt,
      src,
      dt
    );
    run(
      `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size)
       VALUES (?, 1, 'দেশি লিচু ফ্রেশ প্যাক', '/uploads/product/lychee-fresh.jpg', ?, 1, '১ কেজি')`,
      res.lastInsertRowid,
      sub
    );
  }

  for (const [inv, name, phone, addr, amt, st, src, dt] of [...topOrders].reverse()) {
    const ship = addr.includes('ঢাকা') ? 60 : 120;
    const sub = Math.max(amt - ship, 50);
    const res = run(
      `INSERT INTO orders
      (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, amount, status, traffic_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      inv,
      name,
      phone,
      addr,
      ship === 60 ? 'ঢাকার ভিতরে' : 'ঢাকার বাইরে',
      ship,
      sub,
      amt,
      st,
      src,
      dt
    );
    run(
      `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size)
       VALUES (?, 12, 'অর্গানিক বাগানের লিচু', '/uploads/product/lychee-organic.jpg', ?, 1, '১ কেজি')`,
      res.lastInsertRowid,
      sub
    );

    const existingCust = get('SELECT id FROM customers WHERE phone = ?', phone);
    if (!existingCust) {
      run(
        'INSERT INTO customers (name, phone, address, total_orders) VALUES (?, ?, ?, 1)',
        name,
        phone,
        addr
      );
    } else {
      run('UPDATE customers SET total_orders = total_orders + 1 WHERE id = ?', existingCust.id);
    }
  }

  // Incomplete Orders
  run(
    'INSERT INTO incomplete_orders (customer_name, phone, address, cart_summary, estimated_amount) VALUES (?, ?, ?, ?, ?)',
    'রাকিবুল হাসান',
    '01799887711',
    'মিরপুর ১২, ঢাকা',
    'দেশি লিচু ফ্রেশ প্যাক × ২',
    2600
  );

  // Refunds
  run(
    'INSERT INTO refunds (invoice_id, customer_name, phone, amount, reason, method, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    '76920',
    'International Academy For Talents School',
    '01755443322',
    350,
    'বক্সের কিছু লিচু পরিবহনে ক্ষতিগ্রস্ত হয়েছে',
    'bKash',
    'pending'
  );

  // Coupons
  run(
    'INSERT INTO coupons (code, type, value, min_purchase, expiry_date, status) VALUES (?, ?, ?, ?, ?, ?)',
    'FRESH10',
    'percent',
    10,
    500,
    '2027-12-31',
    1
  );
  run(
    'INSERT INTO coupons (code, type, value, min_purchase, expiry_date, status) VALUES (?, ?, ?, ?, ?, ?)',
    'LICHU100',
    'flat',
    100,
    1000,
    '2027-12-31',
    1
  );

  // Reviews (2 pending matching sidebar "Pending Reviews (2)" + approved reviews)
  run(
    'INSERT INTO reviews (product_id, customer_name, rating, comment, status) VALUES (?, ?, ?, ?, ?)',
    1,
    'মাহমুদুল হাসান',
    5,
    'আলহামদুলিল্লাহ! একদম বাগানের তাজা ও মিষ্টি লিচু পেয়েছি। প্যাকেজিং অসাধারণ ছিল।',
    'approved'
  );
  run(
    'INSERT INTO reviews (product_id, customer_name, rating, comment, status) VALUES (?, ?, ?, ?, ?)',
    2,
    'ফারহানা ইয়াসমিন',
    5,
    'ফ্যামিলি কম্বো বক্সটি উপহার হিসেবে পাঠিয়েছিলাম, সবাই খুব প্রশংসা করেছে।',
    'pending'
  );
  run(
    'INSERT INTO reviews (product_id, customer_name, rating, comment, status) VALUES (?, ?, ?, ?, ?)',
    12,
    'নুসরাত জাহান',
    4,
    'লিচুগুলো খুবই রসালো এবং সাইজে বড়। ডেলিভারি আরেকটু দ্রুত হলে দারুণ হতো।',
    'pending'
  );

  // Fund & Expenses matching Dashboard Finance Summary: Fund Balance ৳84,551, Total Expenses ৳300!
  run(
    'INSERT INTO fund_transactions (account_name, type, amount, note, tx_date) VALUES (?, ?, ?, ?, ?)',
    'Main Business Fund',
    'credit',
    84851,
    'প্রারম্ভিক ক্যাপিটাল ও বিক্রয় জমা',
    '2026-10-01'
  );
  run(
    'INSERT INTO fund_transactions (account_name, type, amount, note, tx_date) VALUES (?, ?, ?, ?, ?)',
    'Main Business Fund',
    'debit',
    300,
    'প্যাকেজিং টেপ ও মার্কার ক্রয়',
    '2026-09-28'
  );
  run(
    'INSERT INTO expenses (title, category, amount, note, expense_date) VALUES (?, ?, ?, ?, ?)',
    'প্যাকেজিং টেপ ও মার্কার ক্রয়',
    'প্যাকেজিং',
    300,
    'কুরিয়ার বক্স প্যাকিং খরচ',
    '2026-09-28'
  );

  // Suppliers & Purchases
  run(
    'INSERT INTO suppliers (name, company, phone, address, balance_due) VALUES (?, ?, ?, ?, ?)',
    'হাজী মোঃ আব্দুল করিম',
    'বিরল লিচু বাগান সাপ্লাই',
    '01714556677',
    'মাধববাটি, বিরল, দিনাজপুর',
    4500
  );
  run(
    'INSERT INTO purchases (reference_no, supplier_id, product_id, qty, unit_cost, total_cost, paid_amount, purchase_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'PUR-2026-001',
    1,
    1,
    100,
    850,
    85000,
    80500,
    '2026-10-10'
  );

  // CRM / HR
  run(
    'INSERT INTO employees (name, designation, phone, email, base_salary, join_date) VALUES (?, ?, ?, ?, ?, ?)',
    'মোঃ আরিফ হোসেন',
    'অর্ডার এক্সিকিউটিভ',
    '01744112233',
    'arif@pholbazar.com',
    16000,
    '2026-02-01'
  );
  run(
    'INSERT INTO employees (name, designation, phone, email, base_salary, join_date) VALUES (?, ?, ?, ?, ?, ?)',
    'সুমাইয়া আক্তার',
    'কাস্টমার সাপোর্ট',
    '01855223344',
    'sumaiya@pholbazar.com',
    15000,
    '2026-03-15'
  );
  run(
    'INSERT INTO attendances (employee_id, att_date, check_in, check_out, status) VALUES (?, ?, ?, ?, ?)',
    1,
    '2026-10-25',
    '09:02 AM',
    '06:05 PM',
    'Present'
  );
  run(
    'INSERT INTO salaries (employee_id, month, basic_amount, bonus, deduction, net_salary, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    1,
    'September 2026',
    16000,
    1500,
    0,
    17500,
    'paid'
  );
  run(
    'INSERT INTO bonuses (employee_id, title, amount) VALUES (?, ?, ?)',
    1,
    'লিচু সিজন পারফরম্যান্স বোনাস',
    1500
  );

  // Delivery Module
  run(
    'INSERT INTO delivery_boys (name, phone, area, vehicle_type, commission_per_order, balance) VALUES (?, ?, ?, ?, ?, ?)',
    'মোঃ রুবেল মিয়া',
    '01766998877',
    'উত্তরা - মিরপুর জোন',
    'মোটরসাইকেল',
    50,
    850
  );
  const locs = [
    ['ঢাকা', 'ঢাকা', 'উত্তরা', 60],
    ['ঢাকা', 'ঢাকা', 'ধানমন্ডি', 60],
    ['ঢাকা', 'ঢাকা', 'মিরপুর', 60],
    ['রংপুর', 'দিনাজপুর', 'বিরল', 120],
    ['রাজশাহী', 'রাজশাহী', 'বোয়ালিয়া', 120],
    ['চট্টগ্রাম', 'চট্টগ্রাম', 'পাঁচলাইশ', 120],
  ];
  for (const [div, dist, upz, chg] of locs) {
    run(
      'INSERT INTO delivery_locations (division, district, upazila, delivery_charge) VALUES (?, ?, ?, ?)',
      div,
      dist,
      upz,
      chg
    );
  }

  // Banners
  run(
    'INSERT INTO banners (title, subtitle, position, image, link, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    'দিনাজপুরের বাগান থেকে সরাসরি তাজা লিচু!',
    '১০০% ফরমালিনমুক্ত • রসালো ও মিষ্টি • সারা দেশে হোম ডেলিভারি',
    'hero',
    '/uploads/banner/banner-1.jpg',
    '/category/dinajpur-lichu',
    1
  );
  run(
    'INSERT INTO banners (title, subtitle, position, image, link, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    'প্রিমিয়াম ফ্যামিলি গিফট বক্স ও অর্গানিক আম',
    'প্রিয়জনদের পাঠান বাগানের সেরা মৌসুমি ফলের উপহার',
    'hero',
    '/uploads/banner/banner-2.jpg',
    '/category/premium-lichu',
    2
  );
  run(
    'INSERT INTO banners (title, subtitle, position, image, link, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    'স্পেশাল কম্বো অফার — সীমিত সময়ের জন্য ৩২% পর্যন্ত ছাড়!',
    'এখনই অর্ডার করুন, পণ্য হাতে পেয়ে মূল্য পরিশোধ করুন',
    'promo_mid',
    '/uploads/banner/banner-2.jpg',
    '/flash-sales',
    3
  );

  // Campaign / Landing Page
  run(
    `INSERT INTO campaigns (title, slug, product_id, headline, subheadline, banner_image, offer_price, regular_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'দিনাজপুর স্পেশাল ফ্যামিলি লিচু বক্স ক্যাম্পেইন',
    'dinajpur-lichu-special',
    2,
    'বাগান থেকে সরাসরি ১০০% কেমিক্যালমুক্ত দিনাজপুরের রসালো লিচু এখন আপনার ঘরে!',
    'গাছপাকা টসটসে লাল লিচু — অর্ডার করতে অগ্রিম ১ টাকাও দিতে হবে না, ফল হাতে দেখে মূল্য পরিশোধ করুন।',
    '/uploads/banner/banner-1.jpg',
    1300,
    1900
  );

  // Blogs
  run(
    'INSERT INTO blogs (title, slug, category, image, excerpt, content) VALUES (?, ?, ?, ?, ?, ?)',
    'ফরমালিনমুক্ত আসল দিনাজপুরের লিচু চেনার ৫টি সহজ উপায়',
    'how-to-identify-organic-dinajpur-lychee',
    'ফল ও স্বাস্থ্য',
    '/uploads/banner/banner-1.jpg',
    'বাজারে কৃত্রিম রঙ ও কেমিক্যালযুক্ত লিচুর ভিড়ে আসল গাছপাকা লিচু চিনে নেওয়ার কৌশল জানুন।',
    'গাছপাকা প্রাকৃতিক লিচুর খোসার রঙ কখনোই একদম কৃত্রিম উজ্জ্বল সিঁদুর লাল হয় না; বরং লালচে-গোলাপি ও হালকা সবুজাভ আভা থাকে। বোঁটা ও পাতা সতেজ থাকে এবং খোসা ছাড়ালে প্রাকৃতিক মিষ্টি ঘ্রাণ পাওয়া যায়।'
  );

  // Payment Gateways (exact list from customer checkout!)
  const gateways = [
    ['ক্যাশ অন ডেলিভারি', 'cod', 'auto', '', 'পণ্য হাতে পেয়ে ডেলিভারি ম্যানের কাছে মূল্য পরিশোধ করুন', 1],
    ['bKash পেমেন্ট', 'bkash_auto', 'auto', '', 'বিকাশ অনলাইন গেটওয়ে দ্বারা তাৎক্ষণিক পেমেন্ট', 1],
    ['ShurjoPay', 'shurjopay', 'auto', '', 'Card / Mobile Banking / Internet Banking', 1],
    ['UddoktaPay', 'uddoktapay', 'auto', '', 'মোবাইল ব্যাংকিং অটোমেটিক পেমেন্ট গেটওয়ে', 1],
    ['aamarPay', 'aamarpay', 'auto', '', 'ভিসা/মাস্টারকার্ড ও মোবাইল ব্যাংকিং', 1],
    ['Manual Bkash', 'manual_bkash', 'manual', '01711-009988 (Personal)', 'উপরের বিকাশ পার্সোনাল নম্বরে Send Money করে নিচে Transaction ID দিন।', 1],
    ['Nagad Manual', 'manual_nagad', 'manual', '01711-009988 (Personal)', 'উপরের নগদ পার্সোনাল নম্বরে Send Money করে নিচে Transaction ID দিন।', 1],
    ['Rocket Personal', 'manual_rocket', 'manual', '01711-009988-9', 'উপরের রকেট নম্বরে Send Money করে নিচে Transaction ID দিন।', 1],
  ];
  for (const [name, code, type, acc, inst, st] of gateways) {
    run(
      'INSERT INTO payment_gateways (name, code, type, account_number, instructions, status) VALUES (?, ?, ?, ?, ?, ?)',
      name,
      code,
      type,
      acc,
      inst,
      st
    );
  }

  // Courier APIs (unconfigured by default — credentials configured via Admin / .env in Phase 10)
  const couriers = [
    ['Steadfast Courier', 'steadfast', '', '', 'https://portal.packzy.com/api/v1', 0, 0],
    ['Pathao Courier', 'pathao', '', '', 'https://api-hermes.pathao.com', 0, 0],
    ['RedX Courier', 'redx', '', '', 'https://openapi.redx.com.bd/v1.0.0-beta', 0, 0],
  ];
  for (const [name, code, key, sec, url, bal, st] of couriers) {
    run(
      'INSERT INTO courier_apis (name, code, api_key, secret_key, base_url, balance, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name,
      code,
      key,
      sec,
      url,
      bal,
      st
    );
  }

  // Features (exact 4 features from storefront footer!)
  const feats = [
    ['খাঁটি অর্গানিক ফল', 'প্রাকৃতিক ও নিরাপদ উপাদান।', 'check-circle'],
    ['দ্রুত ডেলিভারি', 'সারা দেশে দ্রুত পৌঁছে যায়।', 'truck'],
    ['নিরাপদ পেমেন্ট', '১০০% সুরক্ষিত লেনদেন ব্যবস্থা।', 'shield'],
    ['সহজ সাপোর্ট', 'দ্রুত সহায়তা সবসময় প্রস্তুত।', 'headphones'],
  ];
  for (const [t, s, ic] of feats) {
    run('INSERT INTO features (title, subtitle, icon) VALUES (?, ?, ?)', t, s, ic);
  }

  // CMS Pages (Draft copy — flagged in UI as pending owner legal/editorial review)
  const pages = [
    ['আমাদের সম্পর্কে', 'about-us', 'মি. তুমি গ্রোসারি অ্যান্ড গিফট বাংলাদেশের পরিবারের জন্য একটি বিশ্বস্ত অনলাইন গ্রোসারি ও উপহার শপ। বাছাইকৃত নিত্যপণ্য ও উপহার সামগ্রী যত্নসহকারে গ্রাহকের ঠিকানায় পৌঁছে দেওয়াই আমাদের লক্ষ্য।'],
    ['রিটার্ন ও রিফান্ড পলিসি', 'return-policy', 'ডেলিভারি গ্রহণের সময় পণ্য যাচাই করে নিন। কোনো পণ্য ক্ষতিগ্রস্ত বা ত্রুটিপূর্ণ থাকলে আমাদের সাপোর্ট টিমে জানালে নীতিমালা অনুযায়ী সমাধান প্রদান করা হয়।'],
    ['গোপনীয়তা নীতি', 'privacy-policy', 'আপনার নাম, মোবাইল নম্বর ও ঠিকানা শুধুমাত্র অর্ডার প্রক্রিয়াকরণ, ডেলিভারি ও গ্রাহক সহায়তার কাজে ব্যবহৃত হয়।'],
    ['শর্তাবলী', 'terms-conditions', 'মি. তুমি গ্রোসারি অ্যান্ড গিফট থেকে অর্ডার করার মাধ্যমে আপনি আমাদের ডেলিভারি ও পেমেন্ট নীতিমালার সাথে সম্মতি প্রদান করছেন।'],
  ];
  for (const [t, slug, c] of pages) {
    run('INSERT INTO cms_pages (title, slug, content) VALUES (?, ?, ?)', t, slug, c);
  }

  // Social Links
  run('INSERT INTO social_links (platform, url, icon) VALUES (?, ?, ?)', 'Facebook', 'https://facebook.com', 'facebook');
  run('INSERT INTO social_links (platform, url, icon) VALUES (?, ?, ?)', 'WhatsApp', 'https://wa.me/8801711009988', 'message-circle');
  run('INSERT INTO social_links (platform, url, icon) VALUES (?, ?, ?)', 'YouTube', 'https://youtube.com', 'youtube');

  // Complaints & Contact Messages sample
  run(
    'INSERT INTO complaints (name, phone, invoice_id, details, status) VALUES (?, ?, ?, ?, ?)',
    'শফিকুল ইসলাম',
    '01719882233',
    '78892',
    'কুরিয়ার ডেলিভারি ম্যান ফোন না দিয়েই ডেলিভারি রিশিডিউল করেছে। দ্রুত সমাধান চাই।',
    'pending'
  );
  run(
    'INSERT INTO contact_messages (name, phone, email, subject, message) VALUES (?, ?, ?, ?, ?)',
    'মেহেদী করিম',
    '01833445599',
    'mehedi@example.com',
    'পাইকারি ৫০ কেজি লিচু অর্ডার প্রসঙ্গে',
    'আমাদের কর্পোরেট অফিসের জন্য ৫০ কেজি প্রিমিয়াম লিচু গিফট বক্স প্রয়োজন। বিশেষ ডিসকাউন্ট পাওয়া যাবে কি?'
  );
  run('INSERT INTO newsletter_subscribers (email_or_phone) VALUES (?)', '01711223344');
  run('INSERT INTO error_logs (level, message, context) VALUES (?, ?, ?)', 'INFO', 'System initialized cleanly with SQLite WAL mode', 'boot');
}

module.exports = {
  get rawDb() {
    return getRawDb();
  },
  assertSqliteAllowed,
  getRawDb,
  all,
  get,
  run,
  exec,
  initializeDatabase,
  getSettings,
  setSetting,
};
