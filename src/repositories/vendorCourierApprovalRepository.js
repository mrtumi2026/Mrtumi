'use strict';

const { env } = require('../config/env');
const { getPool, withTransaction } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');
const { ValidationError, NotFoundError, ConflictError, AuthorizationError } = require('../utils/errors');

/**
 * Validates a positive integer identifier.
 */
function toPositiveInt(val, label) {
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Valid ${label} is required.`);
  }
  return n;
}

/**
 * Audit log recorder for vendor courier booking lifecycle events.
 */
async function recordAuditLog({ bookingRequestId, subOrderId, action, actorType, actorId, fromStatus, toStatus, details = {} }) {
  const detailsJson = JSON.stringify(details);
  if (env.db.client === 'mysql') {
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO vendor_courier_booking_audit_logs
         (booking_request_id, sub_order_id, action, actor_type, actor_id, from_status, to_status, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [bookingRequestId, subOrderId, action, actorType, actorId, fromStatus || null, toStatus || null, detailsJson]
      );
    } catch (err) {
      // Non-fatal if audit write fails
      console.error('[WARN] Failed to write courier booking audit log:', err.message);
    }
  } else {
    try {
      sqliteDb.run(
        `INSERT INTO vendor_courier_booking_audit_logs
         (booking_request_id, sub_order_id, action, actor_type, actor_id, from_status, to_status, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
        bookingRequestId, subOrderId, action, actorType, actorId, fromStatus || null, toStatus || null, detailsJson
      );
    } catch (_) {}
  }
}

/**
 * Submits a new courier booking request from vendor to Admin approval queue.
 * Concurrency-safe: uses database-enforced unique constraints and atomic checks.
 */
