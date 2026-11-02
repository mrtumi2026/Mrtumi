'use strict';

const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { requirePositiveInt } = require('../utils/validator');

function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Partner settlement requires MySQL.');
}
function positivePaisa(value, label, allowZero = true) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 90000000000000) {
    throw new ValidationError(`${label} is outside the supported paisa range.`);
  }
  return amount;
}
function json(value) { return JSON.stringify(value || {}); }

async function settlementAmounts(tx, subOrderId) {
  const row = await tx.queryOne(
    `SELECT so.id,so.order_id,so.vendor_id,so.status,so.vendor_entitlement_paisa,so.marketplace_fee_paisa,
            o.reseller_id,
            COALESCE(SUM(COALESCE(ps.vendor_entitlement_unit_paisa,0)*si.quantity),0) AS snapshot_vendor_paisa,
            COALESCE(SUM(COALESCE(ps.reseller_margin_unit_paisa,0)*si.quantity),0) AS reseller_paisa,
            COALESCE(SUM(COALESCE(ps.marketplace_revenue_unit_paisa,0)*si.quantity),0) AS marketplace_paisa
     FROM vendor_sub_orders so
     JOIN orders o ON o.id=so.order_id
     LEFT JOIN vendor_sub_order_items si ON si.vendor_sub_order_id=so.id
     LEFT JOIN order_price_snapshots ps ON ps.order_item_id=si.order_item_id
     WHERE so.id=? GROUP BY so.id,o.reseller_id FOR UPDATE`, [subOrderId]
  );
  if (!row) throw new NotFoundError('Vendor sub-order not found.');
  const vendorAmount = positivePaisa(Number(row.vendor_entitlement_paisa) || Number(row.snapshot_vendor_paisa), 'Vendor entitlement');
  const resellerAmount = row.reseller_id ? positivePaisa(row.reseller_paisa, 'Reseller earning') : 0;
  let marketplaceAmount = positivePaisa(row.marketplace_paisa, 'Marketplace revenue');
  if (!marketplaceAmount && Number(row.marketplace_fee_paisa) > 0) marketplaceAmount = positivePaisa(row.marketplace_fee_paisa, 'Marketplace fee');
  return { row, vendorAmount, resellerAmount, marketplaceAmount };
}

async function recordPendingSettlementTx(tx, subOrderId, actor = {}) {
  const id = requirePositiveInt(subOrderId, 'sub-order ID');
  const amounts = await settlementAmounts(tx, id);
  if (amounts.row.status !== 'delivered') throw new ConflictError('Pending settlement can only be recorded for a delivered sub-order.');
  const { row, vendorAmount, resellerAmount } = amounts;
  const actorId = actor?.userId || actor?.id || null;
  if (row.reseller_id && resellerAmount > 0) {
    const key = `pending:reseller:${id}`;
    const existing = await tx.queryOne('SELECT id,amount_paisa FROM partner_transactions WHERE idempotency_key=? FOR UPDATE', [key]);
    if (!existing) {
      await tx.execute('INSERT IGNORE INTO partner_wallets(reseller_id) VALUES(?)', [row.reseller_id]);
      await tx.queryOne('SELECT reseller_id FROM partner_wallets WHERE reseller_id=? FOR UPDATE', [row.reseller_id]);
      await tx.execute('UPDATE partner_wallets SET pending_balance=pending_balance+? WHERE reseller_id=?', [resellerAmount, row.reseller_id]);
      await tx.execute(
        `INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
         VALUES(?,?,?,'pending_earning',?,'pending',?)`,
        [row.reseller_id, id, key, resellerAmount, json({ actorId, orderId: Number(row.order_id) })]
      );
    } else if (Number(existing.amount_paisa) !== resellerAmount) {
      throw new ConflictError('Existing reseller pending earning does not match the immutable price snapshot.');
    }
  }
  if (vendorAmount > 0) {
    const key = `pending:vendor:${id}`;
    const existing = await tx.queryOne('SELECT id,amount_paisa FROM vendor_transactions WHERE idempotency_key=? FOR UPDATE', [key]);
    if (!existing) {
      await tx.execute('INSERT IGNORE INTO vendor_wallets(vendor_id) VALUES(?)', [row.vendor_id]);
      await tx.queryOne('SELECT vendor_id FROM vendor_wallets WHERE vendor_id=? FOR UPDATE', [row.vendor_id]);
      await tx.execute('UPDATE vendor_wallets SET pending_settlement=pending_settlement+? WHERE vendor_id=?', [vendorAmount, row.vendor_id]);
      await tx.execute(
        `INSERT INTO vendor_transactions(vendor_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
         VALUES(?,?,?,'pending_entitlement',?,'pending',?)`,
        [row.vendor_id, id, key, vendorAmount, json({ actorId, orderId: Number(row.order_id) })]
      );
    } else if (Number(existing.amount_paisa) !== vendorAmount) {
      throw new ConflictError('Existing vendor pending entitlement does not match the order snapshot.');
    }
  }
  return { subOrderId: id, resellerAmountPaisa: resellerAmount, vendorAmountPaisa: vendorAmount };
}

