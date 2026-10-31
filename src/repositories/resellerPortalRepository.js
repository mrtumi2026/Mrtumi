'use strict';

const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
const { requirePositiveInt } = require('../utils/validator');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { normalizeBdPhone } = require('./customerRepository');

function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Reseller portal repository requires MySQL.');
}

function client(pool) {
  return createQueryClient(pool || getPool());
}

function text(value, label, max, { required = false } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
  const out = value.trim();
  if ((required && !out) || out.length > max) {
    throw new ValidationError(`${label} is required and must not exceed ${max} characters.`);
  }
  return out;
}

function validEmail(value) {
  const email = text(value || '', 'Email', 191);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('Enter a valid email address.');
  }
  return email.toLowerCase();
}

function validPassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 72) {
    throw new ValidationError('Password must contain 10–72 characters.');
  }
  return password;
}

async function authenticate(identifier, password, pool) {
  assertMysql();
  const key = String(identifier || '').trim();
  if (!key || String(password || '').length > 72) return null;
  let phone = key;
  try { phone = normalizeBdPhone(key); } catch { /* The identifier can be an email; phone lookup then falls back to the exact value. */ }
  const row = await client(pool).queryOne(
    'SELECT id,name,shop_name,phone,email,password_hash,verified FROM resellers WHERE status=1 AND (LOWER(email)=LOWER(?) OR phone=?) LIMIT 1',
    [key, phone]
  );
  if (!row || !row.password_hash || !(await bcrypt.compare(String(password || ''), row.password_hash))) return null;
  return {
    id: Number(row.id),
    name: row.name,
    shop_name: row.shop_name,
    phone: row.phone,
    email: row.email || '',
    verified: Number(row.verified),
  };
}

async function register(input, pool) {
  assertMysql();
  const name = text(input.name, 'Name', 191, { required: true });
  const shop = text(input.shop_name || '', 'Shop name', 191);
  const phone = normalizeBdPhone(input.phone);
  const email = validEmail(input.email || '');
  const passwordHash = await bcrypt.hash(validPassword(input.password), 12);

  try {
    return await withTransaction(async (tx) => {
      const result = await tx.execute(
        'INSERT INTO resellers(name,shop_name,phone,email,password_hash,verified,status) VALUES(?,?,?,?,?,0,1)',
        [name, shop, phone, email || null, passwordHash]
      );
      await tx.execute(
        "INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES('reseller',?,'reseller.account.registered','reseller',?,'{}',?)",
        [result.insertId, String(result.insertId), JSON.stringify({ created: true, verified: false })]
      );
      return { id: Number(result.insertId), name, shop_name: shop, phone, email, verified: 0 };
    }, { pool });
  } catch (error) {
    if (error.code === 'DB_DUPLICATE_ENTRY') {
      throw new ConflictError('An account already exists for this phone number.');
    }
    throw error;
  }
}

async function getProfile(resellerId, pool) {
  assertMysql();
  const id = requirePositiveInt(resellerId, 'Reseller ID');
  const row = await client(pool).queryOne(
    'SELECT id,name,shop_name,phone,email,balance_paisa,deposit_paisa,verified,status,created_at FROM resellers WHERE id=? AND status=1',
    [id]
  );
  if (!row) throw new NotFoundError('Reseller account not found.');
  return { ...row, id: Number(row.id), email: row.email || '' };
}

async function updateProfile(resellerId, input, pool) {
  assertMysql();
  const id = requirePositiveInt(resellerId, 'Reseller ID');
  const name = text(input.name, 'Name', 191, { required: true });
  const shop = text(input.shop_name || '', 'Shop name', 191);
  const email = validEmail(input.email || '');
  const password = input.new_password ? validPassword(input.new_password) : null;
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;

  return withTransaction(async (tx) => {
    const before = await tx.queryOne(
      'SELECT id,name,shop_name,email FROM resellers WHERE id=? AND status=1 FOR UPDATE',
      [id]
    );
    if (!before) throw new NotFoundError('Reseller account not found.');

    await tx.execute(
      'UPDATE resellers SET name=?,shop_name=?,email=? WHERE id=? AND status=1',
      [name, shop, email || null, id]
    );
    if (passwordHash) {
      await tx.execute('UPDATE resellers SET password_hash=? WHERE id=? AND status=1', [passwordHash, id]);
    }
    await tx.execute(
      "INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES('reseller',?,'reseller.profile.updated','reseller',?,?,?)",
      [
        id,
        String(id),
        JSON.stringify({ name: before.name, shop_name: before.shop_name, email: before.email || null }),
        JSON.stringify({ name, shop_name: shop, email: email || null, password_changed: Boolean(passwordHash) }),
      ]
    );
    return { id, name, shop_name: shop, email };
  }, { pool });
}

function pagination(pageInput, perPageInput) {
  const raw = Number(pageInput || 1);
  const perPage = Number(perPageInput || 20);
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 1000000) {
    throw new ValidationError('Page must be a positive whole number.');
  }
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 50) {
    throw new ValidationError('Page size must be between 1 and 50.');
  }
  return { page: raw, perPage };
}

async function getDashboardSummary(resellerId, pool) {
  assertMysql();
  const id = requirePositiveInt(resellerId, 'Reseller ID');
  return client(pool).queryOne(
    "SELECT COUNT(*) AS total_orders,SUM(order_status IN ('delivered','completed')) AS delivered_orders,SUM(order_status IN ('pending','confirmed','processing')) AS pending_orders FROM orders WHERE reseller_id=?",
    [id]
  );
}

