'use strict';

const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { requirePositiveInt, requireString } = require('../utils/validator');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const REVERSAL_REASONS = Object.freeze(['full_cancellation', 'partial_cancellation', 'return_to_origin', 'item_refund']);
function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Financial reversals require MySQL.');
}
function paisa(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 90000000000000) throw new ValidationError(`${label} is outside the supported paisa range.`);
  return amount;
}
function metadata(value) { return JSON.stringify(value || {}); }

async function debitPartner(tx, { resellerId, subOrderId, amount, baseKey, actorId }) {
  if (!resellerId || amount <= 0) return 0;
  const earned = subOrderId ? await tx.queryOne(
    `SELECT MAX(CASE WHEN transaction_type='pending_earning' THEN 1 ELSE 0 END) AS has_earning,
            MAX(CASE WHEN transaction_type='settlement_release' THEN 1 ELSE 0 END) AS released
     FROM partner_transactions WHERE sub_order_id=? AND transaction_type IN ('pending_earning','settlement_release') FOR UPDATE`,
    [subOrderId]
  ) : null;
  if (!earned || Number(earned.has_earning || earned.released || 0) === 0) {
    await tx.execute(
      `INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
       VALUES(?,?,?,'reversal',?,'unearned',?)`,
      [resellerId, subOrderId, `${baseKey}:partner:unearned`, -amount, metadata({ actorId, walletDebited: false })]
    );
    return 0;
  }
  await tx.execute('INSERT IGNORE INTO partner_wallets(reseller_id) VALUES(?)', [resellerId]);
  const wallet = await tx.queryOne('SELECT pending_balance,available_balance FROM partner_wallets WHERE reseller_id=? FOR UPDATE', [resellerId]);
  if (!wallet) throw new ConflictError('Reseller wallet is unavailable for reversal.');
  const pendingDebit = Number(earned.released) === 1 ? 0 : Math.min(amount, Math.max(0, Number(wallet.pending_balance) || 0));
  const availableDebit = amount - pendingDebit;
  await tx.execute(
    'UPDATE partner_wallets SET pending_balance=pending_balance-?,available_balance=available_balance-? WHERE reseller_id=?',
    [pendingDebit, availableDebit, resellerId]
  );
  if (availableDebit) await tx.execute('UPDATE resellers SET balance_paisa=balance_paisa-? WHERE id=?', [availableDebit, resellerId]);
  if (pendingDebit) await tx.execute(
    `INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
     VALUES(?,?,?,'reversal',?,'pending',?)`,
    [resellerId, subOrderId, `${baseKey}:partner:pending`, -pendingDebit, metadata({ actorId, recovery: false })]
  );
  if (availableDebit) await tx.execute(
    `INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
     VALUES(?,?,?,'reversal',?,'available',?)`,
    [resellerId, subOrderId, `${baseKey}:partner:available`, -availableDebit, metadata({ actorId, recovery: Number(wallet.available_balance) < availableDebit })]
  );
  return amount;
}

async function debitVendor(tx, { vendorId, subOrderId, amount, baseKey, actorId }) {
  if (!vendorId || amount <= 0) return 0;
  const earned = subOrderId ? await tx.queryOne(
    `SELECT MAX(CASE WHEN transaction_type='pending_entitlement' THEN 1 ELSE 0 END) AS has_earning,
            MAX(CASE WHEN transaction_type='settlement_release' THEN 1 ELSE 0 END) AS released
     FROM vendor_transactions WHERE sub_order_id=? AND transaction_type IN ('pending_entitlement','settlement_release') FOR UPDATE`,
    [subOrderId]
  ) : null;
  if (!earned || Number(earned.has_earning || earned.released || 0) === 0) {
    await tx.execute(
      `INSERT INTO vendor_transactions(vendor_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
       VALUES(?,?,?,'reversal',?,'unearned',?)`,
      [vendorId, subOrderId, `${baseKey}:vendor:unearned`, -amount, metadata({ actorId, walletDebited: false })]
    );
    return 0;
  }
  await tx.execute('INSERT IGNORE INTO vendor_wallets(vendor_id) VALUES(?)', [vendorId]);
  const wallet = await tx.queryOne('SELECT pending_settlement,available_balance FROM vendor_wallets WHERE vendor_id=? FOR UPDATE', [vendorId]);
  if (!wallet) throw new ConflictError('Vendor wallet is unavailable for reversal.');
  const pendingDebit = Number(earned.released) === 1 ? 0 : Math.min(amount, Math.max(0, Number(wallet.pending_settlement) || 0));
  const availableDebit = amount - pendingDebit;
  await tx.execute(
    'UPDATE vendor_wallets SET pending_settlement=pending_settlement-?,available_balance=available_balance-? WHERE vendor_id=?',
    [pendingDebit, availableDebit, vendorId]
  );
  if (availableDebit) await tx.execute('UPDATE vendors SET balance_paisa=balance_paisa-? WHERE id=?', [availableDebit, vendorId]);
  if (pendingDebit) await tx.execute(
    `INSERT INTO vendor_transactions(vendor_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
     VALUES(?,?,?,'reversal',?,'pending',?)`,
    [vendorId, subOrderId, `${baseKey}:vendor:pending`, -pendingDebit, metadata({ actorId, recovery: false })]
  );
  if (availableDebit) await tx.execute(
    `INSERT INTO vendor_transactions(vendor_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
     VALUES(?,?,?,'reversal',?,'available',?)`,
    [vendorId, subOrderId, `${baseKey}:vendor:available`, -availableDebit, metadata({ actorId, recovery: Number(wallet.available_balance) < availableDebit })]
  );
  return amount;
}

