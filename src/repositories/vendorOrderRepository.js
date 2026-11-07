'use strict';

/**
 * Vendor Order Repository & Multi-Vendor Lifecycle Engine
 * ========================================================
 * Implements strict multi-tenant vendor order isolation, state machine transitions,
 * status history auditing, and independent fulfillment tracking.
 */

const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { requirePositiveInt } = require('../utils/validator');
const { ValidationError, NotFoundError, ConflictError, AuthorizationError } = require('../utils/errors');
const { updateVendorOrderStatus } = require('../services/splitOrderService');

const TRANSITIONS = Object.freeze({
  order_placed: ['vendor_accepted', 'cancelled'],
  vendor_accepted: ['processing', 'cancelled'],
  processing: ['packed', 'cancelled'],
  packed: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: ['in_transit', 'failed_delivery', 'cancelled'],
  in_transit: ['delivered', 'failed_delivery', 'return_requested'],
  failed_delivery: ['ready_for_pickup', 'cancelled'],
  delivered: ['return_requested'],
  return_requested: ['returned'],
  returned: [],
  cancelled: [],
});

const STATUS_TIMESTAMP = Object.freeze({
  vendor_accepted: 'accepted_at',
  processing: 'processing_at',
  packed: 'packed_at',
  ready_for_pickup: 'ready_for_pickup_at',
  in_transit: 'in_transit_at',
  delivered: 'delivered_at',
  return_requested: 'return_requested_at',
  returned: 'returned_at',
  failed_delivery: 'failed_delivery_at',
  cancelled: 'cancelled_at',
});

function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Vendor sub-order lifecycle requires MySQL.');
}

function text(value, label, max = 120) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return result;
}

/**
 * State machine transition for vendor sub-orders with full transactional auditing.
 */
