'use strict';

const { env } = require('../config/env');
const { getPool } = require('../db/mysqlPool');
const { AppError, NotFoundError, ValidationError, AuthorizationError } = require('../utils/errors');
const CourierProviderFactory = require('../services/courier/CourierProviderFactory');
const CourierRecommendationEngine = require('../services/courier/CourierRecommendationEngine');

function assertMysql() {
  if (env.db.client !== 'mysql') {
    throw new Error('Multi-courier integration requires MySQL runtime.');
  }
}

async function withTransaction(fn) {
  assertMysql();
  const pool = getPool();
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  const tx = {
    query: (sql, params) => conn.query(sql, params).then(([rows]) => rows),
    queryOne: (sql, params) => conn.query(sql, params).then(([rows]) => rows[0] || null),
    execute: (sql, params) => conn.execute(sql, params).then(([res]) => res)
  };

  try {
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Validates actor permissions for a suborder.
 */
function assertActorAccess(subOrder, actor) {
  if (!actor || (!actor.userId && !actor.vendorId)) {
    throw new AuthorizationError('Authorized fulfillment actor required.');
  }
  if (actor.vendorId && Number(subOrder.vendor_id) !== Number(actor.vendorId)) {
    throw new NotFoundError('Vendor sub-order not found.');
  }
}

/**
 * Retrieve active courier providers from courier_apis.
 */
async function getActiveProviders(tx) {
  return tx.query(
    `SELECT id, name, code, provider_type, base_url, api_key, secret_key, client_id, sandbox, supports_live_quotes, service_options_json
     FROM courier_apis
     WHERE status = 1
     ORDER BY id ASC`
  );
}

/**
 * Fetch comparison quotes and recommendation for a suborder shipment.
 */
async function getShipmentQuotesAndRecommendation({ subOrderId, actor }) {
  assertMysql();
  const pool = getPool();
  const conn = await pool.getConnection();
  const client = {
    query: (sql, params) => conn.query(sql, params).then(([rows]) => rows),
    queryOne: (sql, params) => conn.query(sql, params).then(([rows]) => rows[0] || null)
  };

  try {
    const subOrder = await client.queryOne(
      `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, vso.delivery_mode,
              o.invoice_id, o.name AS customer_name, o.phone, o.address, o.shipping_area,
              o.payment_method, o.payment_status,
              fs.id AS shipment_id, fs.tracking_id, fs.courier_code, fs.booking_status, fs.cod_due_paisa, fs.picked_up_at
       FROM vendor_sub_orders vso
       JOIN orders o ON o.id = vso.order_id
       LEFT JOIN fulfillment_shipments fs ON fs.vendor_sub_order_id = vso.id
       WHERE vso.id = ?`,
      [subOrderId]
    );

    if (!subOrder) throw new NotFoundError('Vendor sub-order not found.');
    assertActorAccess(subOrder, actor);

    const items = await client.query(
      `SELECT soi.product_name, soi.quantity, p.weight_grams
       FROM vendor_sub_order_items soi
       LEFT JOIN products p ON p.id = soi.product_id
       WHERE soi.sub_order_id = ?`,
      [subOrderId]
    );

    // Calculate total parcel weight
    let totalWeightGrams = 0;
    for (const it of items) {
      totalWeightGrams += (Number(it.weight_grams || 500) * Number(it.quantity || 1));
    }
    if (totalWeightGrams <= 0) totalWeightGrams = 1000;

    const providers = await getActiveProviders(client);
    if (providers.length === 0) {
      return {
        subOrderId,
        status: subOrder.status,
        bookingStatus: subOrder.booking_status,
        destination: subOrder.shipping_area || subOrder.address,
        weightGrams: totalWeightGrams,
        quotes: [],
        recommendation: null,
        reasonBn: 'কোন সক্রিয় কুরিয়ার সার্ভিস ডাটাবেজে কনফিগার করা নেই।',
        reasonEn: 'No active courier providers configured in platform settings.',
        alternatives: [],
        unserviceable: []
      };
    }

    const isCod = String(subOrder.payment_method || '').toLowerCase().includes('cod') ||
                  String(subOrder.payment_status || '').toLowerCase() !== 'paid';

    const shipmentContext = {
      origin: { city: 'Dhaka', district: 'Dhaka' },
      destination: {
        district: subOrder.shipping_area || 'Dhaka',
        city: subOrder.shipping_area || 'Dhaka',
        address: subOrder.address
      },
      weightGrams: totalWeightGrams,
      codAmountPaisa: isCod ? Number(subOrder.cod_due_paisa || 0) : 0
    };

    // Query quotes concurrently across all active provider adapters
    const quotePromises = providers.map(async (providerConfig) => {
      try {
        const adapter = CourierProviderFactory.createAdapter(providerConfig);
        return await adapter.getQuote(shipmentContext);
      } catch (err) {
        return {
          providerCode: providerConfig.code,
          providerName: providerConfig.name,
          available: false,
          chargePaisa: 0,
          codFeePaisa: 0,
          estimatedDaysMin: 0,
          estimatedDaysMax: 0,
          isLiveQuote: false,
          serviceType: 'standard',
          reasonUnavailable: err.message,
          notes: 'Quote request failed'
        };
      }
    });

    const quotes = await Promise.all(quotePromises);
    const evaluation = CourierRecommendationEngine.evaluateQuotes(quotes, {
      isCod,
      weightGrams: totalWeightGrams,
      destination: shipmentContext.destination
    });

    return {
      subOrderId,
      invoiceId: subOrder.invoice_id,
      customerName: subOrder.customer_name,
      phone: subOrder.phone,
      address: subOrder.address,
      destinationArea: subOrder.shipping_area,
      status: subOrder.status,
      deliveryMode: subOrder.delivery_mode,
      bookingStatus: subOrder.booking_status,
      existingCourier: subOrder.courier_code,
      existingTracking: subOrder.tracking_id,
      weightGrams: totalWeightGrams,
      isCod,
      codDuePaisa: subOrder.cod_due_paisa,
      quotes,
      recommendation: evaluation.recommendedQuote,
      reasonBn: evaluation.reasonBn,
      reasonEn: evaluation.reasonEn,
      alternatives: evaluation.alternatives,
      unserviceable: evaluation.unserviceable
    };
  } finally {
    conn.release();
  }
}

/**
 * Executes one-click booking with chosen or recommended courier provider.
 */
async function executeOneClickBooking({ subOrderId, courierCode, actor, idempotencyKey, note = '' }) {
  return withTransaction(async (tx) => {
    // Lock suborder and shipment FOR UPDATE
    const subOrder = await tx.queryOne(
      `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, vso.delivery_mode,
              o.invoice_id, o.name AS customer_name, o.phone, o.address, o.shipping_area,
              o.payment_method, o.payment_status
       FROM vendor_sub_orders vso
       JOIN orders o ON o.id = vso.order_id
       WHERE vso.id = ? FOR UPDATE`,
      [subOrderId]
    );

    if (!subOrder) throw new NotFoundError('Vendor sub-order not found.');
    assertActorAccess(subOrder, actor);

    // Delivery mode permission check
    if (actor.vendorId && subOrder.delivery_mode === 'platform_managed') {
      throw new AuthorizationError('This shipment is platform-managed. Super Admin will book the courier.');
    }

    // Must be prepared / ready for pickup
    if (!['ready_for_pickup', 'packed', 'processing'].includes(subOrder.status)) {
      throw new ValidationError(`Sub-order in '${subOrder.status}' status cannot be booked with courier. Must be ready for pickup.`);
    }

    // Ensure shipment row exists
    let shipment = await tx.queryOne(
      `SELECT * FROM fulfillment_shipments WHERE vendor_sub_order_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [subOrderId]
    );

    if (!shipment) {
      const res = await tx.execute(
        `INSERT INTO fulfillment_shipments (vendor_sub_order_id, status, cod_due_paisa, created_at, updated_at)
         VALUES (?, 'ready_for_pickup', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [subOrderId]
      );
      shipment = await tx.queryOne(`SELECT * FROM fulfillment_shipments WHERE id = ? FOR UPDATE`, [res.insertId]);
    }

    // Ambiguous state or already booked: Block new booking attempt (Priority 1)
    if (['succeeded', 'unknown_timeout', 'in_review'].includes(shipment.booking_status)) {
      if (shipment.booking_status === 'succeeded' && shipment.tracking_id) {
        if (idempotencyKey && shipment.booking_idempotency_key === idempotencyKey) {
          return {
            idempotentReplay: true,
            success: true,
            trackingId: shipment.tracking_id,
            courierCode: shipment.courier_code,
            message: 'Booking already completed with this idempotency key.'
          };
        }
        throw new ValidationError(`Shipment is already booked with courier '${shipment.courier_code}' (Tracking: ${shipment.tracking_id}).`);
      }
      throw new ValidationError(
        `Shipment booking is in an ambiguous state ('${shipment.booking_status}'). You must reconcile the courier status before attempting to re-book.`
      );
    }

    // Resolve courier provider configuration
    const targetCode = String(courierCode || '').trim().toLowerCase();
    const providerConfig = await tx.queryOne(
      `SELECT * FROM courier_apis WHERE (LOWER(code) = ? OR LOWER(provider_type) = ?) AND status = 1 LIMIT 1`,
      [targetCode, targetCode]
    );

    if (!providerConfig) {
      throw new NotFoundError(`Active courier provider '${courierCode}' not found.`);
    }

    const adapter = CourierProviderFactory.createAdapter(providerConfig);

    // Collect recipient and parcel data
    const isCod = String(subOrder.payment_method || '').toLowerCase().includes('cod') ||
                  String(subOrder.payment_status || '').toLowerCase() !== 'paid';

    const bookingPayload = {
      shipmentId: shipment.id,
      subOrderId: subOrder.id,
      invoiceNo: `${subOrder.invoice_id}-${subOrder.id}`,
      recipient: {
        name: subOrder.customer_name,
        phone: subOrder.phone,
        address: subOrder.address,
        district: subOrder.shipping_area || 'Dhaka',
        note: note || `Order #${subOrder.invoice_id}`
      },
      parcel: {
        weightGrams: 1000
      },
      codAmountPaisa: isCod ? Number(shipment.cod_due_paisa || 0) : 0,
      idempotencyKey: idempotencyKey || `book-${subOrderId}-${Date.now()}`
    };

    // Execute booking via provider adapter
    const bookingResult = await adapter.bookShipment(bookingPayload);

    const actorType = actor.vendorId ? 'vendor' : 'admin';
    const actorVendorId = actor.vendorId || null;
    const actorUserId = actor.userId || null;

    if (bookingResult.success) {
      // Record successful booking
      await tx.execute(
        `UPDATE fulfillment_shipments
         SET courier_code = ?,
             tracking_id = ?,
             external_consignment_id = ?,
             booking_status = 'succeeded',
             booking_idempotency_key = ?,
             booking_response_json = ?,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          providerConfig.code,
          bookingResult.trackingId,
          bookingResult.consignmentId || bookingResult.trackingId,
          bookingPayload.idempotencyKey,
          JSON.stringify(bookingResult.rawResponse || {}),
          shipment.id
        ]
      );

      // Audit event
      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'courier_booking', ?, ?, ?, ?, ?, 'succeeded', ?, UTC_TIMESTAMP())`,
        [
          shipment.id,
          actorType,
          actorVendorId,
          actorUserId,
          providerConfig.code,
          bookingResult.trackingId,
          note || `One-click booked with ${providerConfig.name}`
        ]
      );

      // NOTE: We deliberately DO NOT set picked_up_at or change suborder status to in_transit!
      // Physical handover remains a separate operational step per Phase B contract.

      return {
        success: true,
        trackingId: bookingResult.trackingId,
        consignmentId: bookingResult.consignmentId,
        courierCode: providerConfig.code,
        courierName: providerConfig.name
      };
    } else {
      const isTimeout = Boolean(bookingResult.isTimeout || bookingResult.isUnknownOutcome);
      const failStatus = isTimeout ? 'unknown_timeout' : 'failed';
      const eventResultCode = isTimeout ? 'timeout' : 'failed';

      // Record failed or unknown-timeout booking event
      await tx.execute(
        `UPDATE fulfillment_shipments
         SET booking_status = ?,
             booking_response_json = ?,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          failStatus,
          JSON.stringify(bookingResult.rawResponse || { error: bookingResult.error, isTimeout }),
          shipment.id
        ]
      );

      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'courier_booking', ?, ?, ?, ?, '', ?, ?, UTC_TIMESTAMP())`,
        [
          shipment.id,
          actorType,
          actorVendorId,
          actorUserId,
          providerConfig.code,
          eventResultCode,
          bookingResult.error || (isTimeout ? 'Courier request timed out' : 'Courier booking rejected')
        ]
      );

      throw new AppError(
        isTimeout ? 'COURIER_BOOKING_TIMEOUT' : 'COURIER_BOOKING_FAILED',
        bookingResult.error || 'Courier provider rejected booking.',
        isTimeout ? 504 : 422
      );
    }
  });
}

/**
 * Reconciles an ambiguous or timed-out booking before allowing retry,
 * preventing accidental duplicate parcel creation.
 */
async function reconcileBookingResult({ subOrderId, actor }) {
  return withTransaction(async (tx) => {
    const subOrder = await tx.queryOne(
      `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, o.invoice_id,
              fs.id AS shipment_id, fs.courier_code, fs.tracking_id, fs.booking_status, fs.external_consignment_id
       FROM vendor_sub_orders vso
       JOIN orders o ON o.id = vso.order_id
       LEFT JOIN fulfillment_shipments fs ON fs.vendor_sub_order_id = vso.id
       WHERE vso.id = ? FOR UPDATE`,
      [subOrderId]
    );

    if (!subOrder) throw new NotFoundError('Vendor sub-order not found.');
    assertActorAccess(subOrder, actor);

    if (!subOrder.shipment_id) {
      throw new ValidationError('No shipment record found to reconcile.');
    }

    if (subOrder.booking_status === 'succeeded' && subOrder.tracking_id) {
      return {
        reconciled: true,
        bookingStatus: 'succeeded',
        trackingId: subOrder.tracking_id,
        message: 'Booking is already confirmed and active.'
      };
    }

    const providerConfig = await tx.queryOne(
      `SELECT * FROM courier_apis WHERE LOWER(code) = ? LIMIT 1`,
      [String(subOrder.courier_code || '').toLowerCase()]
    );

    const adapter = CourierProviderFactory.createAdapter(providerConfig || { code: subOrder.courier_code });
    const invoiceNo = `${subOrder.invoice_id}-${subOrder.id}`;
    const recResult = await adapter.reconcileBooking({
      invoiceNo,
      consignmentId: subOrder.external_consignment_id,
      trackingId: subOrder.tracking_id
    });

    const actorType = actor.vendorId ? 'vendor' : 'admin';
    const actorVendorId = actor.vendorId || null;
    const actorUserId = actor.userId || null;

    if (recResult.outcome === 'found' && recResult.trackingId) {
      // 1. Recovered confirmed booking from carrier
      await tx.execute(
        `UPDATE fulfillment_shipments
         SET booking_status = 'succeeded',
             tracking_id = ?,
             external_consignment_id = ?,
             booking_response_json = ?,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          recResult.trackingId,
          recResult.consignmentId || recResult.trackingId,
          JSON.stringify(recResult.rawResponse || { recovered: true }),
          subOrder.shipment_id
        ]
      );

      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'booking_reconciled', ?, ?, ?, ?, ?, 'succeeded', 'Recovered booking reference from carrier reconciliation', UTC_TIMESTAMP())`,
        [subOrder.shipment_id, actorType, actorVendorId, actorUserId, subOrder.courier_code, recResult.trackingId]
      );

      return {
        reconciled: true,
        outcome: 'found',
        bookingStatus: 'succeeded',
        trackingId: recResult.trackingId,
        message: 'Carrier confirmed parcel was created. Tracking reference recovered successfully.'
      };
    } else if (recResult.outcome === 'confirmed_absent') {
      // 2. Carrier explicitly and unambiguously confirmed no parcel exists; safe to retry fresh booking
      await tx.execute(
        `UPDATE fulfillment_shipments
         SET booking_status = 'failed',
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [subOrder.shipment_id]
      );

      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'booking_reconciled', ?, ?, ?, ?, '', 'failed', 'Carrier confirmed no parcel exists; cleared for safe retry', UTC_TIMESTAMP())`,
        [subOrder.shipment_id, actorType, actorVendorId, actorUserId, subOrder.courier_code || '']
      );

      return {
        reconciled: true,
        outcome: 'confirmed_absent',
        bookingStatus: 'failed',
        message: 'Carrier confirmed no parcel was created. Cleared for safe retry.'
      };
    } else {
      // 3. Inconclusive (unknown_error, network failure, missing keys, or unverified absence):
      // Retry remains strictly BLOCKED to prevent duplicate parcel creation.
      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'booking_reconciled', ?, ?, ?, ?, '', 'unknown_error', ?, UTC_TIMESTAMP())`,
        [
          subOrder.shipment_id,
          actorType,
          actorVendorId,
          actorUserId,
          subOrder.courier_code || '',
          recResult.error || 'Reconciliation outcome is inconclusive; parcel absence not verified'
        ]
      );

      return {
        reconciled: false,
        outcome: 'unknown_error',
        bookingStatus: subOrder.booking_status,
        message: recResult.error || 'Carrier reconciliation inconclusive. Absence could not be confirmed; re-booking remains blocked.'
      };
    }
  });
}

/**
 * Synchronize tracking status from courier provider.
 */
async function syncShipmentTracking({ subOrderId, actor }) {
  return withTransaction(async (tx) => {
    const subOrder = await tx.queryOne(
      `SELECT vso.id, vso.vendor_id, vso.status, fs.id AS shipment_id, fs.courier_code, fs.tracking_id, fs.picked_up_at
       FROM vendor_sub_orders vso
       JOIN fulfillment_shipments fs ON fs.vendor_sub_order_id = vso.id
       WHERE vso.id = ? FOR UPDATE`,
      [subOrderId]
    );

    if (!subOrder) throw new NotFoundError('Vendor sub-order not found.');
    assertActorAccess(subOrder, actor);

    if (!subOrder.courier_code || !subOrder.tracking_id) {
      throw new ValidationError('Shipment has not been booked with any courier yet.');
    }

    const providerConfig = await tx.queryOne(
      `SELECT * FROM courier_apis WHERE LOWER(code) = ? LIMIT 1`,
      [String(subOrder.courier_code).toLowerCase()]
    );

    const adapter = CourierProviderFactory.createAdapter(providerConfig || { code: subOrder.courier_code });
    const trackingData = await adapter.trackShipment(subOrder.tracking_id);

    const actorType = actor.vendorId ? 'vendor' : 'admin';

    // If courier indicates transit and picked_up_at was not recorded yet
    if (['in_transit', 'delivered'].includes(trackingData.normalizedStatus) && !subOrder.picked_up_at) {
      await tx.execute(
        `UPDATE fulfillment_shipments SET picked_up_at = UTC_TIMESTAMP(), status = 'in_transit' WHERE id = ?`,
        [subOrder.shipment_id]
      );
      await tx.execute(
        `UPDATE vendor_sub_orders SET status = 'in_transit' WHERE id = ? AND status = 'ready_for_pickup'`,
        [subOrder.id]
      );
      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'status_sync', ?, ?, ?, ?, ?, ?, 'Carrier confirmed package in transit', UTC_TIMESTAMP())`,
        [subOrder.shipment_id, actorType, actor.vendorId || null, actor.userId || null, subOrder.courier_code, subOrder.tracking_id, trackingData.normalizedStatus]
      );
    }

    // If delivered
    if (trackingData.normalizedStatus === 'delivered') {
      await tx.execute(
        `UPDATE fulfillment_shipments SET delivered_at = UTC_TIMESTAMP(), status = 'delivered' WHERE id = ?`,
        [subOrder.shipment_id]
      );
      await tx.execute(
        `UPDATE vendor_sub_orders SET status = 'delivered' WHERE id = ? AND status IN ('ready_for_pickup', 'in_transit')`,
        [subOrder.id]
      );
    }

    return trackingData;
  });
}

module.exports = {
  getShipmentQuotesAndRecommendation,
  executeOneClickBooking,
  reconcileBookingResult,
  syncShipmentTracking
};
