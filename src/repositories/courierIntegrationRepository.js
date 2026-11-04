'use strict';

const { env } = require('../config/env');
const { getPool } = require('../db/mysqlPool');
const { AppError, NotFoundError, ValidationError, AuthorizationError } = require('../utils/errors');
const CourierBaseAdapter = require('../services/courier/CourierBaseAdapter');
const CourierProviderFactory = require('../services/courier/CourierProviderFactory');
const CourierRecommendationEngine = require('../services/courier/CourierRecommendationEngine');

function assertMysql() {
  const isMysql = env.db.client === 'mysql' || process.env.DB_CLIENT === 'mysql' || Boolean(process.env.MYSQL_TEST_HOST);
  if (!isMysql) {
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
              o.invoice_no AS invoice_id, o.customer_name, o.customer_phone AS phone, o.shipping_address AS address, o.shipping_zone AS shipping_area,
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
  let postCommitError = null;
  const result = await withTransaction(async (tx) => {
    // Lock suborder and shipment FOR UPDATE
    const subOrder = await tx.queryOne(
      `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, vso.delivery_mode,
              o.invoice_no AS invoice_id, o.customer_name, o.customer_phone AS phone, o.shipping_address AS address, o.shipping_zone AS shipping_area,
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
          JSON.stringify(CourierBaseAdapter.sanitize(bookingResult.rawResponse || {})),
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

      // Keep vendor_sub_orders and orders synchronized with courier and tracking details
      await tx.execute(
        `UPDATE vendor_sub_orders SET shipment_carrier = ?, tracking_code = ? WHERE id = ?`,
        [providerConfig.code, bookingResult.trackingId, subOrder.id]
      );
      if (subOrder.order_id) {
        await tx.execute(
          `UPDATE orders
           SET courier_name = CASE WHEN courier_name = '' OR courier_name IS NULL THEN ? ELSE courier_name END,
               courier_tracking_id = CASE WHEN courier_tracking_id = '' OR courier_tracking_id IS NULL THEN ? ELSE courier_tracking_id END
           WHERE id = ?`,
          [providerConfig.name || providerConfig.code, bookingResult.trackingId, subOrder.order_id]
        );
      }

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
         SET courier_code = ?,
             booking_status = ?,
             booking_response_json = ?,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          providerConfig.code,
          failStatus,
          JSON.stringify(CourierBaseAdapter.sanitize(bookingResult.rawResponse || { error: bookingResult.error, isTimeout })),
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

      postCommitError = new AppError(
        isTimeout ? 'COURIER_BOOKING_TIMEOUT' : 'COURIER_BOOKING_FAILED',
        bookingResult.error || 'Courier provider rejected booking.',
        isTimeout ? 504 : 422
      );
      return null;
    }
  });

  if (postCommitError) {
    throw postCommitError;
  }
  return result;
}

/**
 * Reconciles an ambiguous or timed-out booking before allowing retry,
 * preventing accidental duplicate parcel creation.
 */
async function reconcileBookingResult({ subOrderId, actor }) {
  return withTransaction(async (tx) => {
    const subOrder = await tx.queryOne(
      `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, o.invoice_no AS invoice_id,
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
          JSON.stringify(CourierBaseAdapter.sanitize(recResult.rawResponse || { recovered: true })),
          subOrder.shipment_id
        ]
      );

      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'booking_reconciled', ?, ?, ?, ?, ?, 'succeeded', 'Recovered booking reference from carrier reconciliation', UTC_TIMESTAMP())`,
        [subOrder.shipment_id, actorType, actorVendorId, actorUserId, subOrder.courier_code, recResult.trackingId]
      );

      await tx.execute(
        `UPDATE vendor_sub_orders SET shipment_carrier = ?, tracking_code = ? WHERE id = ?`,
        [subOrder.courier_code, recResult.trackingId, subOrder.id]
      );
      if (subOrder.order_id) {
        await tx.execute(
          `UPDATE orders
           SET courier_name = CASE WHEN courier_name = '' OR courier_name IS NULL THEN ? ELSE courier_name END,
               courier_tracking_id = CASE WHEN courier_tracking_id = '' OR courier_tracking_id IS NULL THEN ? ELSE courier_tracking_id END
           WHERE id = ?`,
          [subOrder.courier_code, recResult.trackingId, subOrder.order_id]
        );
      }

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
      `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, o.order_status AS parent_status,
              fs.id AS shipment_id, fs.courier_code, fs.tracking_id, fs.picked_up_at
       FROM vendor_sub_orders vso
       JOIN orders o ON o.id = vso.order_id
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
      if (subOrder.order_id) {
        await require('./vendorOrderRepository').syncParentStatus(tx, subOrder.order_id, subOrder.parent_status, actor.userId || null);
      }
    }

    return trackingData;
  });
}