async function transitionSubOrder({ subOrderId, toStatus, carrier, trackingCode, note = '', actor = {} } = {}) {
  assertMysql();
  const id = requirePositiveInt(subOrderId, 'sub-order ID');
  const target = String(toStatus || '').trim();
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, target)) throw new ValidationError('Unsupported vendor sub-order state.');
  const carrierName = text(carrier, 'Shipment carrier', 48);
  const tracking = text(trackingCode, 'Tracking code', 120);
  const statusNote = text(note, 'Status note', 255);
  const ownerId = actor?.vendorId ? requirePositiveInt(actor.vendorId, 'vendor ID') : null;
  const userId = actor?.userId ? requirePositiveInt(actor.userId, 'actor ID') : null;

  return mysql.withTransaction(async (tx) => {
    const row = await tx.queryOne(
      `SELECT so.*,o.order_status AS parent_status,o.payment_status,o.payment_method,o.cod_due_paisa AS parent_cod_due
       FROM vendor_sub_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=? FOR UPDATE`, [id]
    );
    if (!row) throw new NotFoundError('Vendor sub-order not found.');
    if (ownerId && Number(row.vendor_id) !== ownerId) throw new NotFoundError('Vendor sub-order not found.');
    const from = String(row.status);
    if (from === target) return { subOrderId: id, from, to: target, replayed: true };
    if (!TRANSITIONS[from]?.includes(target)) throw new ConflictError(`Vendor sub-order cannot move from ${from} to ${target}.`);
    if (target === 'in_transit' && !(tracking || row.tracking_code)) throw new ValidationError('A tracking code is required before dispatch.');
    if (target === 'in_transit' && !(carrierName || row.shipment_carrier)) throw new ValidationError('A shipment carrier is required before dispatch.');

    const timestampColumn = STATUS_TIMESTAMP[target];
    const timestampSet = timestampColumn ? `,${timestampColumn}=UTC_TIMESTAMP()` : '';
    await tx.execute(
      `UPDATE vendor_sub_orders SET status=?,shipment_carrier=COALESCE(NULLIF(?,''),shipment_carrier),
       tracking_code=COALESCE(NULLIF(?,''),tracking_code)${timestampSet} WHERE id=? AND status=?`,
      [target, carrierName, tracking, id, from]
    );
    await tx.execute(
      'INSERT INTO vendor_order_status_history(order_id,vendor_id,vendor_sub_order_id,from_status,to_status) VALUES(?,?,?,?,?)',
      [row.order_id, row.vendor_id, id, from, target]
    );
    await tx.execute(
      'INSERT INTO order_status_history(order_id,vendor_sub_order_id,from_status,to_status,note,changed_by_user_id) VALUES(?,?,?,?,?,?)',
      [row.order_id, id, from, target, statusNote, userId]
    );

    if (['ready_for_pickup', 'in_transit', 'delivered', 'failed_delivery', 'return_requested', 'returned'].includes(target)) {
      const shipment = await tx.queryOne(
        'SELECT id FROM fulfillment_shipments WHERE vendor_sub_order_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE', [id]
      );
      const shipmentStatus = target === 'delivered' ? 'delivered'
        : target === 'in_transit' ? 'in_transit'
          : target === 'failed_delivery' ? 'failed_delivery'
            : target === 'returned' ? 'returned'
              : target === 'return_requested' ? 'return_requested' : 'ready_for_pickup';
      if (shipment) {
        await tx.execute(
          `UPDATE fulfillment_shipments SET courier_code=COALESCE(NULLIF(?,''),courier_code),
           tracking_id=COALESCE(NULLIF(?,''),tracking_id),status=?${target === 'delivered' ? ',delivered_at=UTC_TIMESTAMP()' : ''} WHERE id=?`,
          [carrierName, tracking, shipmentStatus, shipment.id]
        );
      } else {
        const cod = await tx.queryOne(
          `SELECT COALESCE(NULLIF(so.cod_due_paisa,0),SUM(oi.line_total_paisa),0) AS due_paisa
           FROM vendor_sub_orders so LEFT JOIN vendor_sub_order_items si ON si.vendor_sub_order_id=so.id
           LEFT JOIN order_items oi ON oi.id=si.order_item_id WHERE so.id=? GROUP BY so.id`, [id]
        );
        const due = row.payment_method === 'cod' && row.payment_status !== 'paid' ? Number(cod?.due_paisa || 0) : 0;
        await tx.execute(
          `INSERT INTO fulfillment_shipments(vendor_sub_order_id,courier_code,tracking_id,status,cod_due_paisa${target === 'delivered' ? ',delivered_at' : ''})
           VALUES(?,?,?,?,?${target === 'delivered' ? ',UTC_TIMESTAMP()' : ''})`,
          [id, carrierName || row.shipment_carrier || '', tracking || row.tracking_code || '', shipmentStatus, due]
        );
      }
    }

    if (target === 'delivered') {
      const settlement = require('./partnerSettlementRepository');
      await settlement.recordPendingSettlementTx(tx, id, actor);
      const pending = await tx.queryOne(
        `SELECT COUNT(*) AS n FROM vendor_sub_orders WHERE order_id=? AND status NOT IN ('delivered','cancelled')`, [row.order_id]
      );
      if (Number(pending?.n || 0) === 0 && !['delivered', 'cancelled', 'returned'].includes(row.parent_status)) {
        const changed = await tx.execute("UPDATE orders SET order_status='delivered' WHERE id=? AND order_status=?", [row.order_id, row.parent_status]);
        if (changed.affectedRows === 1) {
          await tx.execute(
            `INSERT INTO order_status_history(order_id,from_status,to_status,note,changed_by_user_id)
             VALUES(?,?,'delivered','All active vendor sub-orders delivered',?)`,
            [row.order_id, row.parent_status, userId]
          );
        }
      }
    }
    return { subOrderId: id, from, to: target, replayed: false };
  });
}

/**
 * List paginated vendor sub-orders for the authenticated vendor.
 *
 * @param {number} vendorId
 * @param {object} query
 */
