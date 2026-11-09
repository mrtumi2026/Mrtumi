'use strict';

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
  ready_for_pickup: [],
  in_transit: ['delivered', 'failed_delivery'],
  failed_delivery: ['ready_for_pickup'],
  delivered: ['return_requested'],
  return_requested: ['returned'],
  returned: [],
  cancelled: [],
});
const STATUS_TIMESTAMP = Object.freeze({
  vendor_accepted: 'accepted_at', processing: 'processing_at', packed: 'packed_at',
  ready_for_pickup: 'ready_for_pickup_at', in_transit: 'in_transit_at', delivered: 'delivered_at',
  return_requested: 'return_requested_at', returned: 'returned_at', failed_delivery: 'failed_delivery_at', cancelled: 'cancelled_at',
});
const DELIVERY_MODES = new Set(['platform_managed', 'vendor_managed']);

function assertMysql() { if (env.db.client !== 'mysql') throw new Error('Vendor sub-order lifecycle requires MySQL.'); }
function text(value, label, max = 120) { const result = String(value ?? '').trim(); if (result.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`); return result; }
function actorValues(actor = {}) {
  const vendorId = actor.vendorId ? requirePositiveInt(actor.vendorId, 'vendor ID') : null;
  const userId = actor.userId ? requirePositiveInt(actor.userId, 'actor ID') : null;
  if (!vendorId && !userId) throw new AuthorizationError('An authorized fulfillment actor is required.');
  return { vendorId, userId, actorType: vendorId ? 'vendor' : 'admin', platformAdmin: actor.platformAdmin === true };
}
async function lockSubOrder(tx, id, actor) {
  const reference=await tx.queryOne('SELECT id,order_id,vendor_id FROM vendor_sub_orders WHERE id=?',[id]);
  if(!reference)throw new NotFoundError('Vendor sub-order not found.');
  if(actor.vendorId&&Number(reference.vendor_id)!==actor.vendorId)throw new NotFoundError('Vendor sub-order not found.');
  await tx.queryOne('SELECT id FROM orders WHERE id=? FOR UPDATE',[reference.order_id]);
  const row = await tx.queryOne(`SELECT so.*,o.order_status AS parent_status,o.payment_status,o.payment_method,o.cod_due_paisa AS parent_cod_due
    FROM vendor_sub_orders so JOIN orders o ON o.id=so.order_id WHERE so.id=? FOR UPDATE`, [id]);
  if (!row) throw new NotFoundError('Vendor sub-order not found.');
  return row;
}
async function latestShipment(tx, id) {
  return tx.queryOne('SELECT * FROM fulfillment_shipments WHERE vendor_sub_order_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE', [id]);
}
async function insertShipmentEvent(tx, shipmentId, eventType, actor, extra = {}) {
  await tx.execute(`INSERT INTO fulfillment_shipment_events(shipment_id,event_type,actor_type,vendor_id,user_id,courier_code,tracking_reference,result_code,note,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`, [shipmentId,eventType,actor.actorType,actor.vendorId,actor.userId,extra.courierCode || '',extra.trackingReference || '',extra.resultCode || '',extra.note || '']);
}
async function recordSubOrderStatus(tx, row, target, actor, note = '') {
  const timestampColumn = STATUS_TIMESTAMP[target];
  const timestampSet = timestampColumn ? `,${timestampColumn}=UTC_TIMESTAMP()` : '';
  await tx.execute(`UPDATE vendor_sub_orders SET status=?${timestampSet} WHERE id=? AND status=?`, [target,row.id,row.status]);
  await tx.execute('INSERT INTO vendor_order_status_history(order_id,vendor_id,vendor_sub_order_id,from_status,to_status) VALUES(?,?,?,?,?)', [row.order_id,row.vendor_id,row.id,row.status,target]);
  await tx.execute('INSERT INTO order_status_history(order_id,vendor_sub_order_id,from_status,to_status,note,changed_by_user_id) VALUES(?,?,?,?,?,?)', [row.order_id,row.id,row.status,target,String(note || '').slice(0,255),actor.userId]);
}
async function syncParentStatus(tx, orderId, priorStatus, userId) {
  const rows = await tx.queryAll('SELECT id,status FROM vendor_sub_orders WHERE order_id=? ORDER BY id FOR UPDATE', [orderId]);
  const applicableRows=rows.filter((row)=>row.status!=='cancelled');
  const applicable=applicableRows.length;
  if(!applicable)return priorStatus;
  let target=null;
  if(applicableRows.every((row)=>row.status==='delivered'))target='delivered';
  else if(applicableRows.every((row)=>['in_transit','delivered'].includes(row.status)))target='shipped';
  if (!target) return priorStatus;
  const rank = { pending:0, confirmed:1, processing:2, shipped:3, delivered:4 };
  if (!Object.hasOwn(rank,priorStatus) || (rank[target] ?? 0) <= rank[priorStatus]) return priorStatus;
  const changed = await tx.execute('UPDATE orders SET order_status=? WHERE id=? AND order_status=?', [target,orderId,priorStatus]);
  if (changed.affectedRows === 1) await tx.execute('INSERT INTO order_status_history(order_id,from_status,to_status,note,changed_by_user_id) VALUES(?,?,?,?,?)', [orderId,priorStatus,target,target==='delivered'?'All applicable vendor sub-orders delivered':'All applicable vendor sub-orders handed over',userId]);
  return changed.affectedRows === 1 ? target : priorStatus;
}

async function transitionSubOrder({ subOrderId, toStatus, note = '', actor = {} } = {}) {
  assertMysql(); const id=requirePositiveInt(subOrderId,'sub-order ID'); const target=String(toStatus||'').trim();
  if (!Object.hasOwn(TRANSITIONS,target)) throw new ValidationError('Unsupported vendor sub-order state.');
  const who=actorValues(actor);
  return mysql.withTransaction(async tx=>{
    const row=await lockSubOrder(tx,id,who); const from=String(row.status);
    if(target==='in_transit')throw new ConflictError('Transit status requires a separately recorded physical handover event.');
    if(['delivered','failed_delivery','return_requested','returned'].includes(target)&&!who.platformAdmin)throw new AuthorizationError('Only an authorized platform administrator may confirm this shipment event.');
    if(from===target)return{subOrderId:id,from,to:target,replayed:true};
    if(!TRANSITIONS[from]?.includes(target))throw new ConflictError(`Vendor sub-order cannot move from ${from} to ${target}.`);
    if(target==='cancelled'&&from==='ready_for_pickup') throw new ConflictError('A pickup-ready shipment requires an authorized shipment decision.');
    await recordSubOrderStatus(tx,row,target,who,note);
    if(target==='ready_for_pickup'){
      const cod=await tx.queryOne(`SELECT COALESCE(NULLIF(so.cod_due_paisa,0),SUM(oi.line_total_paisa),0) AS due_paisa
        FROM vendor_sub_orders so LEFT JOIN vendor_sub_order_items si ON si.vendor_sub_order_id=so.id
        LEFT JOIN order_items oi ON oi.id=si.order_item_id WHERE so.id=? GROUP BY so.id`,[id]);
      const due=row.payment_method==='cod'&&row.payment_status!=='paid'?Number(cod?.due_paisa||0):0;
      await tx.execute("INSERT INTO fulfillment_shipments(vendor_sub_order_id,status,cod_due_paisa) VALUES(?,'ready_for_pickup',?)",[id,due]);
    }
    let parentStatus=row.parent_status;
    if(target==='delivered'){
      if(!who.platformAdmin)throw new AuthorizationError('Only an authorized platform administrator may confirm delivery.');
      const shipment=await latestShipment(tx,id);
      if(!shipment?.picked_up_at)throw new ConflictError('Delivery cannot be confirmed before a recorded physical handover.');
      await tx.execute("UPDATE fulfillment_shipments SET status='delivered',delivered_at=UTC_TIMESTAMP() WHERE id=?",[shipment.id]);
      await insertShipmentEvent(tx,shipment.id,'delivery_confirmed',who,{note:String(note||'').slice(0,255)});
      await require('./partnerSettlementRepository').recordPendingSettlementTx(tx,id,{id:who.userId});
      parentStatus=await syncParentStatus(tx,row.order_id,row.parent_status,who.userId);
    } else if(target==='failed_delivery'){
      const shipment=await latestShipment(tx,id);
      if(!shipment?.picked_up_at)throw new ConflictError('Failed delivery requires a prior physical handover event.');
      await tx.execute("UPDATE fulfillment_shipments SET status='failed_delivery' WHERE id=?",[shipment.id]);
      await insertShipmentEvent(tx,shipment.id,'delivery_failed',who,{note:String(note||'').slice(0,255)});
    } else if(target==='returned'){
      const shipment=await latestShipment(tx,id);
      if(!shipment||shipment.status!=='delivered')throw new ConflictError('A return cannot be confirmed without a delivered shipment record.');
      await tx.execute("UPDATE fulfillment_shipments SET status='returned' WHERE id=?",[shipment.id]);
      await insertShipmentEvent(tx,shipment.id,'return_confirmed',who,{note:String(note||'').slice(0,255)});
    }
    return{subOrderId:id,from,to:target,replayed:false,parentStatus};
  });
}

async function setDeliveryMode({subOrderId,deliveryMode,actor={}}={}) {
  assertMysql(); const id=requirePositiveInt(subOrderId,'sub-order ID'); const mode=String(deliveryMode||'');
  if(!DELIVERY_MODES.has(mode))throw new ValidationError('Unsupported delivery ownership mode.');
  const who=actorValues(actor); if(!who.platformAdmin)throw new AuthorizationError('Only an authorized platform administrator may set delivery ownership.');
  return mysql.withTransaction(async tx=>{const row=await lockSubOrder(tx,id,who); if(row.delivery_mode&&row.delivery_mode!==mode)throw new ConflictError('Delivery ownership cannot be changed once assigned.'); await tx.execute('UPDATE vendor_sub_orders SET delivery_mode=? WHERE id=? AND delivery_mode IS NULL',[mode,id]); return{deliveryMode:mode,subOrderId:id};});
}

async function recordBookingResult({subOrderId,courierCode,trackingReference='',resultCode,note='',actor={}}={}) {
  assertMysql(); const id=requirePositiveInt(subOrderId,'sub-order ID'); const courier=text(courierCode,'Courier',48); const tracking=text(trackingReference,'Tracking reference',120); const result=String(resultCode||'');
  if(!courier)throw new ValidationError('A courier must be selected.'); if(!['succeeded','failed'].includes(result))throw new ValidationError('Unsupported booking result.');
  const who=actorValues(actor);
  return mysql.withTransaction(async tx=>{const row=await lockSubOrder(tx,id,who); if(!row.delivery_mode)throw new ConflictError('Delivery ownership is unknown; an administrator must classify this sub-order first.'); if(who.vendorId&&row.delivery_mode!=='vendor_managed')throw new AuthorizationError('This shipment is not vendor-managed.'); if(!['ready_for_pickup','failed_delivery'].includes(row.status))throw new ConflictError('Only pickup-ready shipments can record a courier booking result.');
    const shipment=await latestShipment(tx,id); if(!shipment)throw new ConflictError('Shipment record is not available yet.');
    await tx.execute('UPDATE fulfillment_shipments SET courier_code=?,tracking_id=?,booking_status=? WHERE id=?',[courier,tracking||null,result,shipment.id]);
    await tx.execute("UPDATE vendor_sub_orders SET shipment_carrier=?,tracking_code=? WHERE id=?",[courier,tracking,id]);
    await insertShipmentEvent(tx,shipment.id,'booking_result',who,{courierCode:courier,trackingReference:tracking,resultCode:result,note:String(note||'').slice(0,255)});
    return{shipmentId:Number(shipment.id),bookingStatus:result,pickedUp:Boolean(shipment.picked_up_at)};
  });
}

async function recordPhysicalHandover({subOrderId,note='',actor={}}={}) {
  assertMysql(); const id=requirePositiveInt(subOrderId,'sub-order ID'); const who=actorValues(actor);
  return mysql.withTransaction(async tx=>{const row=await lockSubOrder(tx,id,who); if(!row.delivery_mode)throw new ConflictError('Delivery ownership is unknown; an administrator must classify this sub-order first.'); if(who.vendorId&&row.delivery_mode!=='vendor_managed')throw new AuthorizationError('Only the platform may confirm handover for platform-managed delivery.'); if(row.status!=='ready_for_pickup')throw new ConflictError('Only pickup-ready sub-orders can be handed over.');
    const shipment=await latestShipment(tx,id); if(!shipment||shipment.booking_status!=='succeeded')throw new ConflictError('A successful courier booking result is required before handover.'); if(shipment.picked_up_at)throw new ConflictError('Physical handover has already been recorded.');
    await tx.execute("UPDATE fulfillment_shipments SET status='in_transit',picked_up_at=UTC_TIMESTAMP() WHERE id=? AND picked_up_at IS NULL",[shipment.id]);
    await insertShipmentEvent(tx,shipment.id,'physical_handover',who,{courierCode:shipment.courier_code,trackingReference:shipment.tracking_id,note:String(note||'').slice(0,255)});
    await recordSubOrderStatus(tx,row,'in_transit',who,note);
    const parentStatus=await syncParentStatus(tx,row.order_id,row.parent_status,who.userId);
    return{shipmentId:Number(shipment.id),subOrderId:id,handedOver:true,parentStatus};
  });
}


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
  setDeliveryMode,
  recordBookingResult,
  recordPhysicalHandover,
  TRANSITIONS,
  STATUS_TIMESTAMP,
  DELIVERY_MODES,
  syncParentStatus,
  listVendorSubOrders,
  getVendorSubOrderDetail,
  vendorUpdateStatus,
};
