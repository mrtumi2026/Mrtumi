'use strict';

const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { recordAuditLog } = require('./auditLogRepository');
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

// A reseller order for the marketplace's own products has no vendor sub-order, so its earning
// is released from reseller_financial_ledger. Owner's rule: the order is delivered, the admin
// has confirmed the money was received, and the return window has passed.
const OWN_PRODUCT_EARNING_SQL = `FROM reseller_financial_ledger l
  JOIN orders o ON o.id=l.order_id
  JOIN resellers r ON r.id=l.reseller_id
  WHERE l.entry_type='earning' AND l.status='pending' AND l.reseller_id=o.reseller_id
    AND NOT EXISTS (SELECT 1 FROM vendor_sub_orders so WHERE so.order_id=o.id)`;
const DELIVERED_AT_SQL = `(SELECT MIN(h.created_at) FROM order_status_history h
  WHERE h.order_id=o.id AND h.to_status='delivered' AND h.vendor_sub_order_id IS NULL)`;
const HAS_OPEN_CLAIM_SQL = `(EXISTS (SELECT 1 FROM customer_return_requests rr WHERE rr.order_id=o.id AND rr.status<>'rejected')
  OR EXISTS (SELECT 1 FROM refunds rf WHERE rf.order_id=o.id AND rf.status NOT IN ('rejected','failed')))`;

async function listOwnProductResellerEarnings({ returnWindowDays = 7, pool = null } = {}) {
  assertMysql();
  const db = mysql.createQueryClient(pool || mysql.getPool());
  return db.queryAll(
    `SELECT o.id AS order_id,o.invoice_no,o.order_status,o.payment_status,o.total_paisa,l.amount_paisa,r.shop_name,
       ${DELIVERED_AT_SQL} AS delivered_at,
       DATE_ADD(${DELIVERED_AT_SQL},INTERVAL ? DAY) AS releasable_at,
       COALESCE(DATE_ADD(${DELIVERED_AT_SQL},INTERVAL ? DAY)<=UTC_TIMESTAMP(),0) AS window_passed,
       ${HAS_OPEN_CLAIM_SQL} AS has_open_claim
     ${OWN_PRODUCT_EARNING_SQL} AND o.order_status IN ('delivered','return_requested')
     ORDER BY o.id DESC LIMIT 300`, [Number(returnWindowDays), Number(returnWindowDays)]
  );
}

async function confirmDeliveredOrderPayment({ orderId, reference = '', actor = {}, resellerOnly = false } = {}) {
  assertMysql();
  const id = requirePositiveInt(orderId, 'order ID');
  const text = String(reference || '').trim();
  if (text.length < 3 || text.length > 120) throw new ValidationError('Enter the payment or courier remittance reference (3 to 120 characters).');
  return mysql.withTransaction(async (tx) => {
    const order = await tx.queryOne('SELECT id,reseller_id,order_status,payment_status,payment_method,total_paisa,paid_paisa FROM orders WHERE id=? FOR UPDATE', [id]);
    if (!order || (resellerOnly && !order.reseller_id)) throw new NotFoundError(resellerOnly ? 'Reseller order not found.' : 'Order not found.');
    if (!order.reseller_id && order.payment_method !== 'cod') throw new ConflictError('Only cash on delivery orders can be confirmed here.');
    const vendorPart = await tx.queryOne('SELECT id FROM vendor_sub_orders WHERE order_id=? LIMIT 1', [id]);
    if (vendorPart) throw new ConflictError('Vendor product orders are confirmed through COD reconciliation.');
    if (order.order_status !== 'delivered') throw new ConflictError('Money can be confirmed only after the order is delivered.');
    if (order.payment_status === 'paid') return { orderId: id, replayed: true };
    await tx.execute("UPDATE orders SET payment_status='paid',paid_paisa=total_paisa,cod_due_paisa=0,verified_by_user_id=?,verified_at=UTC_TIMESTAMP() WHERE id=?", [actor.id || null, id]);
    await tx.execute("UPDATE order_payments SET status='verified',verified_at=UTC_TIMESTAMP(),verified_by_user_id=? WHERE order_id=? AND status='pending_verification'", [actor.id || null, id]);
    await recordAuditLog({ actorType: 'admin', actorId: actor.id || null, action: order.reseller_id ? 'reseller_commerce.order.payment_confirmed' : 'order.cod_payment_confirmed',
      entityType: 'order', entityId: id,
      beforeState: { paymentStatus: order.payment_status, paidPaisa: Number(order.paid_paisa) },
      afterState: { paymentStatus: 'paid', paidPaisa: Number(order.total_paisa), reference: text },
      ipAddress: actor.ip || '', userAgent: actor.userAgent || '' }, tx);
    return { orderId: id, replayed: false };
  });
}

async function confirmResellerOrderPayment(input = {}) { return confirmDeliveredOrderPayment({ ...input, resellerOnly: true }); }

async function releaseOwnProductEarningsTx(tx, days, actor = {}) {
  const rows = await tx.queryAll(
    `SELECT l.id,l.reseller_id,l.order_id,l.amount_paisa ${OWN_PRODUCT_EARNING_SQL}
       AND o.order_status='delivered' AND o.payment_status='paid'
       AND ${DELIVERED_AT_SQL}<=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY)
       AND NOT ${HAS_OPEN_CLAIM_SQL}
     ORDER BY l.id LIMIT 500 FOR UPDATE`, [days]
  );
  for (const row of rows) {
    const amount = positivePaisa(row.amount_paisa, 'Reseller earning', false);
    await tx.execute('INSERT IGNORE INTO partner_wallets(reseller_id) VALUES(?)', [row.reseller_id]);
    await tx.queryOne('SELECT reseller_id FROM partner_wallets WHERE reseller_id=? FOR UPDATE', [row.reseller_id]);
    // The unique key on partner_transactions makes a second release of the same order impossible.
    await tx.execute(
      `INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
       VALUES(?,NULL,?,'settlement_release',?,'available',?)`,
      [row.reseller_id, `settle:reseller-order:${row.order_id}`, amount, json({ orderId: Number(row.order_id), actorId: actor?.userId || actor?.id || null })]
    );
    await tx.execute('UPDATE partner_wallets SET available_balance=available_balance+? WHERE reseller_id=?', [amount, row.reseller_id]);
    await tx.execute('UPDATE resellers SET balance_paisa=balance_paisa+? WHERE id=?', [amount, row.reseller_id]);
    await tx.execute("UPDATE reseller_financial_ledger SET status='released' WHERE id=? AND status='pending'", [row.id]);
  }
  return rows.length;
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
    const ownOrderReleasedCount = await releaseOwnProductEarningsTx(tx, days, actor);
    const summary = {
      maturedCount: candidates.length,
      releasedCount: results.filter((result) => result.released).length,
      ownOrderReleasedCount,
      results,
    };
    if (actor?.id || actor?.userId) {
      await recordAuditLog({ actorType: 'admin', actorId: actor.id || actor.userId, action: 'reseller_commerce.settlements.released',
        entityType: 'settlement_batch', entityId: 'matured', beforeState: {},
        afterState: { maturedCount: summary.maturedCount, releasedCount: summary.releasedCount, ownOrderReleasedCount },
        ipAddress: actor.ip || '', userAgent: actor.userAgent || '' }, tx);
    }
    return summary;
  });
}

module.exports = { listOwnProductResellerEarnings, confirmResellerOrderPayment, confirmDeliveredOrderPayment, processMaturedSettlements, recordPendingSettlementTx, settleOneTx, settlementAmounts };