/**
 * Comprehensive ambiguous shipment monitoring and reporting query.
 * Filters by age, provider, vendor, status, and keyword with pagination & vendor isolation checks.
 */
async function listAmbiguousShipments({
  olderThanMinutes = 0,
  courierCode = null,
  vendorId = null,
  status = null,
  search = null,
  page = 1,
  limit = 20,
  actor = null,
  pool = null
} = {}) {
  assertMysql();
  const p = pool || getPool();

  // Vendor isolation guard: Vendors can ONLY see their own shipments
  let effectiveVendorId = vendorId ? Number(vendorId) : null;
  if (actor?.vendorId) {
    effectiveVendorId = Number(actor.vendorId);
  }

  const whereConditions = [];
  const params = [];

  // Filter booking statuses
  if (status === 'all') {
    // No booking_status condition: view all shipments
  } else if (status && ['unknown_timeout', 'in_review', 'failed', 'succeeded'].includes(status)) {
    whereConditions.push('fs.booking_status = ?');
    params.push(status);
  } else {
    whereConditions.push("fs.booking_status IN ('unknown_timeout', 'in_review')");
  }

  // Filter age
  if (Number(olderThanMinutes) > 0) {
    whereConditions.push('TIMESTAMPDIFF(MINUTE, fs.updated_at, UTC_TIMESTAMP()) >= ?');
    params.push(Number(olderThanMinutes));
  }

  // Filter courier code
  if (courierCode && String(courierCode).trim()) {
    whereConditions.push('LOWER(fs.courier_code) = LOWER(?)');
    params.push(String(courierCode).trim());
  }

  // Filter vendor
  if (effectiveVendorId) {
    whereConditions.push('vso.vendor_id = ?');
    params.push(effectiveVendorId);
  }

  // Search keyword (invoice, customer name, phone, vendor order no)
  if (search && String(search).trim()) {
    const s = `%${String(search).trim()}%`;
    whereConditions.push('(o.invoice_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR vso.vendor_order_no LIKE ?)');
    params.push(s, s, s, s);
  }

  const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Count total matching
  const [countRows] = await p.query(
    `SELECT COUNT(*) AS total
     FROM fulfillment_shipments fs
     JOIN vendor_sub_orders vso ON vso.id = fs.vendor_sub_order_id
     JOIN orders o ON o.id = vso.order_id
     ${whereSql}`,
    params
  );
  const total = Number(countRows[0]?.total || 0);

  // Pagination calculation
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const offset = (safePage - 1) * safeLimit;
  const totalPages = Math.ceil(total / safeLimit) || 1;

  // Query paginated items
  const queryParams = [...params, safeLimit, offset];
  const [rows] = await p.query(
    `SELECT fs.id AS shipment_id,
            fs.vendor_sub_order_id,
            fs.courier_code,
            fs.tracking_id,
            fs.booking_status,
            fs.booking_idempotency_key,
            fs.quoted_charge_paisa,
            fs.created_at,
            fs.updated_at,
            TIMESTAMPDIFF(MINUTE, fs.updated_at, UTC_TIMESTAMP()) AS age_minutes,
            vso.vendor_id,
            vso.vendor_order_no,
            vso.delivery_mode,
            v.shop_name AS vendor_shop_name,
            v.owner_name AS vendor_owner_name,
            v.phone AS vendor_phone,
            o.id AS order_id,
            o.invoice_no,
            o.customer_name,
            o.customer_phone,
            o.shipping_address,
            o.shipping_zone,
            COALESCE(rec.reconciliation_count, 0) AS reconciliation_attempts,
            rec.last_reconciled_at
     FROM fulfillment_shipments fs
     JOIN vendor_sub_orders vso ON vso.id = fs.vendor_sub_order_id
     JOIN orders o ON o.id = vso.order_id
     LEFT JOIN vendors v ON v.id = vso.vendor_id
     LEFT JOIN (
       SELECT shipment_id,
              COUNT(*) AS reconciliation_count,
              MAX(created_at) AS last_reconciled_at
       FROM fulfillment_shipment_events
       WHERE event_type = 'booking_reconciled'
       GROUP BY shipment_id
     ) rec ON rec.shipment_id = fs.id
     ${whereSql}
     ORDER BY fs.updated_at ASC
     LIMIT ? OFFSET ?`,
    queryParams
  );

  return {
    shipments: rows.map(r => ({
      ...r,
      age_minutes: Number(r.age_minutes || 0),
      reconciliation_attempts: Number(r.reconciliation_attempts || 0),
      is_stalled: Number(r.age_minutes || 0) >= 30
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages
    },
    summary: (await p.query(
      `SELECT
         COUNT(CASE WHEN fs.booking_status IN ('unknown_timeout', 'in_review') THEN 1 END) AS ambiguous_count,
         COUNT(CASE WHEN fs.booking_status IN ('unknown_timeout', 'in_review') AND TIMESTAMPDIFF(MINUTE, fs.updated_at, UTC_TIMESTAMP()) >= 60 THEN 1 END) AS stalled_count,
         COUNT(CASE WHEN fs.booking_status = 'failed' THEN 1 END) AS failed_count,
         COUNT(CASE WHEN fs.booking_status = 'succeeded' THEN 1 END) AS succeeded_count,
         COUNT(CASE WHEN fs.status = 'in_transit' THEN 1 END) AS in_transit_count,
         COUNT(CASE WHEN fs.status = 'delivered' THEN 1 END) AS delivered_count
       FROM fulfillment_shipments fs
       JOIN vendor_sub_orders vso ON vso.id = fs.vendor_sub_order_id
       ${effectiveVendorId ? 'WHERE vso.vendor_id = ?' : ''}`,
      effectiveVendorId ? [effectiveVendorId] : []
    ))[0]?.[0] || {}
  };
}

/**
 * Detailed audit trail and history for an individual shipment.
 * Returns shipment record, provider recommendation/response snapshots, and chronological event trail.
 */
async function getShipmentAuditTrail({ shipmentId, subOrderId, actor, pool = null } = {}) {
  assertMysql();
  const p = pool || getPool();

  let shipmentQuery = 'SELECT fs.*, vso.id AS vso_id, vso.order_id, vso.vendor_id, vso.vendor_order_no, vso.delivery_mode, o.invoice_no, o.customer_name, o.customer_phone, v.shop_name AS vendor_shop_name FROM fulfillment_shipments fs JOIN vendor_sub_orders vso ON vso.id = fs.vendor_sub_order_id JOIN orders o ON o.id = vso.order_id LEFT JOIN vendors v ON v.id = vso.vendor_id ';
  let shipmentParam = null;

  if (shipmentId) {
    shipmentQuery += 'WHERE fs.id = ? LIMIT 1';
    shipmentParam = shipmentId;
  } else if (subOrderId) {
    shipmentQuery += 'WHERE fs.vendor_sub_order_id = ? ORDER BY fs.id DESC LIMIT 1';
    shipmentParam = subOrderId;
  } else {
    throw new ValidationError('Either shipmentId or subOrderId must be provided.');
  }

  const [shipmentRows] = await p.query(shipmentQuery, [shipmentParam]);
  const shipment = shipmentRows[0] || null;
  if (!shipment) {
    throw new NotFoundError('Shipment not found.');
  }

  // Vendor isolation check
  if (actor?.vendorId && Number(shipment.vendor_id) !== Number(actor.vendorId)) {
    throw new AuthorizationError('You do not have permission to view audit history for this shipment.');
  }

  // Fetch full event history
  const [events] = await p.query(
    `SELECT fse.id, fse.shipment_id, fse.event_type, fse.actor_type, fse.vendor_id, fse.user_id,
            fse.courier_code, fse.tracking_reference, fse.result_code, fse.note, fse.created_at,
            u.name AS user_name, u.email AS user_email
     FROM fulfillment_shipment_events fse
     LEFT JOIN users u ON u.id = fse.user_id
     WHERE fse.shipment_id = ?
     ORDER BY fse.id ASC`,
    [shipment.id]
  );

  let parsedBookingResponse = null;
  if (shipment.booking_response_json) {
    try {
      parsedBookingResponse = JSON.parse(shipment.booking_response_json);
    } catch {
      parsedBookingResponse = shipment.booking_response_json;
    }
  }

  let parsedRecommendation = null;
  if (shipment.recommendation_snapshot_json) {
    try {
      parsedRecommendation = JSON.parse(shipment.recommendation_snapshot_json);
    } catch {
      parsedRecommendation = shipment.recommendation_snapshot_json;
    }
  }

  return {
    shipment: {
      id: shipment.id,
      vendorSubOrderId: shipment.vendor_sub_order_id,
      vendorId: shipment.vendor_id,
      vendorShopName: shipment.vendor_shop_name,
      vendorOrderNo: shipment.vendor_order_no,
      invoiceNo: shipment.invoice_no,
      customerName: shipment.customer_name,
      customerPhone: shipment.customer_phone,
      courierCode: shipment.courier_code,
      trackingId: shipment.tracking_id,
      externalConsignmentId: shipment.external_consignment_id,
      bookingStatus: shipment.booking_status,
      bookingIdempotencyKey: shipment.booking_idempotency_key,
      bookingResponseJson: parsedBookingResponse,
      recommendationSnapshotJson: parsedRecommendation,
      ageMinutes: Math.floor((Date.now() - new Date(shipment.updated_at).getTime()) / 60000),
      createdAt: shipment.created_at,
      updatedAt: shipment.updated_at
    },
    events: events.map(e => ({
      id: e.id,
      eventType: e.event_type,
      actorType: e.actor_type,
      userId: e.user_id,
      userName: e.user_name || (e.actor_type === 'vendor' ? 'Vendor' : 'System'),
      userEmail: e.user_email || null,
      courierCode: e.courier_code,
      trackingReference: e.tracking_reference,
      resultCode: e.result_code,
      note: e.note,
      createdAt: e.created_at
    }))
  };
}

/**
 * Super Admin manual resolution of ambiguous shipment.
 * Requires verified provider evidence and audit note.
 * Prohibits status override without owner/Super Admin authorization.
 */
async function resolveAmbiguousBookingOverride({
  shipmentId,
  subOrderId,
  resolution,
  providerEvidence,
  trackingReference = '',
  note = '',
  actor
}) {
  if (!actor || (!actor.isSuperAdmin && !actor.platformAdmin)) {
    throw new AuthorizationError('Manual override of ambiguous courier booking requires Super Admin authorization.');
  }

  // Validate resolution action
  const cleanRes = String(resolution || '').trim().toLowerCase();
  if (!['confirm_parcel_exists', 'confirm_parcel_absent'].includes(cleanRes)) {
    throw new ValidationError("Resolution must be either 'confirm_parcel_exists' or 'confirm_parcel_absent'.");
  }

  // Provider evidence is MANDATORY
  const cleanEvidence = String(providerEvidence || '').trim();
  if (cleanEvidence.length < 5) {
    throw new ValidationError('Provider evidence is mandatory for manual resolution (minimum 5 characters, e.g. carrier ticket # or confirmation ref).');
  }

  const cleanTracking = String(trackingReference || '').trim();
  if (cleanRes === 'confirm_parcel_exists' && !cleanTracking) {
    throw new ValidationError("Tracking reference is mandatory when resolving as 'confirm_parcel_exists'.");
  }

  assertMysql();

  return withTransaction(async (tx) => {
    let shipment = null;
    if (shipmentId) {
      shipment = await tx.queryOne(
        `SELECT fs.*, vso.vendor_id, vso.order_id FROM fulfillment_shipments fs JOIN vendor_sub_orders vso ON vso.id = fs.vendor_sub_order_id WHERE fs.id = ? FOR UPDATE`,
        [shipmentId]
      );
    } else if (subOrderId) {
      shipment = await tx.queryOne(
        `SELECT fs.*, vso.vendor_id, vso.order_id FROM fulfillment_shipments fs JOIN vendor_sub_orders vso ON vso.id = fs.vendor_sub_order_id WHERE fs.vendor_sub_order_id = ? ORDER BY fs.id DESC LIMIT 1 FOR UPDATE`,
        [subOrderId]
      );
    }

    if (!shipment) {
      throw new NotFoundError('Shipment not found.');
    }

    if (shipment.picked_up_at) {
      throw new ValidationError('Cannot override shipment that has already been physically picked up.');
    }

    const auditNote = `[Super Admin Manual Override] Evidence: ${cleanEvidence}${note ? ` | Note: ${note.trim()}` : ''}`;
    const actorUserId = actor.userId || null;

    if (cleanRes === 'confirm_parcel_exists') {
      await tx.execute(
        `UPDATE fulfillment_shipments
         SET booking_status = 'succeeded',
             tracking_id = ?,
             external_consignment_id = ?,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [cleanTracking, cleanTracking, shipment.id]
      );

      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'manual_override', 'admin', ?, ?, ?, ?, 'succeeded', ?, UTC_TIMESTAMP())`,
        [shipment.id, shipment.vendor_id, actorUserId, shipment.courier_code || '', cleanTracking, auditNote]
      );

      await tx.execute(
        `UPDATE vendor_sub_orders SET shipment_carrier = ?, tracking_code = ? WHERE id = ?`,
        [shipment.courier_code || '', cleanTracking, shipment.vendor_sub_order_id]
      );
      if (shipment.order_id) {
        await tx.execute(
          `UPDATE orders
           SET courier_name = CASE WHEN courier_name = '' OR courier_name IS NULL THEN ? ELSE courier_name END,
               courier_tracking_id = CASE WHEN courier_tracking_id = '' OR courier_tracking_id IS NULL THEN ? ELSE courier_tracking_id END
           WHERE id = ?`,
          [shipment.courier_code || '', cleanTracking, shipment.order_id]
        );
      }

      return {
        success: true,
        resolution: 'confirm_parcel_exists',
        bookingStatus: 'succeeded',
        trackingId: cleanTracking,
        message: 'Ambiguous shipment resolved: carrier parcel existence verified by Super Admin with provider evidence.'
      };
    } else {
      // confirm_parcel_absent: clears the ambiguous state to failed, allowing a safe fresh booking
      await tx.execute(
        `UPDATE fulfillment_shipments
         SET booking_status = 'failed',
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [shipment.id]
      );

      await tx.execute(
        `INSERT INTO fulfillment_shipment_events
         (shipment_id, event_type, actor_type, vendor_id, user_id, courier_code, tracking_reference, result_code, note, created_at)
         VALUES (?, 'manual_override', 'admin', ?, ?, ?, '', 'failed', ?, UTC_TIMESTAMP())`,
        [shipment.id, shipment.vendor_id, actorUserId, shipment.courier_code || '', auditNote]
      );

      return {
        success: true,
        resolution: 'confirm_parcel_absent',
        bookingStatus: 'failed',
        message: 'Ambiguous shipment resolved: carrier parcel absence verified by Super Admin with provider evidence. Safe re-booking is now authorized.'
      };
    }
  });
}

/**
 * Data and reporting contract for tracking ambiguous/timeout shipments.
 * Enables operational monitoring, manual reconciliation, and escalation workflows.
 * NOTE: Alert thresholds (e.g. 15m vs 30m) and designated operational personnel are owner decisions.
 */
async function getAmbiguousShipmentsReport({ olderThanMinutes = 0, limit = 50, offset = 0, pool } = {}) {
  const result = await listAmbiguousShipments({
    olderThanMinutes,
    limit,
    page: Math.floor(Number(offset) / Number(limit)) + 1,
    pool
  });
  return result.shipments;
}

module.exports = {
  getShipmentQuotesAndRecommendation,
  executeOneClickBooking,
  reconcileBookingResult,
  syncShipmentTracking,
  listAmbiguousShipments,
  getShipmentAuditTrail,
  resolveAmbiguousBookingOverride,
  getAmbiguousShipmentsReport
};
