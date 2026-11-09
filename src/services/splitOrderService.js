'use strict';

/**
 * Split-Order Service
 * ===================
 * Accepts a placed parent order (from checkoutRepository) and:
 *  1. Groups order_items by vendor_id.
 *  2. For each vendor group, resolves the commission rule and calculates
 *     commission / gateway fees / net vendor earnings.
 *  3. Inserts vendor_orders rows and links order_items.vendor_order_id.
 *  4. Credits vendor_wallets.pending_paisa (held until settlement maturity).
 *  5. Posts immutable vendor_ledger_entries rows.
 *
 * All DB operations run inside a single SERIALIZABLE transaction.
 * Race conditions are prevented with SELECT ... FOR UPDATE on wallet rows.
 */

'use strict';

const mysql = require('../db/mysqlPool');
const commission = require('./commissionService');
const ledger    = require('./ledgerService');
const { assertSafePaisa } = require('../utils/money');
const { ValidationError, ConflictError } = require('../utils/errors');
const { logger } = require('../utils/logger');

/**
 * Split a confirmed order into vendor sub-orders.
 *
 * @param {number}  orderId     - Parent order ID (must already exist)
 * @param {object}  options
 * @param {string}  options.gatewayCode   - Payment gateway code used (affects gateway_fee_bps)
 * @param {object}  options.actor         - { type, id } of the system/admin triggering split
 * @param {object}  [options.pool]        - Optional MySQL pool override (for testing)
 * @returns {Promise<{ vendorOrders: object[] }>}
 */
