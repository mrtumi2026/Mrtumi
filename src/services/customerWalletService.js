'use strict';

// Spending the customer wallet at checkout.
//
// The wallet part of an order is stored inside orders.discount_paisa, so total_paisa is
// always the cash the customer still has to pay. That keeps manual payment checks, COD
// collection and cash refunds from ever treating wallet money as cash received.
// customer_wallet_transactions is the record of how much of that discount was wallet money.

const mysql = require('../db/mysqlPool');
const { ConflictError, ValidationError, NotFoundError } = require('../utils/errors');

const SETTING_KEY = 'customer_wallet_max_percent';
const DEFAULT_MAX_PERCENT = 20;
// An order can never be paid fully from the wallet. 0 switches wallet payment off.
const HIGHEST_ALLOWED_PERCENT = 99;
const SPEND = 'order_spend';
const SPEND_RETURN = 'order_spend_return';

const orderReference = (orderId) => `order:${Number(orderId)}`;
const defaultClient = (client) => client || mysql.createQueryClient(mysql.getPool());

async function getMaxPercent(client = null) {
  const row = await defaultClient(client).queryOne('SELECT setting_value FROM settings WHERE setting_key=?', [SETTING_KEY]);
  const text = String(row?.setting_value ?? '').trim();
  if (!/^\d{1,2}$/.test(text)) return DEFAULT_MAX_PERCENT;
  return Math.min(Number(text), HIGHEST_ALLOWED_PERCENT);
}

async function getBalancePaisa(customerId, client = null) {
  const row = await defaultClient(client).queryOne('SELECT balance_paisa FROM customer_wallets WHERE customer_id=?', [Number(customerId)]);
  return Math.max(0, Number(row?.balance_paisa || 0));
}

// The limit applies to the product price after any coupon; delivery charge is not included.
// Rounded down to whole taka so the cash left to collect has no extra paisa.
function maxUsablePaisa({ subtotalPaisa, couponPaisa = 0, balancePaisa, percent }) {
  const base = Math.max(0, Number(subtotalPaisa) - Number(couponPaisa));
  const cap = Number((BigInt(base) * BigInt(percent)) / 100n);
  const usable = Math.max(0, Math.min(cap, Number(balancePaisa)));
  return usable - (usable % 100);
}

async function lockWalletTx(tx, customerId) {
  return tx.queryOne('SELECT balance_paisa,points_balance FROM customer_wallets WHERE customer_id=? FOR UPDATE', [customerId]);
}

async function recordTx(tx, customerId, type, amountPaisa, wallet, orderId, note) {
  const balanceAfter = Number(wallet.balance_paisa) + amountPaisa;
  await tx.execute('UPDATE customer_wallets SET balance_paisa=? WHERE customer_id=?', [balanceAfter, customerId]);
  await tx.execute(`INSERT INTO customer_wallet_transactions
    (customer_id,tx_type,amount_paisa,points,balance_after_paisa,points_after,reference_id,note)
    VALUES(?,?,?,0,?,?,?,?)`, [customerId, type, amountPaisa, balanceAfter, Number(wallet.points_balance || 0), orderReference(orderId), note]);
}

const REFUND_CREDIT = 'refund_credit';
const ADMIN_CREDIT_TYPES = Object.freeze({ offer: 'admin_offer', bonus: 'admin_bonus', compensation: 'admin_compensation' });

// The buyer's account for an order. A guest order is linked to the account of its mobile
// number, which is created without a password when it does not exist yet.
async function ensureOrderCustomerTx(tx, order) {
  if (order.customer_id) return Number(order.customer_id);
  let phone;
  try { phone = require('../repositories/customerRepository').normalizeBdPhone(order.customer_phone); } catch (_error) {
    throw new ConflictError('The order does not have a valid mobile number for a wallet account.');
  }
  await tx.execute("INSERT IGNORE INTO customers(name,phone,password_hash,status) VALUES(?,?,'',1)", [String(order.customer_name || 'Customer').slice(0, 191), phone]);
  const account = await tx.queryOne('SELECT id FROM customers WHERE phone=? FOR UPDATE', [phone]);
  await tx.execute('UPDATE orders SET customer_id=? WHERE id=? AND customer_id IS NULL', [account.id, order.id]);
  return Number(account.id);
}

async function creditTx(tx, { customerId, type, amountPaisa, reference, note }) {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa < 1) throw new ConflictError('Wallet credit amount must be greater than zero.');
  await tx.execute('INSERT IGNORE INTO customer_wallets(customer_id) VALUES(?)', [customerId]);
  const wallet = await lockWalletTx(tx, customerId);
  const balanceAfter = Number(wallet.balance_paisa) + amountPaisa;
  await tx.execute('UPDATE customer_wallets SET balance_paisa=? WHERE customer_id=?', [balanceAfter, customerId]);
  await tx.execute(`INSERT INTO customer_wallet_transactions
    (customer_id,tx_type,amount_paisa,points,balance_after_paisa,points_after,reference_id,note)
    VALUES(?,?,?,0,?,?,?,?)`, [customerId, type, amountPaisa, balanceAfter, Number(wallet.points_balance || 0), reference, String(note || '').slice(0, 255)]);
  return balanceAfter;
}

