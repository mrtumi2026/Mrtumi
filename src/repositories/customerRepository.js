'use strict';

const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { requirePositiveInt } = require('../utils/validator');

function normalizeBdPhone(value) {
  let digits = String(value || '').trim().replace(/[\s()-]/g, '');
  if (digits.startsWith('+880')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('880')) digits = `0${digits.slice(3)}`;
  if (!/^01[3-9]\d{8}$/.test(digits)) throw new ValidationError('Enter a valid Bangladesh mobile number.');
  return digits;
}
function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 72) throw new ValidationError('Password must contain 10–72 characters.');
  return password;
}
function mysqlClient() {
  if (env.db.client !== 'mysql') throw new Error('Customer account functions require the MySQL production adapter.');
  return createQueryClient(getPool());
}
async function registerCustomer({ name, phone, password, email = '', policyVersion = '', evidence = {} }) {
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2 || cleanName.length > 191) throw new ValidationError('Name must contain 2–191 characters.');
  const cleanPhone = normalizeBdPhone(phone);
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanEmail && (cleanEmail.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) throw new ValidationError('Enter a valid email address of at most 191 characters.');
  const hash = await bcrypt.hash(validatePassword(password), 12);
  try {
    return await withTransaction(async (tx) => {
      const result = await tx.execute(
        'INSERT INTO `customers` (`name`, `phone`, `email`, `password_hash`) VALUES (?, ?, ?, ?)',
        [cleanName, cleanPhone, cleanEmail || null, hash]
      );
      const id = result.insertId;
      if (policyVersion) {
        const policy = await tx.queryOne("SELECT version FROM privacy_policy_versions WHERE version=? AND status='published' FOR UPDATE", [String(policyVersion)]);
        if (!policy) throw new ConflictError('The privacy notice changed. Reload the registration form and review the current version.');
        await tx.execute('INSERT INTO customer_policy_acceptances(customer_id,policy_version,source,evidence_json) VALUES(?,?,?,?)', [id, policy.version, 'registration', JSON.stringify({ accepted: true, ip: String(evidence.ip || '').slice(0,64), userAgent: String(evidence.userAgent || '').slice(0,255) })]);
        await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('customer',?,'privacy.policy.accepted','customer_policy_acceptance',?,?,?,?)", [id, String(id), JSON.stringify({ policy_version: policy.version, source: 'registration' }), String(evidence.ip || '').slice(0,64), String(evidence.userAgent || '').slice(0,255)]);
      }
      await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('customer',?,'customer.account.registered','customer',?,?,?,?)", [id, String(id), JSON.stringify({ account_created: true, policy_accepted: Boolean(policyVersion) }), String(evidence.ip || '').slice(0,64), String(evidence.userAgent || '').slice(0,255)]);
      return { id, name: cleanName, phone: cleanPhone };
    });
  } catch (err) {
    if (err.code === 'DB_DUPLICATE_ENTRY') throw new ConflictError('An account already exists for this phone number.');
    throw err;
  }
}
async function issueCustomerRecovery(identifier, channel, deliver, { pool = null } = {}) {
  if (!['email','phone'].includes(channel) || typeof deliver !== 'function') throw new ValidationError('A verified recovery channel and configured delivery provider are required.');
  const key = String(identifier || '').trim();
  if (!key || key.length > 191) return { accepted: true };
  const match = channel === 'phone' ? normalizeBdPhone(key) : key.toLowerCase();
  if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(match)) return { accepted: true };
  const rawToken = require('node:crypto').randomBytes(32).toString('base64url');
  const tokenHash = require('node:crypto').createHash('sha256').update(rawToken).digest('hex');
  let issue = null;
  await withTransaction(async (tx) => {
    const verifiedColumn = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
    const customer = await tx.queryOne(`SELECT id,${channel} AS destination FROM customers WHERE ${channel}=? AND ${verifiedColumn} IS NOT NULL AND status=1 AND is_blocked=0 LIMIT 1 FOR UPDATE`, [match]);
    if (!customer) return;
    const result = await tx.execute('INSERT INTO customer_recovery_tokens(customer_id,channel,token_hash,expires_at) VALUES(?,?,?,DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 20 MINUTE))',[customer.id,channel,tokenHash]);
    await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json) VALUES('system',?,'customer.recovery.issued','customer_recovery_token',?,?)",[customer.id,String(result.insertId),JSON.stringify({channel,expires_minutes:20})]);
    issue = { id:result.insertId,customerId:Number(customer.id),destination:customer.destination };
  },{pool});
  if (!issue) return { accepted:true };
  try { await deliver({ channel, destination:issue.destination, token:rawToken, expiresInSeconds:1200 }); }
  catch (_error) {
    const db=createQueryClient(pool||getPool());
    await db.execute('UPDATE customer_recovery_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND consumed_at IS NULL',[issue.id]);
    return { accepted:true };
  }
  return { accepted:true };
}
async function consumeCustomerRecoveryToken(token, password, { pool = null } = {}) {
  const raw=String(token||'');
  if(!raw||raw.length>160)throw new ValidationError('Recovery link is invalid or expired.');
  const tokenHash=require('node:crypto').createHash('sha256').update(raw).digest('hex');
  const passwordHash=await bcrypt.hash(validatePassword(password),12);
  return withTransaction(async tx=>{
    const row=await tx.queryOne('SELECT id,customer_id,expires_at,consumed_at,revoked_at FROM customer_recovery_tokens WHERE token_hash=? FOR UPDATE',[tokenHash]);
    if(!row||row.consumed_at||row.revoked_at||new Date(row.expires_at).getTime()<=Date.now())throw new ValidationError('Recovery link is invalid or expired.');
    const customer=await tx.queryOne('SELECT id FROM customers WHERE id=? AND status=1 AND is_blocked=0 FOR UPDATE',[row.customer_id]);
    if(!customer)throw new ValidationError('Recovery link is invalid or expired.');
    await tx.execute('UPDATE customers SET password_hash=? WHERE id=?',[passwordHash,row.customer_id]);
    await tx.execute('UPDATE customer_recovery_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE id=?',[row.id]);
    await tx.execute('UPDATE customer_recovery_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE customer_id=? AND id<>? AND consumed_at IS NULL AND revoked_at IS NULL',[row.customer_id,row.id]);
    await tx.execute("DELETE FROM web_sessions WHERE actor_type='customer' AND actor_id=?",[row.customer_id]);
    await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json) VALUES('customer',?,'customer.recovery.completed','customer',?,?)",[row.customer_id,String(row.customer_id),JSON.stringify({password_changed:true,active_sessions_revoked:true})]);
    return {customerId:Number(row.customer_id)};
  },{pool});
}
async function authenticateCustomer(phone, password) {
  const cleanPhone = normalizeBdPhone(phone);
  const user = await mysqlClient().queryOne('SELECT `id`, `name`, `phone`, `password_hash` FROM `customers` WHERE `phone` = ? AND `status` = 1 AND `is_blocked` = 0 LIMIT 1', [cleanPhone]);
  if (!user || !await bcrypt.compare(String(password || ''), user.password_hash || '')) return null;
  return { id: user.id, name: user.name, phone: user.phone };
}
async function getProfile(customerId) {
  const id = requirePositiveInt(customerId, 'customer ID');
  const profile = await mysqlClient().queryOne('SELECT `id`, `name`, `phone`, `email`, `created_at` FROM `customers` WHERE `id` = ? AND `status` = 1 AND `is_blocked` = 0 LIMIT 1', [id]);
  if (!profile) throw new NotFoundError('Customer account not found.');
  return profile;
}
async function listAddresses(customerId) {
  const id = requirePositiveInt(customerId, 'customer ID');
  return mysqlClient().queryAll('SELECT `id`, `label`, `recipient_name`, `recipient_phone`, `division`, `district`, `upazila`, `street_address`, `is_default` FROM `customer_addresses` WHERE `customer_id` = ? ORDER BY `is_default` DESC, `id` DESC', [id]);
}
async function listOrders(customerId, requestedPage = 1) {
  const id = requirePositiveInt(customerId, 'customer ID');
  const pageNumber = Number(requestedPage);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new ValidationError('Order history page must be a positive whole number.');
  const db = mysqlClient();
  const count = await db.queryOne('SELECT COUNT(*) AS `total` FROM `orders` WHERE `customer_id` = ?', [id]);
  const total = Number(count?.total || 0);
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pageNumber, totalPages);
  const offset = (page - 1) * perPage;
  const orders = await db.queryAll(
    `SELECT o.id, o.invoice_no, o.order_status, o.payment_status, o.total_paisa, o.created_at,
            (SELECT COALESCE(SUM(i.qty), 0) FROM order_items i WHERE i.order_id = o.id) AS item_quantity
     FROM orders o WHERE o.customer_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    [id, perPage, offset]
  );
  return { orders, page, perPage, total, totalPages };
}
async function getOrderDetails(customerId, orderId) {
  const ownerId = requirePositiveInt(customerId, 'customer ID');
  const id = requirePositiveInt(orderId, 'order ID');
  const db = mysqlClient();
  const order = await db.queryOne(
    `SELECT id, invoice_no, order_status, payment_status, payment_method, customer_name, customer_phone,
            shipping_address, division, district, upazila, shipping_zone,
            subtotal_paisa, discount_paisa, shipping_paisa, total_paisa, created_at
     FROM orders WHERE id = ? AND customer_id = ? LIMIT 1`,
    [id, ownerId]
  );
  if (!order) throw new NotFoundError('Order not found.');
  const items = await db.queryAll(
    `SELECT product_name, qty, unit_price_paisa, line_total_paisa, size_label, color_label
     FROM order_items WHERE order_id = ? ORDER BY id`,
    [id]
  );
  return { order, items };
}
async function saveAddress(customerId, input, evidence = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Enter a valid address.');
  const fields = ['label', 'recipient_name', 'recipient_phone', 'division', 'district', 'upazila', 'street_address'];
  const values = Object.fromEntries(fields.map((key) => {
    const raw = input[key];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new ValidationError('Address fields must be text.');
    return [key, String(raw || '').trim()];
  }));
  if (!values.recipient_name || values.recipient_name.length > 191 || !values.street_address || values.street_address.length > 2000 || !values.division || !values.district) throw new ValidationError('Recipient, division, district and street address are required.');
  values.recipient_phone = normalizeBdPhone(values.recipient_phone);
  if (values.label.length > 64 || values.division.length > 80 || values.district.length > 80 || values.upazila.length > 80) throw new ValidationError('Address fields exceed their allowed length.');
  const isDefault = input.is_default === '1' || input.is_default === true;
  const owner = requirePositiveInt(customerId, 'customer ID');
  return withTransaction(async (tx) => {
    const customer = await tx.queryOne('SELECT `id` FROM `customers` WHERE `id` = ? FOR UPDATE', [owner]);
    if (!customer) throw new NotFoundError('Customer account not found.');
    if (isDefault) await tx.execute('UPDATE `customer_addresses` SET `is_default` = 0 WHERE `customer_id` = ?', [owner]);
    const result = await tx.execute('INSERT INTO `customer_addresses` (`customer_id`, `label`, `recipient_name`, `recipient_phone`, `division`, `district`, `upazila`, `street_address`, `is_default`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [owner, values.label || 'Home', values.recipient_name, values.recipient_phone, values.division, values.district, values.upazila, values.street_address, isDefault ? 1 : 0]);
    await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('customer',?,'customer.address.created','customer_address',?,?,?,?)",[owner,String(result.insertId),JSON.stringify({changed_fields:fields,is_default:isDefault}),String(evidence.ip||'').slice(0,64),String(evidence.userAgent||'').slice(0,255)]);
    return result.insertId;
  });
}
async function deleteAddress(customerId, addressId, evidence = {}) {
  const owner = requirePositiveInt(customerId, 'customer ID');
  const id = requirePositiveInt(addressId, 'address ID');
  return withTransaction(async (tx) => {
    const address=await tx.queryOne('SELECT `id`,`is_default` FROM `customer_addresses` WHERE `id`=? AND `customer_id`=? FOR UPDATE',[id,owner]);
    if(!address)throw new NotFoundError('Address not found.');
    await tx.execute('DELETE FROM `customer_addresses` WHERE `id`=? AND `customer_id`=?',[id,owner]);
    await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES('customer',?,'customer.address.deleted','customer_address',?,?,NULL,?,?)",[owner,String(id),JSON.stringify({is_default:Boolean(address.is_default)}),String(evidence.ip||'').slice(0,64),String(evidence.userAgent||'').slice(0,255)]);
  });
}
function normalizeCartLines(sessionCart, { additive = false } = {}) {
  if (!Array.isArray(sessionCart)) return [];
  const normalized = new Map();
  for (const item of sessionCart) {
    const productId = Number(item.product_id || item.productId || item.id);
    const variantId = Number(item.variant_id || item.variantId) || null;
    const quantity = Number(item.qty || item.quantity);
    if (!Number.isSafeInteger(productId) || productId < 1 || variantId !== null && (!Number.isSafeInteger(variantId) || variantId < 1) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) continue;
    const key = `${productId}:${variantId || 0}`;
    const previous = normalized.get(key)?.quantity || 0;
    normalized.set(key, { productId, variantId, quantity: Math.min(99, quantity + (additive ? previous : 0)) });
  }
  return [...normalized.values()];
}
async function lockCustomerCart(tx, customerId) {
  const customer = await tx.queryOne('SELECT `id` FROM `customers` WHERE `id`=? FOR UPDATE', [customerId]);
  if (!customer) throw new NotFoundError('Customer not found.');
}
async function mergeCart(customerId, sessionCart) {
  const normalized = normalizeCartLines(sessionCart, { additive: true });
  await withTransaction(async (tx) => {
    await lockCustomerCart(tx, customerId);
    for (const item of normalized) {
      const product = await tx.queryOne('SELECT `id` FROM `products` WHERE `id` = ? AND `status` = 1 AND `is_archived` = 0 LIMIT 1', [item.productId]);
      if (!product) continue;
      if (item.variantId) {
        const variant = await tx.queryOne('SELECT `id` FROM `product_variants` WHERE `id` = ? AND `product_id` = ? AND `status` = 1 LIMIT 1', [item.variantId, item.productId]);
        if (!variant) continue;
      }
      await tx.execute('INSERT INTO `customer_cart_items` (`customer_id`, `product_id`, `variant_id`, `quantity`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `quantity` = LEAST(99, `quantity` + VALUES(`quantity`))', [customerId, item.productId, item.variantId, item.quantity]);
    }
  });
}
async function listCart(customerId, locale = 'bn') {
  const rows = await mysqlClient().queryAll('SELECT c.product_id, c.variant_id, c.quantity, p.sku, p.slug, p.name_bn, p.name_en, p.image_url, p.regular_price_paisa, p.sale_price_paisa, p.wholesale_price_paisa, p.wholesale_min_qty, p.is_wholesale, p.approval_status, v.variant_sku, v.size_label, v.color_label, v.price_paisa FROM customer_cart_items c JOIN products p ON p.id=c.product_id LEFT JOIN product_variants v ON v.id=c.variant_id WHERE c.customer_id=? ORDER BY c.id', [customerId]);
  return rows.map((row) => {
    const qty = Number(row.quantity);
    const retailPaisa = Number(row.sale_price_paisa) > 0 ? Number(row.sale_price_paisa) : Number(row.regular_price_paisa);
    const wholesalePaisa = Number(row.wholesale_price_paisa || 0);
    const eligibleWholesale = Number(row.is_wholesale) === 1 && row.approval_status === 'approved' && Number(row.wholesale_min_qty) >= 2 && qty >= Number(row.wholesale_min_qty) && wholesalePaisa > 0 && wholesalePaisa < retailPaisa;
    const unitPaisa = eligibleWholesale ? wholesalePaisa : Number(row.price_paisa) > 0 ? Number(row.price_paisa) : retailPaisa;
    return { key: `saved-${row.product_id}-${row.variant_id || 0}`, product_id: Number(row.product_id), variant_id: row.variant_id == null ? null : Number(row.variant_id), sku: row.variant_sku || row.sku, name: locale === 'en' ? row.name_en || row.name_bn : row.name_bn || row.name_en, slug: row.slug, image: row.image_url, regular_price: retailPaisa / 100, wholesale_price: wholesalePaisa / 100, wholesale_min_qty: Number(row.wholesale_min_qty || 0), price: unitPaisa / 100, qty, size: row.size_label || '', color: row.color_label || '' };
  });
}
async function addCartLine(customerId, line, maxQuantity = 99) {
  const [item] = normalizeCartLines([line]);
  const maximum = Number(maxQuantity);
  if (!item || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 99) throw new ValidationError('Invalid cart line or stock limit.');
  return withTransaction(async (tx) => {
    await lockCustomerCart(tx, customerId);
    const product = await tx.queryOne('SELECT `id` FROM `products` WHERE `id`=? AND `status`=1 AND `is_archived`=0 LIMIT 1', [item.productId]);
    if (!product) throw new NotFoundError('Product is no longer available.');
    if (item.variantId) {
      const variant = await tx.queryOne('SELECT `id` FROM `product_variants` WHERE `id`=? AND `product_id`=? AND `status`=1 LIMIT 1', [item.variantId, item.productId]);
      if (!variant) throw new NotFoundError('Product variant is no longer available.');
    }
    await tx.execute('INSERT INTO `customer_cart_items` (`customer_id`,`product_id`,`variant_id`,`quantity`) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE `quantity`=LEAST(?,`quantity`+VALUES(`quantity`))', [customerId, item.productId, item.variantId, item.quantity, maximum]);
    const saved = await tx.queryOne('SELECT `quantity` FROM `customer_cart_items` WHERE `customer_id`=? AND `product_id`=? AND `variant_id` <=> ? LIMIT 1', [customerId, item.productId, item.variantId]);
    return Number(saved?.quantity || 0);
  });
}
function normalizedCartIdentity(line) {
  const quantity = Number(line?.qty ?? line?.quantity);
  const [item] = normalizeCartLines([{ ...line, qty: quantity > 0 ? quantity : 1 }]);
  return item || null;
}
async function setCartLine(customerId, line) {
  const item = normalizedCartIdentity(line);
  const quantity = Number(line?.qty ?? line?.quantity);
  if (!item || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new ValidationError('Cart quantity must be a whole number from 1 to 99.');
  await withTransaction(async (tx) => {
    await lockCustomerCart(tx, customerId);
    await tx.execute('UPDATE `customer_cart_items` SET `quantity`=? WHERE `customer_id`=? AND `product_id`=? AND `variant_id` <=> ?', [quantity, customerId, item.productId, item.variantId]);
  });
}
async function removeCartLine(customerId, line) {
  const item = normalizedCartIdentity(line);
  if (!item) return;
  await withTransaction(async (tx) => {
    await lockCustomerCart(tx, customerId);
    await tx.execute('DELETE FROM `customer_cart_items` WHERE `customer_id`=? AND `product_id`=? AND `variant_id` <=> ?', [customerId, item.productId, item.variantId]);
  });
}
async function reconcileCart(customerId, { caps = [], removals = [] } = {}) {
  const normalizedCaps = caps.map((line) => ({ item: normalizedCartIdentity(line), maximum: Number(line.maxQuantity) })).filter(({ item, maximum }) => item && Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 99);
  const normalizedRemovals = removals.map(normalizedCartIdentity).filter(Boolean);
  await withTransaction(async (tx) => {
    await lockCustomerCart(tx, customerId);
    for (const item of normalizedRemovals) await tx.execute('DELETE FROM `customer_cart_items` WHERE `customer_id`=? AND `product_id`=? AND `variant_id` <=> ?', [customerId, item.productId, item.variantId]);
    for (const { item, maximum } of normalizedCaps) await tx.execute('UPDATE `customer_cart_items` SET `quantity`=LEAST(`quantity`,?) WHERE `customer_id`=? AND `product_id`=? AND `variant_id` <=> ?', [maximum, customerId, item.productId, item.variantId]);
  });
}
async function replaceCart(customerId, sessionCart) {
  const normalized = normalizeCartLines(sessionCart);
  await withTransaction(async (tx) => {
    await lockCustomerCart(tx, customerId);
    await tx.execute('DELETE FROM `customer_cart_items` WHERE `customer_id`=?', [customerId]);
    for (const item of normalized) {
      const product = await tx.queryOne('SELECT `id` FROM `products` WHERE `id`=? AND `status`=1 AND `is_archived`=0 LIMIT 1', [item.productId]);
      if (!product) continue;
      if (item.variantId) {
        const variant = await tx.queryOne('SELECT `id` FROM `product_variants` WHERE `id`=? AND `product_id`=? AND `status`=1 LIMIT 1', [item.variantId, item.productId]);
        if (!variant) continue;
      }
      await tx.execute('INSERT INTO `customer_cart_items` (`customer_id`,`product_id`,`variant_id`,`quantity`) VALUES (?,?,?,?)', [customerId, item.productId, item.variantId, item.quantity]);
    }
  });
}
async function clearCart(customerId) {
  await withTransaction(async (tx) => {
    await lockCustomerCart(tx, customerId);
    await tx.execute('DELETE FROM `customer_cart_items` WHERE `customer_id`=?', [customerId]);
  });
}
module.exports = { normalizeBdPhone, validatePassword, registerCustomer, issueCustomerRecovery, consumeCustomerRecoveryToken, authenticateCustomer, getProfile, listAddresses, listOrders, getOrderDetails, saveAddress, deleteAddress, mergeCart, listCart, addCartLine, setCartLine, removeCartLine, reconcileCart, replaceCart, clearCart };
