'use strict';

const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');

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
async function registerCustomer({ name, phone, password, email = '' }) {
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2 || cleanName.length > 191) throw new ValidationError('Name must contain 2–191 characters.');
  const cleanPhone = normalizeBdPhone(phone);
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanEmail && (cleanEmail.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) throw new ValidationError('Enter a valid email address of at most 191 characters.');
  const hash = await bcrypt.hash(validatePassword(password), 12);
  try {
    const result = await mysqlClient().execute(
      'INSERT INTO `customers` (`name`, `phone`, `email`, `password_hash`) VALUES (?, ?, ?, ?)',
      [cleanName, cleanPhone, cleanEmail || null, hash]
    );
    return { id: result.insertId, name: cleanName, phone: cleanPhone };
  } catch (err) {
    if (err.code === 'DB_DUPLICATE_ENTRY') throw new ConflictError('An account already exists for this phone number.');
    throw err;
  }
}
async function authenticateCustomer(phone, password) {
  const cleanPhone = normalizeBdPhone(phone);
  const user = await mysqlClient().queryOne('SELECT `id`, `name`, `phone`, `password_hash` FROM `customers` WHERE `phone` = ? AND `status` = 1 AND `is_blocked` = 0 LIMIT 1', [cleanPhone]);
  if (!user || !await bcrypt.compare(String(password || ''), user.password_hash || '')) return null;
  return { id: user.id, name: user.name, phone: user.phone };
}
async function listAddresses(customerId) {
  return mysqlClient().queryAll('SELECT `id`, `label`, `recipient_name`, `recipient_phone`, `division`, `district`, `upazila`, `street_address`, `is_default` FROM `customer_addresses` WHERE `customer_id` = ? ORDER BY `is_default` DESC, `id` DESC', [customerId]);
}
async function saveAddress(customerId, input) {
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
  return withTransaction(async (tx) => {
    await tx.queryOne('SELECT `id` FROM `customers` WHERE `id` = ? FOR UPDATE', [customerId]);
    if (isDefault) await tx.execute('UPDATE `customer_addresses` SET `is_default` = 0 WHERE `customer_id` = ?', [customerId]);
    const result = await tx.execute('INSERT INTO `customer_addresses` (`customer_id`, `label`, `recipient_name`, `recipient_phone`, `division`, `district`, `upazila`, `street_address`, `is_default`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [customerId, values.label || 'Home', values.recipient_name, values.recipient_phone, values.division, values.district, values.upazila, values.street_address, isDefault ? 1 : 0]);
    return result.insertId;
  });
}
async function deleteAddress(customerId, addressId) {
  const result = await mysqlClient().execute('DELETE FROM `customer_addresses` WHERE `id` = ? AND `customer_id` = ?', [addressId, customerId]);
  if (!result.affectedRows) throw new NotFoundError('Address not found.');
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
module.exports = { normalizeBdPhone, validatePassword, registerCustomer, authenticateCustomer, listAddresses, saveAddress, deleteAddress, mergeCart, listCart, addCartLine, setCartLine, removeCartLine, reconcileCart, replaceCart, clearCart };