async function listOrders(resellerId, { page: pageInput = 1, perPage: perPageInput = 20, status = '', search = '' } = {}, pool) {
  assertMysql();
  const ownerId = requirePositiveInt(resellerId, 'Reseller ID');
  const { page: requestedPage, perPage } = pagination(pageInput, perPageInput);
  const cleanStatus = text(status || '', 'Status', 32);
  if (cleanStatus && !/^[a-z0-9_-]{1,32}$/.test(cleanStatus)) {
    throw new ValidationError('Order status filter must be a status slug.');
  }
  const query = text(search || '', 'Search', 80);
  const db = client(pool);
  const where = ['reseller_id=?'];
  const args = [ownerId];
  if (cleanStatus) {
    where.push('order_status=?');
    args.push(cleanStatus);
  }
  if (query) {
    where.push('(invoice_no LIKE ? OR customer_name LIKE ?)');
    args.push(`%${query}%`, `%${query}%`);
  }
  const clause = where.join(' AND ');
  const count = await db.queryOne(`SELECT COUNT(*) AS total FROM orders WHERE ${clause}`, args);
  const total = Number(count.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(requestedPage, totalPages);
  const orders = await db.queryAll(
    `SELECT o.id,o.invoice_no AS invoice_id,o.customer_name,o.customer_phone AS phone,o.shipping_address AS address,o.total_paisa AS amount_paisa,o.reseller_margin_paisa AS reseller_margin_paisa,o.order_status AS status,COALESCE(os.name,o.order_status) AS status_label,COALESCE(os.badge_class,CASE WHEN o.order_status IN ('delivered','completed') THEN 'sb-6' WHEN o.order_status='cancelled' THEN 'sb-7' ELSE 'sb-1' END) AS badge_class,o.courier_code AS courier_name,o.courier_tracking_id,o.created_at FROM orders o LEFT JOIN order_statuses os ON os.slug=o.order_status WHERE ${clause} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...args, perPage, (page - 1) * perPage]
  );
  return { orders, page, perPage, total, totalPages, status: cleanStatus, search: query };
}

async function getOrderDetails(resellerId, orderId, pool) {
  assertMysql();
  const ownerId = requirePositiveInt(resellerId, 'Reseller ID');
  const id = requirePositiveInt(orderId, 'Order ID');
  const db = client(pool);
  const order = await db.queryOne(
    'SELECT id,invoice_no AS invoice_id,customer_name,customer_phone AS phone,shipping_address AS address,order_status AS status,payment_method,payment_status,total_paisa,paid_paisa,cod_due_paisa,created_at FROM orders WHERE id=? AND reseller_id=?',
    [id, ownerId]
  );
  if (!order) throw new NotFoundError('Reseller order not found.');
  const items = await db.queryAll(
    'SELECT product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label,color_label FROM order_items WHERE order_id=? ORDER BY id',
    [id]
  );
  return { order, items };
}

async function listTransactions(resellerId, type = '', { page: pageInput = 1, perPage: perPageInput = 20 } = {}, pool) {
  assertMysql();
  const ownerId = requirePositiveInt(resellerId, 'Reseller ID');
  const txType = text(type || '', 'Transaction type', 40);
  if (txType && !/^[a-z0-9_-]{1,40}$/.test(txType)) {
    throw new ValidationError('Transaction type must be a type slug.');
  }
  const { page: requestedPage, perPage } = pagination(pageInput, perPageInput);
  const db = client(pool);
  const where = ['reseller_id=?'];
  const args = [ownerId];
  if (txType) {
    where.push('tx_type=?');
    args.push(txType);
  }
  const clause = where.join(' AND ');
  const count = await db.queryOne(`SELECT COUNT(*) AS total FROM reseller_transactions WHERE ${clause}`, args);
  const total = Number(count.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(requestedPage, totalPages);
  const transactions = await db.queryAll(
    `SELECT id,tx_type,amount_paisa,method,trx_id,status,reference_order_id,created_at FROM reseller_transactions WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, perPage, (page - 1) * perPage]
  );
  return { transactions, page, perPage, total, totalPages, type: txType };
}

async function listPublicProducts(search = '', pool) {
  assertMysql();
  const query = text(search || '', 'Search', 80);
  return client(pool).queryAll(
    `SELECT p.id,p.sku,p.slug,p.name_bn AS name,p.name_bn,p.name_en,p.image_url AS image,p.unit_label AS sizes,(p.stock_on_hand-p.stock_reserved+p.vendor_stock_on_hand-p.vendor_stock_reserved) AS available_stock,p.sold_count,c.name_bn AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.status=1 AND p.is_archived=0 AND p.approval_status='approved' AND (p.stock_on_hand-p.stock_reserved+p.vendor_stock_on_hand-p.vendor_stock_reserved)>0 AND (?='' OR p.name_bn LIKE ? OR p.name_en LIKE ?) ORDER BY p.sold_count DESC,p.id LIMIT 100`,
    [query, `%${query}%`, `%${query}%`]
  );
}

module.exports = {
  authenticate,
  register,
  getProfile,
  updateProfile,
  getDashboardSummary,
  listOrders,
  getOrderDetails,
  listTransactions,
  listPublicProducts,
  pagination,
};
