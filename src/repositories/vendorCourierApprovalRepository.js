'use strict';

const { env } = require('../config/env');
const { getPool, withTransaction } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');
const { ValidationError, NotFoundError, ConflictError, AuthorizationError } = require('../utils/errors');

let tableEnsured = false;

/**
 * Ensures the vendor_courier_booking_requests table exists.
 */
async function ensureTable() {
  if (tableEnsured) return;

  if (env.db.client === 'mysql') {
    try {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS vendor_courier_booking_requests (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          sub_order_id BIGINT NOT NULL,
          order_id BIGINT NOT NULL,
          vendor_id INT NOT NULL,
          courier_code VARCHAR(50) DEFAULT NULL,
          status VARCHAR(30) NOT NULL DEFAULT 'pending',
          tracking_id VARCHAR(120) DEFAULT NULL,
          consignment_id VARCHAR(120) DEFAULT NULL,
          rejection_reason TEXT DEFAULT NULL,
          failure_reason TEXT DEFAULT NULL,
          vendor_notes TEXT DEFAULT NULL,
          admin_notes TEXT DEFAULT NULL,
          idempotency_key VARCHAR(120) DEFAULT NULL,
          courier_response_json LONGTEXT DEFAULT NULL,
          approved_by_admin_id INT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_vcbr_vendor_status (vendor_id, status),
          INDEX idx_vcbr_sub_order (sub_order_id),
          UNIQUE KEY uq_vcbr_idempotency (idempotency_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      tableEnsured = true;
    } catch (err) {
      // In case pool is not ready or during isolated unit testing
    }
  } else {
    try {
      sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS vendor_courier_booking_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sub_order_id INTEGER NOT NULL,
          order_id INTEGER NOT NULL,
          vendor_id INTEGER NOT NULL,
          courier_code TEXT DEFAULT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          tracking_id TEXT DEFAULT NULL,
          consignment_id TEXT DEFAULT NULL,
          rejection_reason TEXT DEFAULT NULL,
          failure_reason TEXT DEFAULT NULL,
          vendor_notes TEXT DEFAULT NULL,
          admin_notes TEXT DEFAULT NULL,
          idempotency_key TEXT UNIQUE,
          courier_response_json TEXT DEFAULT NULL,
          approved_by_admin_id INTEGER DEFAULT NULL,
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
      `);
      tableEnsured = true;
    } catch (_) {}
  }
}

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
 * Submits a new courier booking request from vendor to Admin approval queue.
 */
async function createBookingRequest({ subOrderId, vendorId, courierCode = '', note = '', idempotencyKey = '' }) {
  await ensureTable();
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
    const pool = getPool();
    const [subRows] = await pool.query(
      `SELECT vso.id, vso.order_id, vso.vendor_id, vso.status, vso.delivery_mode, vso.cod_due_paisa,
              o.invoice_no, o.customer_name, o.customer_phone, o.shipping_address, o.order_status
       FROM vendor_sub_orders vso
       JOIN orders o ON o.id = vso.order_id
       WHERE vso.id = ?`,
      [subId]
    );

    const subOrder = subRows && subRows[0];
    if (!subOrder) {
      throw new NotFoundError('Vendor sub-order not found.');
    }

    if (Number(subOrder.vendor_id) !== vId) {
      throw new AuthorizationError('You are not authorized to request courier booking for this sub-order.');
    }

    if (['cancelled', 'delivered', 'returned'].includes(subOrder.status)) {
      throw new ValidationError(`Sub-order in '${subOrder.status}' status cannot be booked with courier.`);
    }

    // Check for existing active requests
    const [reqRows] = await pool.query(
      `SELECT id, status, tracking_id, rejection_reason FROM vendor_courier_booking_requests
       WHERE sub_order_id = ? ORDER BY id DESC LIMIT 1`,
      [subId]
    );

    const existingReq = reqRows && reqRows[0];
    if (existingReq) {
      if (existingReq.status === 'booked') {
        throw new ConflictError('Courier has already been booked for this sub-order.');
      }
      if (['pending', 'booking'].includes(existingReq.status)) {
        throw new ConflictError('A courier booking request is already pending or being processed for this sub-order.');
      }
      // If status is 'failed' or 'rejected', vendor is allowed to submit a new request
    }

    const orderId = Number(subOrder.order_id);
    const [insertResult] = await pool.query(
      `INSERT INTO vendor_courier_booking_requests
       (sub_order_id, order_id, vendor_id, courier_code, status, vendor_notes, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [subId, orderId, vId, cleanCourier || null, cleanNote || null, cleanIdemp || null]
    );

    const reqId = insertResult.insertId;
    const created = await getBookingRequestById(reqId);
    return { request: created, idempotentReplay: false };
  } else {
    // SQLite implementation (primarily for unit/e2e test runner without MySQL)
    const existingReq = sqliteDb.get(
      'SELECT id, status FROM vendor_courier_booking_requests WHERE sub_order_id = ? ORDER BY id DESC LIMIT 1',
      subId
    );

    if (existingReq) {
      if (existingReq.status === 'booked') {
        throw new ConflictError('Courier has already been booked for this sub-order.');
      }
      if (['pending', 'booking'].includes(existingReq.status)) {
        throw new ConflictError('A courier booking request is already pending or being processed for this sub-order.');
      }
    }

    const res = sqliteDb.run(
      `INSERT INTO vendor_courier_booking_requests
       (sub_order_id, order_id, vendor_id, courier_code, status, vendor_notes, idempotency_key)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      subId, 1, vId, cleanCourier || null, cleanNote || null, cleanIdemp || null
    );

    const created = await getBookingRequestById(res.lastInsertRowid);
    return { request: created, idempotentReplay: false };
  }
}

/**
 * Lists booking requests with optional status and vendor filtering.
 */
async function listBookingRequests({ status = 'all', vendorId = null, page = 1, perPage = 20 } = {}) {
  await ensureTable();
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
  await ensureTable();
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
  await ensureTable();
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
  await ensureTable();
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
 */
async function approveBookingRequest({ requestId, adminId, courierCodeOverride = '', note = '' }) {
  await ensureTable();
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

  const selectedCourier = String(courierCodeOverride || current.courier_code || '').trim().toLowerCase();

  // Set status to 'booking' to lock against duplicate concurrent approvals
  if (env.db.client === 'mysql') {
    const pool = getPool();
    await pool.query(
      `UPDATE vendor_courier_booking_requests
       SET status = 'booking', approved_by_admin_id = ?, admin_notes = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status IN ('pending', 'failed')`,
      [aId, adminNote || null, reqId]
    );
  } else {
    sqliteDb.run(
      `UPDATE vendor_courier_booking_requests
       SET status = 'booking', approved_by_admin_id = ?, admin_notes = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status IN ('pending', 'failed')`,
      aId, adminNote || null, reqId
    );
  }

  // Trigger existing courier integration
  try {
    const courierRepo = require('./courierIntegrationRepository');
    const bookingResult = await courierRepo.executeOneClickBooking({
      subOrderId: current.sub_order_id,
      courierCode: selectedCourier || undefined,
      actor: { userId: aId, role: 'admin', platformAdmin: true },
      idempotencyKey: `req-${reqId}-${Date.now()}`,
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

    const failedReq = await getBookingRequestById(reqId);
    const failureError = new Error(`Courier booking failed: ${errorMsg}`);
    failureError.code = 'COURIER_BOOKING_FAILED';
    failureError.request = failedReq;
    throw failureError;
  }
}

/**
 * Rejects a vendor courier booking request with a recorded reason.
 */
async function rejectBookingRequest({ requestId, adminId, rejectionReason, note = '' }) {
  await ensureTable();
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
    throw new ConflictError('Cannot reject an already booked request.');
  }

  if (env.db.client === 'mysql') {
    const pool = getPool();
    await pool.query(
      `UPDATE vendor_courier_booking_requests
       SET status = 'rejected',
           rejection_reason = ?,
           approved_by_admin_id = ?,
           admin_notes = ?,
           updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [reason, aId, adminNote || null, reqId]
    );
  } else {
    sqliteDb.run(
      `UPDATE vendor_courier_booking_requests
       SET status = 'rejected',
           rejection_reason = ?,
           approved_by_admin_id = ?,
           admin_notes = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      reason, aId, adminNote || null, reqId
    );
  }

  const updated = await getBookingRequestById(reqId);
  return { success: true, request: updated };
}

module.exports = {
  ensureTable,
  createBookingRequest,
  listBookingRequests,
  getBookingRequestById,
  getBookingRequestByIdempotencyKey,
  getBookingRequestBySubOrderId,
  approveBookingRequest,
  rejectBookingRequest,
};
