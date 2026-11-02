'use strict';

const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { requirePositiveInt } = require('../utils/validator');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

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
  vendor_accepted: 'accepted_at', processing: 'processing_at', packed: 'packed_at',
  ready_for_pickup: 'ready_for_pickup_at', in_transit: 'in_transit_at', delivered: 'delivered_at',
  return_requested: 'return_requested_at', returned: 'returned_at', failed_delivery: 'failed_delivery_at',
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
    if (target === 'in_transit' && !(tracking || row.tracking_code) ) throw new ValidationError('A tracking code is required before dispatch.');
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

module.exports = { transitionSubOrder, TRANSITIONS, STATUS_TIMESTAMP };