// Offer, bonus or compensation money added by an administrator. The request key stops a
// resubmitted form from adding the money twice.
async function adminCredit({ phone, amountTaka, kind, reason, requestKey }, actor = {}) {
  const type = ADMIN_CREDIT_TYPES[String(kind || '')];
  if (!type) throw new ValidationError('Choose offer, bonus or compensation.');
  const text = String(amountTaka || '').trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text) || Number(text) <= 0 || Number(text) > 100000) throw new ValidationError('Enter an amount between 0.01 and 100000 taka.');
  const note = String(reason || '').trim();
  if (note.length < 3 || note.length > 200) throw new ValidationError('Write the reason (3–200 characters).');
  const key = String(requestKey || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new ValidationError('Reload the page and try again.');
  let mobile;
  try { mobile = require('../repositories/customerRepository').normalizeBdPhone(phone); } catch (_error) { throw new ValidationError('Enter a valid Bangladesh mobile number.'); }
  const amountPaisa = Math.round(Number(text) * 100);
  return mysql.withTransaction(async (tx) => {
    const account = await tx.queryOne('SELECT id,name,phone FROM customers WHERE phone=? FOR UPDATE', [mobile]);
    if (!account) throw new NotFoundError('No customer account uses this mobile number.');
    const reference = `admin:${key}`;
    const prior = await tx.queryOne('SELECT id FROM customer_wallet_transactions WHERE customer_id=? AND reference_id=? FOR UPDATE', [account.id, reference]);
    if (prior) return { replayed: true, account, amountPaisa };
    const balancePaisa = await creditTx(tx, { customerId: Number(account.id), type, amountPaisa, reference, note });
    await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('admin',?,'customer.wallet.admin_credit','customer',?,?,?,?)", [actor.id || null, String(account.id), JSON.stringify({ type, amountPaisa, reason: note }), String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]);
    return { replayed: false, account, amountPaisa, balancePaisa };
  });
}

async function listAdminCredits(limit = 30) {
  return defaultClient(null).queryAll(`SELECT t.created_at,t.tx_type,t.amount_paisa,t.note,c.name,c.phone FROM customer_wallet_transactions t
    JOIN customers c ON c.id=t.customer_id WHERE t.tx_type IN ('admin_offer','admin_bonus','admin_compensation') ORDER BY t.id DESC LIMIT ${Math.min(Number(limit) || 30, 100)}`);
}

// Current balance with the wallet row locked until the order transaction ends.
async function lockBalancePaisaTx(tx, customerId) {
  const wallet = await lockWalletTx(tx, customerId);
  return Math.max(0, Number(wallet?.balance_paisa || 0));
}

async function spendTx(tx, { customerId, orderId, invoiceNo, amountPaisa }) {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa < 1) return;
  const wallet = await lockWalletTx(tx, customerId);
  if (!wallet || Number(wallet.balance_paisa) < amountPaisa) throw new ConflictError('Your wallet balance changed. Reload checkout and try again.');
  await recordTx(tx, customerId, SPEND, -amountPaisa, wallet, orderId, `Used on order ${invoiceNo}`);
}

// `lock` makes this a current read inside a transaction, not an older snapshot.
async function sumForOrder(client, customerId, orderId, types, lock = false) {
  const row = await client.queryOne(`SELECT COALESCE(SUM(amount_paisa),0) AS total FROM customer_wallet_transactions
    WHERE customer_id=? AND reference_id=? AND tx_type IN (${types.map(() => '?').join(',')})${lock ? ' FOR UPDATE' : ''}`, [customerId, orderReference(orderId), ...types]);
  return Number(row?.total || 0);
}

// Wallet money originally used on an order, whether or not it was returned later.
async function getOrderWalletUsedPaisa(orderId, client = null) {
  const db = defaultClient(client);
  const order = await db.queryOne('SELECT customer_id FROM orders WHERE id=?', [Number(orderId)]);
  if (!order?.customer_id) return 0;
  return Math.max(0, -(await sumForOrder(db, Number(order.customer_id), orderId, [SPEND])));
}

// Gives the wallet money back for a cancelled, failed or returned order. Safe to call again.
async function returnOrderSpendTx(tx, orderId) {
  const order = await tx.queryOne('SELECT id,invoice_no,customer_id FROM orders WHERE id=?', [Number(orderId)]);
  if (!order?.customer_id) return 0;
  const customerId = Number(order.customer_id);
  const wallet = await lockWalletTx(tx, customerId);
  if (!wallet) return 0;
  // Locking the wallet row first makes this sum stable against a concurrent return.
  const outstanding = -(await sumForOrder(tx, customerId, order.id, [SPEND, SPEND_RETURN], true));
  if (outstanding < 1) return 0;
  await recordTx(tx, customerId, SPEND_RETURN, outstanding, wallet, order.id, `Returned from order ${order.invoice_no}`);
  return outstanding;
}

module.exports = {
  SETTING_KEY, DEFAULT_MAX_PERCENT, HIGHEST_ALLOWED_PERCENT,
  REFUND_CREDIT, ADMIN_CREDIT_TYPES, ensureOrderCustomerTx, creditTx, adminCredit, listAdminCredits,
  getMaxPercent, getBalancePaisa, lockBalancePaisaTx, maxUsablePaisa, spendTx, returnOrderSpendTx, getOrderWalletUsedPaisa,
};