async function listVendorSubOrders(vendorId, { page = 1, limit = 20, status = '' } = {}) {
  const pool = mysql.getPool();
  const vId = Number(vendorId);
  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (pageNum - 1) * pageSize;

  const conditions = ['vo.vendor_id = ?'];
  const params = [vId];

  if (status && status !== 'all') {
    conditions.push('vo.status = ?');
    params.push(status);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM vendor_orders vo ${whereClause}`,
    params
  );
  const total = Number(countRows[0]?.total || 0);

  const [orders] = await pool.query(
    `SELECT vo.id, vo.order_id, vo.sub_order_ref, vo.status, vo.subtotal_paisa,
            vo.commission_paisa, vo.gateway_fee_paisa, vo.shipping_paisa,
            vo.vendor_earning_paisa, vo.courier_code, vo.courier_tracking_id,
            vo.created_at, o.customer_name, o.customer_phone, o.shipping_address,
            o.district, o.payment_status, o.payment_method
     FROM vendor_orders vo
     JOIN orders o ON o.id = vo.order_id
     ${whereClause}
     ORDER BY vo.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return {
    orders: orders || [],
    pagination: {
      total,
      page: pageNum,
      limit: pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    },
  };
}

/**
 * Get detailed view of a single sub-order with its line items.
 * Strictly verifies vendor ownership.
 */
async function getVendorSubOrderDetail(vendorId, vendorOrderId) {
  const pool = mysql.getPool();
  const vId = Number(vendorId);
  const voId = Number(vendorOrderId);

  const [orderRows] = await pool.query(
    `SELECT vo.*, o.invoice_no, o.customer_name, o.customer_phone,
            o.shipping_address, o.division, o.district, o.upazila,
            o.payment_method, o.payment_status, o.created_at AS parent_order_date
     FROM vendor_orders vo
     JOIN orders o ON o.id = vo.order_id
     WHERE vo.id = ? AND vo.vendor_id = ?
     LIMIT 1`,
    [voId, vId]
  );

  const order = orderRows && orderRows[0];
  if (!order) {
    throw new NotFoundError('Vendor order not found or does not belong to your shop.');
  }

  const [items] = await pool.query(
    `SELECT voi.*, p.title_en, p.title_bn, p.sku, p.image_path
     FROM vendor_order_items voi
     LEFT JOIN products p ON p.id = voi.product_id
     WHERE voi.vendor_order_id = ?`,
    [voId]
  );

  return {
    order,
    items: items || [],
  };
}

/**
 * Vendor-initiated status update (e.g. mark packed, mark shipped).
 * Prevents unauthorized or fraudulent transitions.
 */
async function vendorUpdateStatus(vendorId, vendorOrderId, { status, courierCode, trackingId, reason }) {
  const vId = Number(vendorId);
  const voId = Number(vendorOrderId);

  // Vendor allowed transitions
  const ALLOWED_VENDOR_ACTIONS = ['processing', 'packed', 'shipped', 'cancelled'];
  if (!ALLOWED_VENDOR_ACTIONS.includes(status)) {
    throw new ValidationError(`Vendors are only permitted to transition orders to: ${ALLOWED_VENDOR_ACTIONS.join(', ')}`);
  }

  const pool = mysql.getPool();
  // Ensure the sub-order belongs to this vendor before mutating
  const [existing] = await pool.query(
    'SELECT id, status FROM vendor_orders WHERE id = ? AND vendor_id = ?',
    [voId, vId]
  );

  if (!existing || existing.length === 0) {
    throw new AuthorizationError('Access denied: You cannot update another vendor’s order.');
  }

  return updateVendorOrderStatus(voId, status, {
    actor: { type: 'vendor', id: vId },
    courierCode: courierCode || '',
    trackingId: trackingId || '',
    reason: reason || '',
  });
}

module.exports = {
  transitionSubOrder,
  TRANSITIONS,
  STATUS_TIMESTAMP,
  listVendorSubOrders,
  getVendorSubOrderDetail,
  vendorUpdateStatus,
};