async function settleOneTx(tx, subOrderId, actor = {}) {
  const id = requirePositiveInt(subOrderId, 'sub-order ID');
  const amounts = await settlementAmounts(tx, id);
  if (amounts.row.status !== 'delivered') return { released: false, reason: 'not_delivered' };
  await recordPendingSettlementTx(tx, id, actor);
  const { row, vendorAmount, resellerAmount, marketplaceAmount } = amounts;
  let resellerReleased = false;
  let vendorReleased = false;

  if (row.reseller_id && resellerAmount > 0) {
    const key = `settle:reseller:${id}`;
    const prior = await tx.queryOne('SELECT id,amount_paisa FROM partner_transactions WHERE idempotency_key=? FOR UPDATE', [key]);
    if (!prior) {
      await tx.execute('INSERT IGNORE INTO partner_wallets(reseller_id) VALUES(?)', [row.reseller_id]);
      const wallet = await tx.queryOne('SELECT pending_balance FROM partner_wallets WHERE reseller_id=? FOR UPDATE', [row.reseller_id]);
      if (!wallet || Number(wallet.pending_balance) < resellerAmount) throw new ConflictError('Reseller pending balance is insufficient for settlement release.');
      await tx.execute('UPDATE partner_wallets SET pending_balance=pending_balance-?,available_balance=available_balance+? WHERE reseller_id=?', [resellerAmount, resellerAmount, row.reseller_id]);
      await tx.execute('UPDATE resellers SET balance_paisa=balance_paisa+? WHERE id=?', [resellerAmount, row.reseller_id]);
      await tx.execute(
        `INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
         VALUES(?,?,?,'settlement_release',?,'available',?)`,
        [row.reseller_id, id, key, resellerAmount, json({ orderId: Number(row.order_id), actorId: actor?.userId || actor?.id || null })]
      );
      resellerReleased = true;
    } else if (Number(prior.amount_paisa) !== resellerAmount) {
      throw new ConflictError('Existing reseller settlement release does not match the order snapshot.');
    }
  }
  if (vendorAmount > 0) {
    const key = `settle:vendor:${id}`;
    const prior = await tx.queryOne('SELECT id,amount_paisa FROM vendor_transactions WHERE idempotency_key=? FOR UPDATE', [key]);
    if (!prior) {
      await tx.execute('INSERT IGNORE INTO vendor_wallets(vendor_id) VALUES(?)', [row.vendor_id]);
      const wallet = await tx.queryOne('SELECT pending_settlement FROM vendor_wallets WHERE vendor_id=? FOR UPDATE', [row.vendor_id]);
      if (!wallet || Number(wallet.pending_settlement) < vendorAmount) throw new ConflictError('Vendor pending settlement is insufficient for release.');
      await tx.execute('UPDATE vendor_wallets SET pending_settlement=pending_settlement-?,available_balance=available_balance+? WHERE vendor_id=?', [vendorAmount, vendorAmount, row.vendor_id]);
      await tx.execute('UPDATE vendors SET balance_paisa=balance_paisa+? WHERE id=?', [vendorAmount, row.vendor_id]);
      await tx.execute(
        `INSERT INTO vendor_transactions(vendor_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
         VALUES(?,?,?,'settlement_release',?,'available',?)`,
        [row.vendor_id, id, key, vendorAmount, json({ orderId: Number(row.order_id), actorId: actor?.userId || actor?.id || null })]
      );
      vendorReleased = true;
    } else if (Number(prior.amount_paisa) !== vendorAmount) {
      throw new ConflictError('Existing vendor settlement release does not match the order snapshot.');
    }
  }
  if (marketplaceAmount > 0) {
    const key = `settle:marketplace:${id}`;
    const prior = await tx.queryOne('SELECT id,amount_paisa FROM marketplace_revenue_ledger WHERE idempotency_key=? FOR UPDATE', [key]);
    if (!prior) await tx.execute('INSERT INTO marketplace_revenue_ledger(sub_order_id,idempotency_key,amount_paisa) VALUES(?,?,?)', [id, key, marketplaceAmount]);
    else if (Number(prior.amount_paisa) !== marketplaceAmount) throw new ConflictError('Marketplace revenue snapshot changed after settlement.');
  }
  return { released: resellerReleased || vendorReleased, subOrderId: id, resellerReleased, vendorReleased,
    resellerAmountPaisa: resellerAmount, vendorAmountPaisa: vendorAmount, marketplaceRevenuePaisa: marketplaceAmount };
}

async function processMaturedSettlements({ returnWindowDays = 7, actor = {} } = {}) {
  assertMysql();
  const days = Number(returnWindowDays);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new ValidationError('Return window must be an integer from 0 to 365 days.');
  return mysql.withTransaction(async (tx) => {
    const candidates = await tx.queryAll(
      `SELECT so.id FROM vendor_sub_orders so JOIN orders o ON o.id=so.order_id
       WHERE so.status='delivered' AND so.delivered_at IS NOT NULL
         AND so.delivered_at<=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY)
         AND (o.payment_status='paid' OR (
           o.payment_method='cod'
           AND EXISTS (SELECT 1 FROM fulfillment_shipments fs WHERE fs.vendor_sub_order_id=so.id)
           AND NOT EXISTS (
             SELECT 1 FROM fulfillment_shipments fs LEFT JOIN courier_cod_collections c
               ON c.id=(SELECT MAX(c2.id) FROM courier_cod_collections c2 WHERE c2.shipment_id=fs.id)
             WHERE fs.vendor_sub_order_id=so.id AND COALESCE(c.reconciliation_status,'pending')<>'reconciled'
           )
         ))
       ORDER BY so.delivered_at,so.id LIMIT 500 FOR UPDATE`, [days]
    );
    const results = [];
    for (const candidate of candidates) results.push(await settleOneTx(tx, Number(candidate.id), actor));
    return {
      maturedCount: candidates.length,
      releasedCount: results.filter((result) => result.released).length,
      results,
    };
  });
}

module.exports = { processMaturedSettlements, recordPendingSettlementTx, settleOneTx, settlementAmounts };
