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
 * Writes inside an active transaction (tx) when provided, or standalone.
 * Fail-closed: Never swallows errors. If an audit log write fails, the
 * error propagates and forces rollback of the enclosing transaction.
 */
async function recordAuditLog({ bookingRequestId, subOrderId, action, actorType, actorId, fromStatus, toStatus, details = {} }, tx = null) {
  const detailsJson = JSON.stringify(details || {});
  const reqId = Number(bookingRequestId);
  const subId = Number(subOrderId);
  const aId = Number(actorId);

  if (tx && typeof tx.execute === 'function') {
    // MySQL withTransaction client
    await tx.execute(
      `INSERT INTO vendor_courier_booking_audit_logs
       (booking_request_id, sub_order_id, action, actor_type, actor_id, from_status, to_status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [reqId, subId, action, actorType, aId, fromStatus || null, toStatus || null, detailsJson]
    );
  } else if (env.db.client === 'mysql') {
    const pool = getPool();
    await pool.query(
      `INSERT INTO vendor_courier_booking_audit_logs
       (booking_request_id, sub_order_id, action, actor_type, actor_id, from_status, to_status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [reqId, subId, action, actorType, aId, fromStatus || null, toStatus || null, detailsJson]
    );
  } else {
    // SQLite
    sqliteDb.run(
      `INSERT INTO vendor_courier_booking_audit_logs
       (booking_request_id, sub_order_id, action, actor_type, actor_id, from_status, to_status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
      reqId, subId, action, actorType, aId, fromStatus || null, toStatus || null, detailsJson
    );
  }
}

/**
 * Atomically updates a booking request's status and records an audit log entry
 * within a single database transaction. If the audit log or update fails, changes roll back.
 */
async function updateRequestStatusWithAudit({
  requestId,
  subOrderId,
  toStatus,
  fromStatus = null,
  adminId = null,
  trackingId = null,
  consignmentId = null,
  responseJson = null,
  failureReason = null,
  rejectionReason = null,
  adminNotes = null,
  action,
  details = {}
}) {
  const reqId = toPositiveInt(requestId, 'booking request ID');
  const subId = toPositiveInt(subOrderId, 'sub-order ID');
  const aId = adminId ? Number(adminId) : null;
  const auditDetails = { ...details };
  if (failureReason) auditDetails.failureReason = failureReason;
  if (rejectionReason) auditDetails.rejectionReason = rejectionReason;
  if (adminNotes) auditDetails.adminNotes = adminNotes;

  if (env.db.client === 'mysql') {
    return withTransaction(async (tx) => {
      await tx.execute(
        `UPDATE vendor_courier_booking_requests
         SET status = ?,
             tracking_id = COALESCE(?, tracking_id),
             consignment_id = COALESCE(?, consignment_id),
             courier_response_json = COALESCE(?, courier_response_json),
             failure_reason = ?,
             rejection_reason = COALESCE(?, rejection_reason),
             approved_by_admin_id = COALESCE(?, approved_by_admin_id),
             admin_notes = COALESCE(?, admin_notes),
             updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          toStatus,
          trackingId || null,
          consignmentId || null,
          responseJson || null,
          failureReason || null,
          rejectionReason || null,
          aId,
          adminNotes || null,
          reqId
        ]
      );

      await module.exports.recordAuditLog({
        bookingRequestId: reqId,
        subOrderId: subId,
        action,
        actorType: 'admin',
        actorId: aId || 0,
        fromStatus,
        toStatus,
        details: auditDetails
      }, tx);
    });
  } else {
    // SQLite atomic execution with rollback on audit failure
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      sqliteDb.run(
        `UPDATE vendor_courier_booking_requests
         SET status = ?,
             tracking_id = COALESCE(?, tracking_id),
             consignment_id = COALESCE(?, consignment_id),
             courier_response_json = COALESCE(?, courier_response_json),
             failure_reason = ?,
             rejection_reason = COALESCE(?, rejection_reason),
             approved_by_admin_id = COALESCE(?, approved_by_admin_id),
             admin_notes = COALESCE(?, admin_notes),
             updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        toStatus,
        trackingId || null,
        consignmentId || null,
        responseJson || null,
        failureReason || null,
        rejectionReason || null,
        aId,
        adminNotes || null,
        reqId
      );

      await module.exports.recordAuditLog({
        bookingRequestId: reqId,
        subOrderId: subId,
        action,
        actorType: 'admin',
        actorId: aId || 0,
        fromStatus,
        toStatus,
        details: auditDetails
      });
      sqliteDb.exec('COMMIT');
    } catch (err) {
      try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  }
}

/**
 * Submits a new courier booking request from vendor to Admin approval queue.
 * Concurrency-safe: uses database-enforced unique constraints and atomic checks.
 * Enforces ownership-first validation before checking idempotency replay.
 */
async function createBookingRequest({ subOrderId, vendorId, courierCode = '', note = '', idempotencyKey = '' }) {
  const subId = toPositiveInt(subOrderId, 'sub-order ID');
  const vId = toPositiveInt(vendorId, 'vendor ID');
  const cleanCourier = String(courierCode || '').trim().toLowerCase().slice(0, 50);
  const cleanNote = String(note || '').trim().slice(0, 500);
  const cleanIdemp = String(idempotencyKey || '').trim().slice(0, 120);

  if (env.db.client === 'mysql') {
    return withTransaction(async (tx) => {
      // 1. Query and lock sub-order FOR UPDATE
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

      // 2. FIRST: Validate vendor ownership before any idempotency lookup or replay
      if (Number(subOrder.vendor_id) !== vId) {
        throw new AuthorizationError('You are not authorized to request courier booking for this sub-order.');
      }

      // 3. SECOND: Check idempotency key replay if provided
      if (cleanIdemp) {
        const existing = await tx.queryOne(
          `SELECT * FROM vendor_courier_booking_requests WHERE idempotency_key = ?`,
          [cleanIdemp]
        );
        if (existing) {
          // Replay verification: both vendor_id and sub_order_id must match
          if (Number(existing.vendor_id) !== vId || Number(existing.sub_order_id) !== subId) {
            throw new ConflictError('Idempotency key collision or unauthorized replay detected.');
          }
          return { request: existing, idempotentReplay: true };
        }
      }

      // 4. Validate sub-order state
      if (['cancelled', 'delivered', 'returned'].includes(subOrder.status)) {
        throw new ValidationError(`Sub-order in '${subOrder.status}' status cannot be booked with courier.`);
      }

      // 5. Check for existing active requests with row lock
      const existingReq = await tx.queryOne(
        `SELECT id, status, tracking_id, rejection_reason FROM vendor_courier_booking_requests
         WHERE sub_order_id = ? AND status IN ('pending', 'booking', 'booked', 'in_review')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [subId]
      );

      if (existingReq) {
        if (existingReq.status === 'booked') {
          throw new ConflictError('Courier has already been booked for this sub-order.');
        }
        if (existingReq.status === 'in_review') {
          throw new ConflictError('A courier booking request for this sub-order is currently under review due to an uncertain provider outcome.');
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

        // Transactional audit log recording
        await module.exports.recordAuditLog({
          bookingRequestId: reqId,
          subOrderId: subId,
          action: 'request_created',
          actorType: 'vendor',
          actorId: vId,
          fromStatus: null,
          toStatus: 'pending',
          details: { courierCode: cleanCourier, note: cleanNote, idempotencyKey: cleanIdemp }
        }, tx);

        const created = await tx.queryOne('SELECT * FROM vendor_courier_booking_requests WHERE id = ?', [reqId]);
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
    const hasVso = sqliteDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='vendor_sub_orders'");
    let orderId = 1;
    if (hasVso) {
      const subOrder = sqliteDb.get(
        'SELECT id, order_id, vendor_id, status FROM vendor_sub_orders WHERE id = ?',
        subId
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
      orderId = Number(subOrder.order_id) || 1;
    }

    // 2. Check idempotency replay if key provided
    if (cleanIdemp) {
      const existing = sqliteDb.get('SELECT * FROM vendor_courier_booking_requests WHERE idempotency_key = ?', cleanIdemp);
      if (existing) {
        if (Number(existing.vendor_id) !== vId || Number(existing.sub_order_id) !== subId) {
          throw new ConflictError('Idempotency key collision or unauthorized replay detected.');
        }
        return { request: existing, idempotentReplay: true };
      }
    }

    const existingReq = sqliteDb.get(
      `SELECT id, status FROM vendor_courier_booking_requests
       WHERE sub_order_id = ? AND status IN ('pending', 'booking', 'booked', 'in_review')
       ORDER BY id DESC LIMIT 1`,
      subId
    );

    if (existingReq) {
      if (existingReq.status === 'booked') {
        throw new ConflictError('Courier has already been booked for this sub-order.');
      }
      if (existingReq.status === 'in_review') {
        throw new ConflictError('A courier booking request for this sub-order is currently under review due to an uncertain provider outcome.');
      }
      throw new ConflictError('A courier booking request is already pending or being processed for this sub-order.');
    }

    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      const res = sqliteDb.run(
        `INSERT INTO vendor_courier_booking_requests
         (sub_order_id, order_id, vendor_id, courier_code, status, vendor_notes, idempotency_key)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        subId, orderId, vId, cleanCourier || null, cleanNote || null, cleanIdemp || null
      );

      const created = await getBookingRequestById(res.lastInsertRowid);
      await module.exports.recordAuditLog({
        bookingRequestId: res.lastInsertRowid,
        subOrderId: subId,
        action: 'request_created',
        actorType: 'vendor',
        actorId: vId,
        fromStatus: null,
        toStatus: 'pending',
        details: { courierCode: cleanCourier, note: cleanNote, idempotencyKey: cleanIdemp }
      });
      sqliteDb.exec('COMMIT');
      return { request: created, idempotentReplay: false };
    } catch (insertErr) {
      try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
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
 * Concurrency-safe: atomically flips status from ('pending', 'failed', 'in_review') to 'booking'
 * and checks affectedRows before invoking the courier API. Only one request acquires the lock.
 * Uses a stable, deterministic idempotency key and safe fail-closed reconciliation strategy.
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
    throw new ConflictError('Courier booking lock could not be acquired: another admin request is currently processing this booking.');
  }
  if (current.status === 'rejected') {
    throw new ConflictError('Cannot approve a rejected booking request.');
  }
  if (!['pending', 'failed', 'in_review'].includes(current.status)) {
    throw new ConflictError(`Cannot approve request in current status '${current.status}'.`);
  }

  // 1. Atomic conditional state transition to 'booking' with transactional audit logging
  let lockAcquired = false;
  if (env.db.client === 'mysql') {
    lockAcquired = await withTransaction(async (tx) => {
      const updateRes = await tx.execute(
        `UPDATE vendor_courier_booking_requests
         SET status = 'booking', approved_by_admin_id = ?, admin_notes = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND status IN ('pending', 'failed', 'in_review')`,
        [aId, adminNote || null, reqId]
      );
      if (!updateRes || updateRes.affectedRows !== 1) {
        return false;
      }
      await module.exports.recordAuditLog({
        bookingRequestId: reqId,
        subOrderId: current.sub_order_id,
        action: 'approval_lock_acquired',
        actorType: 'admin',
        actorId: aId,
        fromStatus: current.status,
        toStatus: 'booking',
        details: { note: adminNote }
      }, tx);
      return true;
    });
  } else {
    // SQLite atomic lock acquisition: update status first, then record audit log
    // If audit log fails, revert state and rethrow
    const res = sqliteDb.run(
      `UPDATE vendor_courier_booking_requests
       SET status = 'booking', approved_by_admin_id = ?, admin_notes = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status IN ('pending', 'failed', 'in_review')`,
      aId, adminNote || null, reqId
    );
    lockAcquired = (res && res.changes === 1);
    if (lockAcquired) {
      try {
        await module.exports.recordAuditLog({
          bookingRequestId: reqId,
          subOrderId: current.sub_order_id,
          action: 'approval_lock_acquired',
          actorType: 'admin',
          actorId: aId,
          fromStatus: current.status,
          toStatus: 'booking',
          details: { note: adminNote }
        });
      } catch (auditErr) {
        sqliteDb.run(
          `UPDATE vendor_courier_booking_requests
           SET status = ?, approved_by_admin_id = ?, updated_at = datetime('now', 'localtime')
           WHERE id = ?`,
          current.status, current.approved_by_admin_id || null, reqId
        );
        throw auditErr;
      }
    }
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

  const selectedCourier = String(courierCodeOverride || current.courier_code || '').trim().toLowerCase();
  const courierRepo = require('./courierIntegrationRepository');

  // Stable deterministic idempotency key per booking request
  const stableIdempotencyKey = `vcbr:${reqId}:suborder:${current.sub_order_id}`;

  // 2. Ambiguity & reconciliation check before booking (FAIL-CLOSED)
  // Check if shipment exists and was left in unknown_timeout or in_review
  let existingShipment = null;
  if (env.db.client === 'mysql') {
    const pool = getPool();
    const [shipRows] = await pool.query(
      'SELECT id, booking_status, tracking_id, external_consignment_id, courier_code FROM fulfillment_shipments WHERE vendor_sub_order_id = ? ORDER BY id DESC LIMIT 1',
      [current.sub_order_id]
    );
    existingShipment = shipRows && shipRows[0] ? shipRows[0] : null;
  } else {
    const hasFulfillment = sqliteDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='fulfillment_shipments'");
    if (hasFulfillment) {
      existingShipment = sqliteDb.get(
        'SELECT id, booking_status, tracking_id, external_consignment_id, courier_code FROM fulfillment_shipments WHERE vendor_sub_order_id = ? ORDER BY id DESC LIMIT 1',
        current.sub_order_id
      ) || null;
    }
  }

  const needsReconciliation = (existingShipment && ['unknown_timeout', 'in_review'].includes(existingShipment.booking_status)) ||
    current.status === 'in_review' ||
    Boolean(current.tracking_id || current.consignment_id);

  if (needsReconciliation) {
    let rec = null;
    let recErr = null;
    try {
      rec = await courierRepo.reconcileBookingResult({
        subOrderId: current.sub_order_id,
        actor: { userId: aId, platformAdmin: true }
      });
    } catch (err) {
      recErr = err;
    }

    if (recErr || !rec || !rec.reconciled) {
      const reasonMsg = recErr ? recErr.message : (rec?.message || 'Carrier reconciliation inconclusive; parcel absence not confirmed');
      // FAIL-CLOSED: transition request from 'booking' to 'in_review'
      await updateRequestStatusWithAudit({
        requestId: reqId,
        subOrderId: current.sub_order_id,
        toStatus: 'in_review',
        fromStatus: 'booking',
        adminId: aId,
        action: 'reconciliation_uncertain_blocked',
        failureReason: reasonMsg,
        adminNotes: adminNote
      });

      throw new ConflictError(
        `Cannot proceed with courier booking: previous provider outcome for sub-order #${current.sub_order_id} is uncertain (${reasonMsg}). Request placed in 'in_review' status. Reconcile provider status before retry.`
      );
    }

    if (rec.outcome === 'found' || (rec.bookingStatus === 'succeeded' && rec.trackingId)) {
      // Parcel already exists at provider! Recovered!
      const recTrackingId = rec.trackingId;
      const recConsignmentId = rec.externalConsignmentId || rec.consignmentId || recTrackingId;
      await updateRequestStatusWithAudit({
        requestId: reqId,
        subOrderId: current.sub_order_id,
        toStatus: 'booked',
        fromStatus: 'booking',
        adminId: aId,
        trackingId: recTrackingId,
        consignmentId: recConsignmentId,
        responseJson: JSON.stringify(rec),
        action: 'booking_reconciled',
        details: { trackingId: recTrackingId, note: 'Reconciled from uncertain provider state; parcel confirmed at provider.' }
      });

      const bookedReq = await getBookingRequestById(reqId);
      return { success: true, request: bookedReq, booking: rec, reconciled: true };
    } else if (rec.outcome === 'confirmed_absent' || (rec.bookingStatus === 'failed' && rec.reconciled)) {
      // Confirmed absent: record audit log and safely proceed to booking
      await module.exports.recordAuditLog({
        bookingRequestId: reqId,
        subOrderId: current.sub_order_id,
        action: 'reconciliation_confirmed_absent',
        actorType: 'admin',
        actorId: aId,
        fromStatus: 'booking',
        toStatus: 'booking',
        details: { message: rec.message || 'Carrier confirmed no parcel exists; cleared for safe retry.' }
      });
      // Safe to proceed to executeOneClickBooking!
    } else {
      // Any other inconclusive result: FAIL-CLOSED!
      const reasonMsg = rec.message || 'Carrier reconciliation outcome is inconclusive; parcel absence not confirmed';
      await updateRequestStatusWithAudit({
        requestId: reqId,
        subOrderId: current.sub_order_id,
        toStatus: 'in_review',
        fromStatus: 'booking',
        adminId: aId,
        action: 'reconciliation_uncertain_blocked',
        failureReason: reasonMsg,
        adminNotes: adminNote
      });
      throw new ConflictError(
        `Cannot proceed with courier booking: previous provider outcome is uncertain (${reasonMsg}). Request placed in 'in_review' status.`
      );
    }
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

    // Atomically update request to 'booked' with audit log
    await updateRequestStatusWithAudit({
      requestId: reqId,
      subOrderId: current.sub_order_id,
      toStatus: 'booked',
      fromStatus: 'booking',
      adminId: aId,
      trackingId,
      consignmentId,
      responseJson,
      action: 'booking_succeeded',
      details: { trackingId, consignmentId, courierName: bookingResult.courierName }
    });

    const updated = await getBookingRequestById(reqId);
    return { success: true, request: updated, booking: bookingResult };
  } catch (err) {
    const isTimeoutOrUncertain = err.code === 'PROVIDER_TIMEOUT' ||
      String(err.message || '').toLowerCase().includes('timeout') ||
      String(err.message || '').toLowerCase().includes('econnreset') ||
      err.status === 'unknown_timeout';

    const newStatus = isTimeoutOrUncertain ? 'in_review' : 'failed';
    const actionName = isTimeoutOrUncertain ? 'booking_timeout_in_review' : 'booking_failed';
    const errorMsg = String(err.message || 'Courier API execution failed').slice(0, 500);

    // Atomically transition status with audit log
    await updateRequestStatusWithAudit({
      requestId: reqId,
      subOrderId: current.sub_order_id,
      toStatus: newStatus,
      fromStatus: 'booking',
      adminId: aId,
      action: actionName,
      failureReason: errorMsg,
      details: { error: errorMsg, isTimeout: isTimeoutOrUncertain }
    });

    const failedReq = await getBookingRequestById(reqId);
    const failureError = new Error(`Courier booking failed: ${errorMsg}`);
    failureError.code = isTimeoutOrUncertain ? 'COURIER_BOOKING_UNCERTAIN' : 'COURIER_BOOKING_FAILED';
    failureError.request = failedReq;
    throw failureError;
  }
}

/**
 * Rejects a vendor courier booking request with a recorded reason.
 * Concurrency-safe: atomically updates from eligible states ('pending', 'failed', 'in_review')
 * and checks affectedRows. Never permits rejection of 'booking' or 'booked' requests.
 * Executes within a database transaction with audit logging.
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
  if (!['pending', 'failed', 'in_review'].includes(current.status)) {
    throw new ConflictError(`Cannot reject request in status '${current.status}'.`);
  }

  let rejectSuccess = false;
  if (env.db.client === 'mysql') {
    rejectSuccess = await withTransaction(async (tx) => {
      const updateRes = await tx.execute(
        `UPDATE vendor_courier_booking_requests
         SET status = 'rejected',
             rejection_reason = ?,
             approved_by_admin_id = ?,
             admin_notes = ?,
             updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND status IN ('pending', 'failed', 'in_review')`,
        [reason, aId, adminNote || null, reqId]
      );
      if (!updateRes || updateRes.affectedRows !== 1) {
        return false;
      }
      await module.exports.recordAuditLog({
        bookingRequestId: reqId,
        subOrderId: current.sub_order_id,
        action: 'request_rejected',
        actorType: 'admin',
        actorId: aId,
        fromStatus: current.status,
        toStatus: 'rejected',
        details: { reason, note: adminNote }
      }, tx);
      return true;
    });
  } else {
    // SQLite atomic rejection with transaction rollback on audit failure
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      const res = sqliteDb.run(
        `UPDATE vendor_courier_booking_requests
         SET status = 'rejected',
             rejection_reason = ?,
             approved_by_admin_id = ?,
             admin_notes = ?,
             updated_at = datetime('now', 'localtime')
         WHERE id = ? AND status IN ('pending', 'failed', 'in_review')`,
        reason, aId, adminNote || null, reqId
      );
      if (res && res.changes === 1) {
        await module.exports.recordAuditLog({
          bookingRequestId: reqId,
          subOrderId: current.sub_order_id,
          action: 'request_rejected',
          actorType: 'admin',
          actorId: aId,
          fromStatus: current.status,
          toStatus: 'rejected',
          details: { reason, note: adminNote }
        });
        sqliteDb.exec('COMMIT');
        rejectSuccess = true;
      } else {
        sqliteDb.exec('ROLLBACK');
        rejectSuccess = false;
      }
    } catch (err) {
      try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
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
  updateRequestStatusWithAudit,
};