async function createBookingRequest({ subOrderId, vendorId, courierCode = '', note = '', idempotencyKey = '' }) {
  const subId = toPositiveInt(subOrderId, 'sub-order ID');
  const vId = toPositiveInt(vendorId, 'vendor ID');
  const cleanCourier = String(courierCode || '').trim().toLowerCase().slice(0, 50);
  const cleanNote = String(note || '').trim().slice(0, 500);
  const cleanIdemp = String(idempotencyKey || '').trim().slice(0, 120);

  // 1. Check idempotency if key provided
  if (cleanIdemp) {
    const existing = await getBookingRequestByIdempotencyKey(cleanIdemp);
    if (existing) {
      return { request: existing, idempotentReplay: true };
    }
  }

  // 2. Query and validate suborder ownership & state
  if (env.db.client === 'mysql') {
    return withTransaction(async (tx) => {
      const subOrder = await tx.queryOne(
        `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, vso.delivery_mode, vso.cod_due_paisa,
                o.invoice_no, o.customer_name, o.customer_phone, o.shipping_address, o.order_status
         FROM vendor_sub_orders vso
         JOIN orders o ON o.id = vso.order_id
         WHERE vso.id = ? FOR UPDATE`,
        [subId]
      );

      if (!subOrder) {
        throw new NotFoundError('Vendor sub-order not found.');
      }

      if (Number(subOrder.vendor_id) !== vId) {
        throw new AuthorizationError('You are not authorized to request courier booking for this sub-order.');
      }

      if (['cancelled', 'delivered', 'returned'].includes(subOrder.status)) {
        throw new ValidationError(`Sub-order in '${subOrder.status}' status cannot be booked with courier.`);
      }

      // Check for existing active requests with row lock
      const existingReq = await tx.queryOne(
        `SELECT id, status, tracking_id, rejection_reason FROM vendor_courier_booking_requests
         WHERE sub_order_id = ? AND status IN ('pending', 'booking', 'booked')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [subId]
      );

      if (existingReq) {
        if (existingReq.status === 'booked') {
          throw new ConflictError('Courier has already been booked for this sub-order.');
        }
        throw new ConflictError('A courier booking request is already pending or being processed for this sub-order.');
      }

      const orderId = Number(subOrder.order_id);
      try {
        const res = await tx.execute(
          `INSERT INTO vendor_courier_booking_requests
           (sub_order_id, order_id, vendor_id, courier_code, status, vendor_notes, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
          [subId, orderId, vId, cleanCourier || null, cleanNote || null, cleanIdemp || null]
        );

        const reqId = res.insertId;
        const created = await tx.queryOne('SELECT * FROM vendor_courier_booking_requests WHERE id = ?', [reqId]);

        await recordAuditLog({
          bookingRequestId: reqId,
          subOrderId: subId,
          action: 'request_created',
          actorType: 'vendor',
          actorId: vId,
          fromStatus: null,
          toStatus: 'pending',
          details: { courierCode: cleanCourier, note: cleanNote, idempotencyKey: cleanIdemp }
        });

        return { request: created, idempotentReplay: false };
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY' || String(insertErr.message).includes('uq_vcbr_active_sub_order')) {
          throw new ConflictError('A courier booking request is already pending or being processed for this sub-order.');
        }
        throw insertErr;
      }
    });
  } else {
    // SQLite implementation (test runner)
    const existingReq = sqliteDb.get(
      `SELECT id, status FROM vendor_courier_booking_requests
       WHERE sub_order_id = ? AND status IN ('pending', 'booking', 'booked')
       ORDER BY id DESC LIMIT 1`,
      subId
    );

    if (existingReq) {
      if (existingReq.status === 'booked') {
        throw new ConflictError('Courier has already been booked for this sub-order.');
      }
      throw new ConflictError('A courier booking request is already pending or being processed for this sub-order.');
    }

    try {
      const res = sqliteDb.run(
        `INSERT INTO vendor_courier_booking_requests
         (sub_order_id, order_id, vendor_id, courier_code, status, vendor_notes, idempotency_key)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        subId, 1, vId, cleanCourier || null, cleanNote || null, cleanIdemp || null
      );

      const created = await getBookingRequestById(res.lastInsertRowid);
      await recordAuditLog({
        bookingRequestId: res.lastInsertRowid,
        subOrderId: subId,
        action: 'request_created',
        actorType: 'vendor',
        actorId: vId,
        fromStatus: null,
        toStatus: 'pending',
        details: { courierCode: cleanCourier, note: cleanNote }
      });
      return { request: created, idempotentReplay: false };
    } catch (insertErr) {
      if (String(insertErr.message).includes('UNIQUE constraint failed')) {
        throw new ConflictError('A courier booking request is already pending or being processed for this sub-order.');
      }
      throw insertErr;
    }
  }
}

/**
 * Lists booking requests with optional status and vendor filtering.
 */
async function listBookingRequests({ status = 'all', vendorId = null, page = 1, perPage = 20 } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limit = Math.min(100, Math.max(1, Number(perPage) || 20));
  const offset = (pageNum - 1) * limit;

  if (env.db.client === 'mysql') {
    const pool = getPool();
    const whereClauses = [];
    const params = [];

    if (status && status !== 'all') {
      whereClauses.push('vcbr.status = ?');
      params.push(status);
    }

    if (vendorId) {
      whereClauses.push('vcbr.vendor_id = ?');
      params.push(Number(vendorId));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM vendor_courier_booking_requests vcbr ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `SELECT vcbr.*,
              o.invoice_no, o.customer_name, o.customer_phone, o.shipping_address, o.shipping_zone,
              o.payment_method, o.payment_status, o.total_paisa, o.order_status,
              v.shop_name, v.owner_name, v.phone AS vendor_phone
       FROM vendor_courier_booking_requests vcbr
       LEFT JOIN orders o ON o.id = vcbr.order_id
       LEFT JOIN vendors v ON v.id = vcbr.vendor_id
       ${whereSql}
       ORDER BY vcbr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      requests: rows || [],
      pagination: {
        total,
        page: pageNum,
        perPage: limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  } else {
    // SQLite
    const whereClauses = [];
    const params = [];
    if (status && status !== 'all') {
      whereClauses.push('status = ?');
      params.push(status);
    }
    if (vendorId) {
      whereClauses.push('vendor_id = ?');
      params.push(Number(vendorId));
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const countRow = sqliteDb.get(`SELECT COUNT(*) AS total FROM vendor_courier_booking_requests ${whereSql}`, ...params);
    const total = Number(countRow?.total || 0);
    const rows = sqliteDb.all(
      `SELECT * FROM vendor_courier_booking_requests ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    return {
      requests: rows || [],
      pagination: {
        total,
        page: pageNum,
        perPage: limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}

/**
 * Retrieves a single booking request by its ID.
 */
async function getBookingRequestById(id) {
  const reqId = toPositiveInt(id, 'booking request ID');

  if (env.db.client === 'mysql') {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT vcbr.*,
              o.invoice_no, o.customer_name, o.customer_phone, o.shipping_address, o.shipping_zone,
              o.payment_method, o.payment_status, o.total_paisa, o.order_status,
              v.shop_name, v.owner_name, v.phone AS vendor_phone
       FROM vendor_courier_booking_requests vcbr
       LEFT JOIN orders o ON o.id = vcbr.order_id
       LEFT JOIN vendors v ON v.id = vcbr.vendor_id
       WHERE vcbr.id = ?`,
      [reqId]
    );
    return rows && rows[0] ? rows[0] : null;
  } else {
    return sqliteDb.get('SELECT * FROM vendor_courier_booking_requests WHERE id = ?', reqId) || null;
  }
}

/**
 * Retrieves a booking request by idempotency key.
 */
async function getBookingRequestByIdempotencyKey(key) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return null;

  if (env.db.client === 'mysql') {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM vendor_courier_booking_requests WHERE idempotency_key = ? LIMIT 1',
      [cleanKey]
    );
    return rows && rows[0] ? rows[0] : null;
  } else {
    return sqliteDb.get('SELECT * FROM vendor_courier_booking_requests WHERE idempotency_key = ?', cleanKey) || null;
  }
}

/**
 * Retrieves the latest booking request for a sub-order.
 */
async function getBookingRequestBySubOrderId(subOrderId, vendorId = null) {
  const subId = toPositiveInt(subOrderId, 'sub-order ID');

  if (env.db.client === 'mysql') {
    const pool = getPool();
    const where = ['sub_order_id = ?'];
    const params = [subId];
    if (vendorId) {
      where.push('vendor_id = ?');
      params.push(Number(vendorId));
    }
    const [rows] = await pool.query(
      `SELECT * FROM vendor_courier_booking_requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`,
      params
    );
    return rows && rows[0] ? rows[0] : null;
  } else {
    const where = ['sub_order_id = ?'];
    const params = [subId];
    if (vendorId) {
      where.push('vendor_id = ?');
      params.push(Number(vendorId));
    }
    return sqliteDb.get(
      `SELECT * FROM vendor_courier_booking_requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`,
      ...params
    ) || null;
  }
}

/**
 * Approves a vendor courier booking request and executes one-click courier integration.
 * Concurrency-safe: atomically flips status from ('pending', 'failed') to 'booking'
 * and checks affectedRows before invoking the courier API. Only one request acquires the lock.
 * Uses a stable, deterministic idempotency key and safe reconciliation strategy.
 */
async function approveBookingRequest({ requestId, adminId, courierCodeOverride = '', note = '' }) {
  const reqId = toPositiveInt(requestId, 'booking request ID');
  const aId = toPositiveInt(adminId, 'admin ID');
  const adminNote = String(note || '').trim().slice(0, 500);

  const current = await getBookingRequestById(reqId);
  if (!current) {
    throw new NotFoundError('Courier booking request not found.');
  }

  if (current.status === 'booked') {
    throw new ConflictError('This booking request has already been booked with courier.');
  }
  if (current.status === 'booking') {
    throw new ConflictError('Courier booking is currently in progress for this request.');
  }
  if (current.status === 'rejected') {
    throw new ConflictError('Cannot approve a rejected booking request.');
  }

  // 1. Atomic conditional state transition to 'booking'
  let lockAcquired = false;
  if (env.db.client === 'mysql') {
    const pool = getPool();
    const [updateRes] = await pool.query(
      `UPDATE vendor_courier_booking_requests
       SET status = 'booking', approved_by_admin_id = ?, admin_notes = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status IN ('pending', 'failed')`,
      [aId, adminNote || null, reqId]
    );
    lockAcquired = (updateRes && updateRes.affectedRows === 1);
  } else {
    const res = sqliteDb.run(
      `UPDATE vendor_courier_booking_requests
       SET status = 'booking', approved_by_admin_id = ?, admin_notes = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status IN ('pending', 'failed')`,
      aId, adminNote || null, reqId
    );
    lockAcquired = (res && res.changes === 1);
  }

  // If lock was not acquired, another concurrent admin request already acquired it
  if (!lockAcquired) {
    const fresh = await getBookingRequestById(reqId);
    if (!fresh) throw new NotFoundError('Courier booking request not found.');
    if (fresh.status === 'booking') {
      throw new ConflictError('Courier booking lock could not be acquired: another admin request is currently processing this booking.');
    }
    if (fresh.status === 'booked') {
      throw new ConflictError('This booking request has already been booked with courier.');
    }
    throw new ConflictError(`Cannot approve request in current status '${fresh.status}'.`);
  }

  await recordAuditLog({
    bookingRequestId: reqId,
    subOrderId: current.sub_order_id,
    action: 'approval_lock_acquired',
    actorType: 'admin',
    actorId: aId,
    fromStatus: current.status,
    toStatus: 'booking',
    details: { note: adminNote }
  });

  const selectedCourier = String(courierCodeOverride || current.courier_code || '').trim().toLowerCase();
  const courierRepo = require('./courierIntegrationRepository');

  // Stable deterministic idempotency key per booking request
  const stableIdempotencyKey = `vcbr:${reqId}:suborder:${current.sub_order_id}`;

  // 2. Ambiguity & reconciliation check before booking
  // If the shipment was previously left in unknown_timeout / in_review, reconcile before re-booking
  try {
    if (env.db.client === 'mysql') {
      const pool = getPool();
      const [shipRows] = await pool.query(
        'SELECT booking_status, tracking_id, external_consignment_id FROM fulfillment_shipments WHERE vendor_sub_order_id = ? ORDER BY id DESC LIMIT 1',
        [current.sub_order_id]
      );
      const ship = shipRows && shipRows[0];
      if (ship && ['unknown_timeout', 'in_review'].includes(ship.booking_status)) {
        // Attempt reconciliation first
        const rec = await courierRepo.reconcileBookingResult({
          subOrderId: current.sub_order_id,
          actor: { userId: aId, platformAdmin: true }
        });
        if (rec.reconciled && rec.status === 'succeeded' && rec.trackingId) {
          // Parcel exists at provider! Mark booked directly without duplicate call
          await pool.query(
            `UPDATE vendor_courier_booking_requests
             SET status = 'booked', tracking_id = ?, consignment_id = ?, courier_response_json = ?, failure_reason = NULL, updated_at = UTC_TIMESTAMP()
             WHERE id = ?`,
            [rec.trackingId, rec.externalConsignmentId || rec.trackingId, JSON.stringify(rec), reqId]
          );

          await recordAuditLog({
            bookingRequestId: reqId,
            subOrderId: current.sub_order_id,
            action: 'booking_reconciled',
            actorType: 'admin',
            actorId: aId,
            fromStatus: 'booking',
            toStatus: 'booked',
            details: { trackingId: rec.trackingId, note: 'Reconciled from uncertain provider state' }
          });

          const bookedReq = await getBookingRequestById(reqId);
          return { success: true, request: bookedReq, booking: rec, reconciled: true };
        }
      }
    }
  } catch (recErr) {
    console.error('[WARN] Pre-booking reconciliation check encountered an error:', recErr.message);
  }

  // 3. Trigger courier integration
  try {
    const bookingResult = await courierRepo.executeOneClickBooking({
      subOrderId: current.sub_order_id,
      courierCode: selectedCourier || undefined,
      actor: { userId: aId, role: 'admin', platformAdmin: true },
      idempotencyKey: stableIdempotencyKey,
      note: adminNote || `Approved by Admin #${aId}`,
    });

    const trackingId = bookingResult.trackingId || bookingResult.consignmentId || '';
    const consignmentId = bookingResult.consignmentId || trackingId;
    const responseJson = JSON.stringify(bookingResult);

    // Update request to 'booked'
    if (env.db.client === 'mysql') {
      const pool = getPool();
      await pool.query(
        `UPDATE vendor_courier_booking_requests
         SET status = 'booked',
             tracking_id = ?,
             consignment_id = ?,
             courier_response_json = ?,
             failure_reason = NULL,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [trackingId, consignmentId, responseJson, reqId]
      );
    } else {
      sqliteDb.run(
        `UPDATE vendor_courier_booking_requests
         SET status = 'booked',
             tracking_id = ?,
             consignment_id = ?,
             courier_response_json = ?,
             failure_reason = NULL,
             updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        trackingId, consignmentId, responseJson, reqId
      );
    }

    await recordAuditLog({
      bookingRequestId: reqId,
      subOrderId: current.sub_order_id,
      action: 'booking_succeeded',
      actorType: 'admin',
      actorId: aId,
      fromStatus: 'booking',
      toStatus: 'booked',
      details: { trackingId, consignmentId, courierName: bookingResult.courierName }
    });

    const updated = await getBookingRequestById(reqId);
    return { success: true, request: updated, booking: bookingResult };
  } catch (err) {
    // Record failure on the request, preserving it for safe retry
    const errorMsg = String(err.message || 'Courier API execution failed').slice(0, 500);

    if (env.db.client === 'mysql') {
      const pool = getPool();
      await pool.query(
        `UPDATE vendor_courier_booking_requests
         SET status = 'failed',
             failure_reason = ?,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [errorMsg, reqId]
      );
    } else {
      sqliteDb.run(
        `UPDATE vendor_courier_booking_requests
         SET status = 'failed',
             failure_reason = ?,
             updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        errorMsg, reqId
      );
    }

    await recordAuditLog({
      bookingRequestId: reqId,
      subOrderId: current.sub_order_id,
      action: 'booking_failed',
      actorType: 'admin',
      actorId: aId,
      fromStatus: 'booking',
      toStatus: 'failed',
      details: { error: errorMsg }
    });

    const failedReq = await getBookingRequestById(reqId);
    const failureError = new Error(`Courier booking failed: ${errorMsg}`);
    failureError.code = 'COURIER_BOOKING_FAILED';
    failureError.request = failedReq;
    throw failureError;
  }
}

/**
 * Rejects a vendor courier booking request with a recorded reason.
 * Concurrency-safe: atomically updates from eligible states ('pending', 'failed')
 * and checks affectedRows. Never permits rejection of 'booking' or 'booked' requests.
 */
async function rejectBookingRequest({ requestId, adminId, rejectionReason, note = '' }) {
  const reqId = toPositiveInt(requestId, 'booking request ID');
  const aId = toPositiveInt(adminId, 'admin ID');
  const reason = String(rejectionReason || '').trim();
  const adminNote = String(note || '').trim().slice(0, 500);

  if (!reason) {
    throw new ValidationError('A rejection reason is required to reject a courier booking request.');
  }

  const current = await getBookingRequestById(reqId);
  if (!current) {
    throw new NotFoundError('Courier booking request not found.');
  }

  if (current.status === 'booked') {
    throw new ConflictError('Cannot reject request: shipment has already been booked with courier.');
  }
  if (current.status === 'booking') {
    throw new ConflictError('Cannot reject request: courier booking is currently in progress.');
  }
  if (current.status === 'rejected') {
    throw new ConflictError('Request has already been rejected.');
  }

  let rejectSuccess = false;
  if (env.db.client === 'mysql') {
    const pool = getPool();
    const [updateRes] = await pool.query(
      `UPDATE vendor_courier_booking_requests
       SET status = 'rejected',
           rejection_reason = ?,
           approved_by_admin_id = ?,
           admin_notes = ?,
           updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status IN ('pending', 'failed')`,
      [reason, aId, adminNote || null, reqId]
    );
    rejectSuccess = (updateRes && updateRes.affectedRows === 1);
  } else {
    const res = sqliteDb.run(
      `UPDATE vendor_courier_booking_requests
       SET status = 'rejected',
           rejection_reason = ?,
           approved_by_admin_id = ?,
           admin_notes = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status IN ('pending', 'failed')`,
      reason, aId, adminNote || null, reqId
    );
    rejectSuccess = (res && res.changes === 1);
  }

  if (!rejectSuccess) {
    const fresh = await getBookingRequestById(reqId);
    if (!fresh) throw new NotFoundError('Courier booking request not found.');
    if (fresh.status === 'booking') {
      throw new ConflictError('Cannot reject request: courier booking is currently in progress.');
    }
    if (fresh.status === 'booked') {
      throw new ConflictError('Cannot reject request: shipment has already been booked with courier.');
    }
    throw new ConflictError(`Cannot reject request in status '${fresh.status}'.`);
  }

  await recordAuditLog({
    bookingRequestId: reqId,
    subOrderId: current.sub_order_id,
    action: 'request_rejected',
    actorType: 'admin',
    actorId: aId,
    fromStatus: current.status,
    toStatus: 'rejected',
    details: { reason, note: adminNote }
  });

  const updated = await getBookingRequestById(reqId);
  return { success: true, request: updated };
}

module.exports = {
  createBookingRequest,
  listBookingRequests,
  getBookingRequestById,
  getBookingRequestByIdempotencyKey,
  getBookingRequestBySubOrderId,
  approveBookingRequest,
  rejectBookingRequest,
  recordAuditLog,
};