async function reverseOrderItem({ orderItemId, quantity, reason, idempotencyKey, actor = {} } = {}) {
  assertMysql();
  const itemId = requirePositiveInt(orderItemId, 'order-item ID');
  const qty = requirePositiveInt(quantity, 'reversal quantity', { max: 100000000 });
  const type = String(reason || '').trim();
  if (!REVERSAL_REASONS.includes(type)) throw new ValidationError('Unsupported financial reversal reason.');
  const key = requireString(idempotencyKey, 'idempotency key', { min: 12, max: 100 });
  const actorId = actor?.userId || actor?.id ? requirePositiveInt(actor.userId || actor.id, 'actor ID') : null;

  return mysql.withTransaction(async (tx) => {
    const prior = await tx.queryOne('SELECT id,order_item_id,quantity,reason,vendor_amount_paisa,reseller_amount_paisa FROM financial_reversals WHERE idempotency_key=? FOR UPDATE', [key]);
    if (prior) {
      if (Number(prior.order_item_id) !== itemId || Number(prior.quantity) !== qty || prior.reason !== type) throw new ConflictError('Reversal idempotency key was already used for different details.');
      return { reversalId: Number(prior.id), replayed: true, vendorAmountPaisa: Number(prior.vendor_amount_paisa), resellerAmountPaisa: Number(prior.reseller_amount_paisa) };
    }
    const row = await tx.queryOne(
      `SELECT oi.id,oi.order_id,oi.qty,oi.vendor_id,o.reseller_id,ps.vendor_id AS snapshot_vendor_id,
              ps.reseller_id AS snapshot_reseller_id,ps.vendor_entitlement_unit_paisa,ps.reseller_margin_unit_paisa,
              si.vendor_sub_order_id
       FROM order_items oi JOIN orders o ON o.id=oi.order_id
       JOIN order_price_snapshots ps ON ps.order_item_id=oi.id
       LEFT JOIN vendor_sub_order_items si ON si.order_item_id=oi.id
       WHERE oi.id=? FOR UPDATE`, [itemId]
    );
    if (!row) throw new NotFoundError('Immutable order-price snapshot not found for this item.');
    const priorQty = await tx.queryOne('SELECT COALESCE(SUM(quantity),0) AS reversed_qty FROM financial_reversals WHERE order_item_id=? FOR UPDATE', [itemId]);
    if (qty + Number(priorQty?.reversed_qty || 0) > Number(row.qty)) throw new ConflictError('Reversal quantity exceeds the item quantity not yet reversed.');
    const vendorAmount = paisa(Number(row.vendor_entitlement_unit_paisa) * qty, 'Vendor reversal');
    const resellerAmount = paisa(Number(row.reseller_margin_unit_paisa) * qty, 'Reseller reversal');
    const subOrderId = row.vendor_sub_order_id ? Number(row.vendor_sub_order_id) : null;
    const result = await tx.execute(
      `INSERT INTO financial_reversals(order_item_id,quantity,reason,idempotency_key,vendor_amount_paisa,reseller_amount_paisa,created_by_user_id)
       VALUES(?,?,?,?,?,?,?)`, [itemId, qty, type, key, vendorAmount, resellerAmount, actorId]
    );
    const partnerReversed = await debitPartner(tx, {
      resellerId: row.snapshot_reseller_id || row.reseller_id, subOrderId, amount: resellerAmount,
      baseKey: key, actorId,
    });
    const vendorReversed = await debitVendor(tx, {
      vendorId: row.snapshot_vendor_id || row.vendor_id, subOrderId, amount: vendorAmount,
      baseKey: key, actorId,
    });
    return {
      reversalId: Number(result.insertId), orderItemId: itemId, quantity: qty, reason: type, replayed: false,
      vendorAmountPaisa: vendorAmount, resellerAmountPaisa: resellerAmount,
      vendorWalletDebitedPaisa: vendorReversed, resellerWalletDebitedPaisa: partnerReversed,
    };
  });
}

module.exports = { reverseOrderItem, REVERSAL_REASONS };