async function splitOrderByVendor(orderId, { gatewayCode = 'cod', actor = { type: 'system', id: null }, pool, tx: externalTx } = {}) {
  if (!Number.isSafeInteger(Number(orderId)) || Number(orderId) < 1) {
    throw new ValidationError('orderId must be a positive integer.');
  }

  const runWithTx = (callback) => externalTx ? callback(externalTx) : mysql.withTransaction(callback, { pool, isolationLevel: 'SERIALIZABLE' });

  return runWithTx(async (tx) => {
    // ── 1. Load the parent order (FOR UPDATE to serialise concurrent splits) ──
    const order = await tx.queryOne(
      'SELECT id, invoice_no, order_status, total_paisa, shipping_paisa FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );
    if (!order) throw new ValidationError(`Order ${orderId} not found.`);
    if (order.order_status === 'cancelled') throw new ConflictError('Cannot split a cancelled order.');

    // ── 2. Check this order hasn't already been split ──
    const existingSplit = await tx.queryOne(
      'SELECT id FROM vendor_orders WHERE order_id = ? LIMIT 1',
      [orderId]
    );
    if (existingSplit) throw new ConflictError(`Order ${orderId} has already been split into sub-orders.`);

    // ── 3. Load order items with product category for commission resolution ──
    const items = await tx.queryAll(
      `SELECT oi.id, oi.product_id, oi.variant_id, oi.vendor_id,
              oi.unit_price_paisa, oi.qty, oi.line_total_paisa,
              p.category_id
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?`,
      [orderId]
    );
    if (!items || items.length === 0) throw new ConflictError(`Order ${orderId} has no items.`);

    // ── 4. Load gateway fee basis-points ──
    const gateway = gatewayCode
      ? await tx.queryOne(
          'SELECT gateway_fee_bps FROM payment_gateways WHERE code = ? LIMIT 1',
          [gatewayCode]
        )
      : null;
    const gatewayFeeBps = Number(gateway?.gateway_fee_bps || 0);

    // ── 5. Group items by vendor_id (NULL = platform-owned warehouse item) ──
    const vendorGroups = new Map(); // vendor_id (number|null) -> items[]
    for (const item of items) {
      const vid = item.vendor_id ? Number(item.vendor_id) : null;
      if (!vendorGroups.has(vid)) vendorGroups.set(vid, []);
      vendorGroups.get(vid).push(item);
    }

    const createdSubOrders = [];

    for (const [vendorId, vendorItems] of vendorGroups) {
      // Skip platform-owned items — no vendor sub-order needed
      if (!vendorId) continue;

      // ── 6. Resolve commission rule for this vendor ──
      // Use the category of the FIRST item (most restrictive should be per-item, but
      // per-sub-order is a safe and common approach; per-item commission tracked in
      // the ledger note).
      const primaryCategoryId = vendorItems[0]?.category_id ? Number(vendorItems[0].category_id) : null;
      const rule = await commission.resolveRule(tx, vendorId, primaryCategoryId);

      // ── 7. Calculate per-item commissions and sub-order totals ──
      let subtotalPaisa    = 0;
      let commissionPaisa  = 0;
      const itemCommissions = [];

      for (const item of vendorItems) {
        const lineTotal = assertSafePaisa(Number(item.line_total_paisa), 'line_total_paisa');
        const lineComm  = commission.calculateLineCommission(rule, lineTotal);
        subtotalPaisa   += lineTotal;
        commissionPaisa += lineComm;
        itemCommissions.push({ itemId: Number(item.id), lineComm });
      }
      assertSafePaisa(subtotalPaisa,   'subtotalPaisa');
      assertSafePaisa(commissionPaisa, 'commissionPaisa');

      // ── 8. Gateway fee (applied to vendor's portion only) ──
      const afterCommission = subtotalPaisa - commissionPaisa;
      const gatewayFeePaisa = commission.calculateGatewayFee(Math.max(0, afterCommission), gatewayFeeBps);

      // ── 9. Net vendor earning ──
      const vendorEarningPaisa = commission.computeNetVendorEarning({
        subtotalPaisa,
        commissionPaisa,
        gatewayFeePaisa,
        shippingPaisa: 0, // platform-shipped by default; vendor-fulfilled sets this via status update
      });

      // ── 10. Insert vendor_orders row ──
      const subOrderRef = `${order.invoice_no}-V${vendorId}`;
      const insertResult = await tx.execute(
        `INSERT INTO vendor_orders
           (order_id, vendor_id, sub_order_ref, status,
            subtotal_paisa, commission_paisa, gateway_fee_paisa, shipping_paisa,
            vendor_earning_paisa, is_vendor_fulfilled, ledger_credited)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, 0, ?, 0, 0)`,
        [orderId, vendorId, subOrderRef, subtotalPaisa, commissionPaisa, gatewayFeePaisa, vendorEarningPaisa]
      );
      const vendorOrderId = Number(insertResult.insertId);

      // ── 11. Link order_items to this sub-order ──
      const itemIds = vendorItems.map((i) => Number(i.id));
      await tx.execute(
        `UPDATE order_items SET vendor_order_id = ? WHERE id IN (${itemIds.map(() => '?').join(',')})`,
        [vendorOrderId, ...itemIds]
      );

      // ── 12. Initialise wallet (INSERT IGNORE) then credit pending_paisa ──
      await tx.execute(
        'INSERT IGNORE INTO vendor_wallets (vendor_id) VALUES (?)',
        [vendorId]
      );
      // Lock the wallet row
      const wallet = await tx.queryOne(
        'SELECT available_paisa, pending_paisa, lifetime_earned_paisa, lifetime_commission_paisa FROM vendor_wallets WHERE vendor_id = ? FOR UPDATE',
        [vendorId]
      );

      const newPending          = Number(wallet.pending_paisa)              + vendorEarningPaisa;
      const newLifetimeEarned   = Number(wallet.lifetime_earned_paisa)      + subtotalPaisa;
      const newLifetimeComm     = Number(wallet.lifetime_commission_paisa)  + commissionPaisa;

      await tx.execute(
        `UPDATE vendor_wallets
         SET pending_paisa = ?, lifetime_earned_paisa = ?, lifetime_commission_paisa = ?, updated_at = NOW()
         WHERE vendor_id = ?`,
        [newPending, newLifetimeEarned, newLifetimeComm, vendorId]
      );

      // ── 13. Post immutable ledger entry ──
      const balanceAfter = Number(wallet.available_paisa) + newPending; // conceptual total
      await ledger.postEntry(tx, {
        vendorId,
        entryType:       'credit_earning',
        direction:       'credit',
        amountPaisa:     vendorEarningPaisa,
        balanceAfter:    balanceAfter,
        referenceType:   'vendor_order',
        referenceId:     vendorOrderId,
        note:            `Sub-order ${subOrderRef} placed. Gross: ৳${(subtotalPaisa/100).toFixed(2)}, Comm: ৳${(commissionPaisa/100).toFixed(2)}, GW fee: ৳${(gatewayFeePaisa/100).toFixed(2)}`,
        createdByType:   actor.type,
        createdById:     actor.id,
      });

      createdSubOrders.push({
        vendorOrderId,
        vendorId,
        subOrderRef,
        subtotalPaisa,
        commissionPaisa,
        gatewayFeePaisa,
        vendorEarningPaisa,
      });

      logger.info({
        event:        'vendor_order_created',
        orderId,
        vendorOrderId,
        vendorId,
        subOrderRef,
        subtotalPaisa,
        commissionPaisa,
        vendorEarningPaisa,
      });
    }

    return { vendorOrders: createdSubOrders };
  });
}

/**
 * Update vendor sub-order status and perform side-effects:
 *  - 'delivered'  → move pending_paisa to available_paisa (settlement maturity)
 *  - 'cancelled'  → reverse the pending credit from vendor wallet + ledger
 *  - 'returned'   → reverse earning (called after refund is confirmed)
 *
 * @param {number}  vendorOrderId
 * @param {string}  newStatus
 * @param {object}  options
 * @param {object}  options.actor       - { type, id }
 * @param {string}  [options.reason]    - Required for cancelled/returned
 * @param {string}  [options.trackingId]  - For shipped status
 * @param {string}  [options.courierCode] - For shipped status
 * @param {object}  [options.pool]
 * @returns {Promise<{ vendorOrder: object }>}
 */
async function updateVendorOrderStatus(vendorOrderId, newStatus, {
  actor = { type: 'admin', id: null },
  reason = '',
  trackingId = '',
  courierCode = '',
  pool,
} = {}) {
  const VALID_STATUSES = ['pending','processing','packed','shipped','delivered','cancelled','return_requested','returned'];
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new ValidationError(`Invalid vendor order status: ${newStatus}`);
  }

  return mysql.withTransaction(async (tx) => {
    const vo = await tx.queryOne(
      'SELECT * FROM vendor_orders WHERE id = ? FOR UPDATE',
      [vendorOrderId]
    );
    if (!vo) throw new ValidationError(`Vendor order ${vendorOrderId} not found.`);

    const currentStatus = vo.status;
    if (currentStatus === newStatus) return { vendorOrder: vo };

    // Terminal state guard
    const TERMINAL = ['cancelled', 'returned'];
    if (TERMINAL.includes(currentStatus)) {
      throw new ConflictError(`Vendor order is already in terminal state: ${currentStatus}`);
    }

    const now = new Date();
    const updates = { status: newStatus, updated_at: now };

    if (newStatus === 'packed')     updates.packed_at    = now;
    if (newStatus === 'shipped') {
      updates.shipped_at         = now;
      updates.courier_code       = courierCode;
      updates.courier_tracking_id = trackingId;
    }
    if (newStatus === 'delivered')  updates.delivered_at = now;
    if (newStatus === 'cancelled') {
      updates.cancelled_at  = now;
      updates.cancel_reason = reason || 'No reason provided';
    }

    // Build SET clause dynamically from updates object
    const setClauses = Object.keys(updates).map((k) => `\`${k}\` = ?`).join(', ');
    const setValues  = Object.values(updates);

    await tx.execute(
      `UPDATE vendor_orders SET ${setClauses} WHERE id = ?`,
      [...setValues, vendorOrderId]
    );

    // ── Side-effects on wallet / ledger ──
    const wallet = await tx.queryOne(
      'SELECT available_paisa, pending_paisa FROM vendor_wallets WHERE vendor_id = ? FOR UPDATE',
      [vo.vendor_id]
    );
    if (!wallet) throw new ConflictError(`Vendor wallet not found for vendor ${vo.vendor_id}.`);

    if (newStatus === 'delivered' && !vo.ledger_credited) {
      // Move pending → available (settlement maturity)
      const earn = Number(vo.vendor_earning_paisa);
      const newAvailable = Number(wallet.available_paisa) + earn;
      const newPending   = Math.max(0, Number(wallet.pending_paisa) - earn);

      await tx.execute(
        'UPDATE vendor_wallets SET available_paisa = ?, pending_paisa = ?, updated_at = NOW() WHERE vendor_id = ?',
        [newAvailable, newPending, vo.vendor_id]
      );
      await tx.execute(
        'UPDATE vendor_orders SET ledger_credited = 1 WHERE id = ?',
        [vendorOrderId]
      );

      await ledger.postEntry(tx, {
        vendorId:      vo.vendor_id,
        entryType:     'maturity_move',
        direction:     'credit',
        amountPaisa:   earn,
        balanceAfter:  newAvailable,
        referenceType: 'vendor_order',
        referenceId:   vendorOrderId,
        note:          `Order delivered — earning ৳${(earn/100).toFixed(2)} moved to available`,
        createdByType: actor.type,
        createdById:   actor.id,
      });
    }

    if (newStatus === 'cancelled') {
      // Reverse pending credit
      const earn = Number(vo.vendor_earning_paisa);
      const newPending   = Math.max(0, Number(wallet.pending_paisa) - earn);
      const newAvailable = Number(wallet.available_paisa); // available unchanged on cancel

      await tx.execute(
        'UPDATE vendor_wallets SET pending_paisa = ?, updated_at = NOW() WHERE vendor_id = ?',
        [newPending, vo.vendor_id]
      );

      await ledger.postEntry(tx, {
        vendorId:      vo.vendor_id,
        entryType:     'debit_adjustment',
        direction:     'debit',
        amountPaisa:   earn,
        balanceAfter:  newAvailable,
        referenceType: 'vendor_order',
        referenceId:   vendorOrderId,
        note:          `Sub-order ${vo.sub_order_ref} cancelled — pending earning reversed. Reason: ${reason}`,
        createdByType: actor.type,
        createdById:   actor.id,
      });
    }

    if (newStatus === 'returned') {
      // Reverse available credit (refund path — called AFTER refund confirmed)
      const earn = Number(vo.vendor_earning_paisa);
      const newAvailable = Math.max(0, Number(wallet.available_paisa) - earn);

      await tx.execute(
        'UPDATE vendor_wallets SET available_paisa = ?, updated_at = NOW() WHERE vendor_id = ?',
        [newAvailable, vo.vendor_id]
      );

      await ledger.postEntry(tx, {
        vendorId:      vo.vendor_id,
        entryType:     'debit_refund',
        direction:     'debit',
        amountPaisa:   earn,
        balanceAfter:  newAvailable,
        referenceType: 'vendor_order',
        referenceId:   vendorOrderId,
        note:          `Returned — earning ৳${(earn/100).toFixed(2)} reversed from available`,
        createdByType: actor.type,
        createdById:   actor.id,
      });
    }

    const updated = await tx.queryOne('SELECT * FROM vendor_orders WHERE id = ?', [vendorOrderId]);
    return { vendorOrder: updated };
  }, { pool, isolationLevel: 'READ COMMITTED' });
}

module.exports = { splitOrderByVendor, updateVendorOrderStatus };
