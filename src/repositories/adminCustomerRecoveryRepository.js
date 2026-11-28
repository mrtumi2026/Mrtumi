'use strict';

// Support-assisted account recovery: the customer calls with a mobile or invoice
// number, an administrator finds the account and issues a one-time password link.
const crypto = require('node:crypto');
const { withTransaction, getPool, createQueryClient } = require('../db/mysqlPool');
const { normalizeBdPhone } = require('./customerRepository');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const LINK_HOURS = 24;
const client = () => createQueryClient(getPool());
const positive = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('Invalid account.');
  return id;
};
function phoneOrNull(value) {
  try { return normalizeBdPhone(value); } catch (_error) { return null; }
}
const ACCOUNT_SQL = "SELECT id,name,phone,email,status,is_blocked,(password_hash<>'') AS has_password,created_at FROM customers";

async function findForSupport(query) {
  const term = String(query || '').trim().slice(0, 64);
  if (!term) return null;
  const db = client();
  const phone = phoneOrNull(term);
  let order = null;
  let account = null;
  if (phone) {
    account = await db.queryOne(`${ACCOUNT_SQL} WHERE phone=?`, [phone]);
  } else {
    order = await db.queryOne('SELECT id,invoice_no,customer_id,customer_name,customer_phone,order_status,created_at FROM orders WHERE invoice_no=?', [term]);
    if (!order) return { term, order: null, account: null, orders: [] };
    if (order.customer_id) account = await db.queryOne(`${ACCOUNT_SQL} WHERE id=?`, [order.customer_id]);
    else {
      const orderPhone = phoneOrNull(order.customer_phone);
      if (orderPhone) account = await db.queryOne(`${ACCOUNT_SQL} WHERE phone=?`, [orderPhone]);
    }
  }
  const orders = account
    ? await db.queryAll('SELECT invoice_no,order_status,customer_name,customer_phone,total_paisa,created_at FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 10', [account.id])
    : [];
  return { term, order, account, orders };
}

// A guest order with no account: link it to the account of the order's own phone,
// creating that account (without a password) when none exists.
async function attachOrderToAccount(invoiceNo, actor = {}) {
  return withTransaction(async (tx) => {
    const order = await tx.queryOne('SELECT id,customer_id,customer_name,customer_phone FROM orders WHERE invoice_no=? FOR UPDATE', [String(invoiceNo || '').trim()]);
    if (!order) throw new NotFoundError('Order not found.');
    if (order.customer_id) throw new ConflictError('This order is already linked to an account.');
    const phone = phoneOrNull(order.customer_phone);
    if (!phone) throw new ValidationError('The order does not have a valid mobile number.');
    await tx.execute("INSERT IGNORE INTO customers(name,phone,password_hash,status) VALUES(?,?,'',1)", [String(order.customer_name || 'Customer').slice(0, 191), phone]);
    const account = await tx.queryOne('SELECT id FROM customers WHERE phone=? FOR UPDATE', [phone]);
    await tx.execute('UPDATE orders SET customer_id=? WHERE id=? AND customer_id IS NULL', [account.id, order.id]);
    await audit(tx, actor, 'admin.customer.order_linked', account.id, { orderId: Number(order.id) });
    return { customerId: Number(account.id) };
  });
}

async function createRecoveryLink(customerId, actor = {}) {
  const id = positive(customerId);
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return withTransaction(async (tx) => {
    const account = await tx.queryOne('SELECT id,name,phone,status,is_blocked FROM customers WHERE id=? FOR UPDATE', [id]);
    if (!account) throw new NotFoundError('Customer account not found.');
    if (Number(account.status) !== 1 || Number(account.is_blocked) === 1) throw new ConflictError('This account is blocked or inactive.');
    await tx.execute('UPDATE customer_recovery_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE customer_id=? AND consumed_at IS NULL AND revoked_at IS NULL', [id]);
    await tx.execute(`INSERT INTO customer_recovery_tokens(customer_id,channel,token_hash,expires_at) VALUES(?,'admin',?,DATE_ADD(CURRENT_TIMESTAMP,INTERVAL ${LINK_HOURS} HOUR))`, [id, hash]);
    // The token itself is never written to logs.
    await audit(tx, actor, 'admin.customer.recovery_link_created', id, { expiresHours: LINK_HOURS });
    return { token, hours: LINK_HOURS, account: { id: Number(account.id), name: account.name, phone: account.phone } };
  });
}

async function audit(tx, actor, action, customerId, details) {
  await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('admin',?,?,'customer',?,?,?,?)", [actor.id || null, action, String(customerId), JSON.stringify(details), String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]);
}

module.exports = { LINK_HOURS, findForSupport, attachOrderToAccount, createRecoveryLink };
