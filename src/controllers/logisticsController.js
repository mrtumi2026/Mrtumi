'use strict';

/**
 * Logistics & Courier Dispatch Controller
 * =======================================
 * Manages booking parcels across Steadfast and Pathao, tracking consignments,
 * and processing automated delivery webhook status callbacks.
 */

const steadfast = require('../services/couriers/steadfastService');
const pathao = require('../services/couriers/pathaoService');
const { updateVendorOrderStatus } = require('../services/splitOrderService');
const mysql = require('../db/mysqlPool');
const { ValidationError, NotFoundError, AuthorizationError } = require('../utils/errors');
const { logger } = require('../utils/logger');

/**
 * Single-click booking endpoint for Admin or Vendor.
 * POST /api/courier/book
 */
async function bookShipment(req, res, next) {
  try {
    const {
      vendor_order_id,
      courier_provider = 'steadfast',
      note = '',
      city_id,
      zone_id,
      area_id,
    } = req.body;

    const voId = Number(vendor_order_id);
    if (!Number.isSafeInteger(voId) || voId < 1) {
      throw new ValidationError('vendor_order_id is required.');
    }

    const pool = mysql.getPool();

    // 1. Fetch sub-order and parent order
    const [orders] = await pool.query(
      `SELECT vo.*, o.invoice_no, o.customer_name, o.customer_phone,
              o.shipping_address, o.district, o.payment_status, o.payment_method
       FROM vendor_orders vo
       JOIN orders o ON o.id = vo.order_id
       WHERE vo.id = ?`,
      [voId]
    );

    const order = orders && orders[0];
    if (!order) throw new NotFoundError(`Vendor order ${voId} not found.`);

    // 2. Multi-tenant security check if triggered from vendor panel
    if (req.session?.vendorUser && req.session.vendorUser.id) {
      const authVendorId = Number(req.session.vendorUser.id);
      if (Number(order.vendor_id) !== authVendorId) {
        throw new AuthorizationError('You do not have permission to ship this order.');
      }
    }

    // 3. Determine COD Collection Amount in paisa
    // If order is already paid online (payment_status='paid'), COD is 0
    let codPaisa = 0;
    if (order.payment_status !== 'paid') {
      codPaisa = Number(order.subtotal_paisa || 0);
    }

    let booking;

    if (courier_provider === 'steadfast') {
      booking = await steadfast.createOrder({
        invoice: `${order.sub_order_ref}`,
        recipientName: order.customer_name,
        recipientPhone: order.customer_phone,
        recipientAddress: `${order.shipping_address}, ${order.district}`,
        codAmountPaisa: codPaisa,
        note: note || `Order ${order.sub_order_ref}`,
      });
    } else if (courier_provider === 'pathao') {
      booking = await pathao.createOrder({
        merchantOrderId: order.sub_order_ref,
        recipientName: order.customer_name,
        recipientPhone: order.customer_phone,
        recipientAddress: order.shipping_address,
        recipientCityId: city_id || 1,
        recipientZoneId: zone_id || 1,
        recipientAreaId: area_id || null,
        amountToCollectPaisa: codPaisa,
        itemQuantity: 1,
        specialInstruction: note,
      });
    } else {
      throw new ValidationError(`Unsupported courier provider: ${courier_provider}`);
    }

    // 4. Save record in courier_shipments
    const [ins] = await pool.query(
      `INSERT INTO courier_shipments
         (order_id, vendor_order_id, courier_provider, consignment_id, tracking_code,
          status, cod_amount_paisa, recipient_name, recipient_phone, recipient_address,
          recipient_district, raw_response, dispatched_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'in_transit', ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        order.order_id,
        voId,
        courier_provider,
        booking.consignmentId,
        booking.trackingCode,
        codPaisa,
        order.customer_name,
        order.customer_phone,
        order.shipping_address,
        order.district || '',
        JSON.stringify(booking.raw),
      ]
    );

    // 5. Transition sub-order status to 'shipped'
    await updateVendorOrderStatus(voId, 'shipped', {
      actor: { type: req.session?.adminUser ? 'admin' : 'vendor', id: req.session?.adminUser?.id || req.session?.vendorUser?.id },
      courierCode: courier_provider,
      trackingId: booking.trackingCode,
      reason: 'Parcel booked with courier',
    });

    return res.json({
      success: true,
      shipmentId: Number(ins.insertId),
      consignmentId: booking.consignmentId,
      trackingCode: booking.trackingCode,
      courierProvider: courier_provider,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Steadfast Webhook Listener
 * POST /api/courier/webhook/steadfast
 */
async function steadfastWebhook(req, res) {
  try {
    const { consignment_id, status, tracking_code } = req.body;
    if (!consignment_id) return res.status(400).json({ error: 'Missing consignment_id' });

    const pool = mysql.getPool();
    const [shipments] = await pool.query(
      'SELECT id, vendor_order_id, status FROM courier_shipments WHERE consignment_id = ? LIMIT 1',
      [String(consignment_id)]
    );

    const shipment = shipments && shipments[0];
    if (!shipment) {
      logger.warn({ event: 'steadfast_webhook_unknown_consignment', consignment_id });
      return res.status(200).json({ received: true });
    }

    // Map Steadfast status to internal lifecycle status
    const normalized = String(status || '').toLowerCase().trim();

    await pool.query(
      'UPDATE courier_shipments SET status = ?, raw_webhook = ?, updated_at = NOW() WHERE id = ?',
      [normalized, JSON.stringify(req.body), shipment.id]
    );

    if (shipment.vendor_order_id) {
      if (normalized === 'delivered') {
        await updateVendorOrderStatus(shipment.vendor_order_id, 'delivered', {
          actor: { type: 'courier_webhook', id: null },
          trackingId: tracking_code || String(consignment_id),
          reason: 'Automated delivery confirmation from Steadfast Courier',
        });
      } else if (normalized === 'cancelled') {
        await updateVendorOrderStatus(shipment.vendor_order_id, 'cancelled', {
          actor: { type: 'courier_webhook', id: null },
          reason: 'Delivery cancelled/refused at doorstep',
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error({ event: 'steadfast_webhook_error', error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Pathao Webhook Listener
 * POST /api/courier/webhook/pathao
 */
async function pathaoWebhook(req, res) {
  try {
    const { consignment_id, order_status } = req.body;
    if (!consignment_id) return res.status(400).json({ error: 'Missing consignment_id' });

    const pool = mysql.getPool();
    const [shipments] = await pool.query(
      'SELECT id, vendor_order_id FROM courier_shipments WHERE consignment_id = ? LIMIT 1',
      [String(consignment_id)]
    );

    const shipment = shipments && shipments[0];
    if (!shipment) return res.status(200).json({ received: true });

    const normalized = String(order_status || '').toLowerCase();

    await pool.query(
      'UPDATE courier_shipments SET status = ?, raw_webhook = ?, updated_at = NOW() WHERE id = ?',
      [normalized, JSON.stringify(req.body), shipment.id]
    );

    if (shipment.vendor_order_id) {
      if (normalized === 'delivered' || normalized === 'successful') {
        await updateVendorOrderStatus(shipment.vendor_order_id, 'delivered', {
          actor: { type: 'courier_webhook', id: null },
          reason: 'Automated delivery confirmation from Pathao Courier',
        });
      } else if (normalized === 'return' || normalized === 'cancelled') {
        await updateVendorOrderStatus(shipment.vendor_order_id, 'cancelled', {
          actor: { type: 'courier_webhook', id: null },
          reason: 'Pathao parcel returned',
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error({ event: 'pathao_webhook_error', error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  bookShipment,
  steadfastWebhook,
  pathaoWebhook,
};
