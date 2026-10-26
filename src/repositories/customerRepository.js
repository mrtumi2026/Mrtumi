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
  const fields = ['label', 'recipient_name', 'recipient_phone', 'division', 'district', 'upazila', 'street_address'];
  const values = Object.fromEntries(fields.map((key) => [key, String(input[key] || '').trim()]));
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
async function mergeCart(customerId, sessionCart) {
  if (!Array.isArray(sessionCart)) return;
  const normalized = new Map();
  for (const item of sessionCart) {
    const productId = Number(item.product_id || item.productId || item.id);
    const variantId = Number(item.variant_id || item.variantId) || null;
    const quantity = Number(item.qty || item.quantity);
    if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) continue;
    const key = `${productId}:${variantId || 0}`;
    normalized.set(key, { productId, variantId, quantity: Math.min(99, quantity + (normalized.get(key)?.quantity || 0)) });
  }
  await withTransaction(async (tx) => {
    for (const item of normalized.values()) {
      const product = await tx.queryOne('SELECT `id` FROM `products` WHERE `id` = ? AND `status` = 1 LIMIT 1', [item.productId]);
      if (!product) continue;
      if (item.variantId) {
        const variant = await tx.queryOne('SELECT `id` FROM `product_variants` WHERE `id` = ? AND `product_id` = ? LIMIT 1', [item.variantId, item.productId]);
        if (!variant) continue;
      }
      // The generated non-null variant key makes this upsert safe for both base and variant rows.
      await tx.execute('INSERT INTO `customer_cart_items` (`customer_id`, `product_id`, `variant_id`, `quantity`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `quantity` = LEAST(99, `quantity` + VALUES(`quantity`))', [customerId, item.productId, item.variantId, item.quantity]);
    }
  });
}
module.exports = { normalizeBdPhone, validatePassword, registerCustomer, authenticateCustomer, listAddresses, saveAddress, deleteAddress, mergeCart };
