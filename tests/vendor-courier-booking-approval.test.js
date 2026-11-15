'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const approvalRepo = require('../src/repositories/vendorCourierApprovalRepository');
const courierRepo = require('../src/repositories/courierIntegrationRepository');
const { loadMigrationPairs } = require('../src/db/migrator');
const { ConflictError, ValidationError, NotFoundError, AuthorizationError } = require('../src/utils/errors');
const sqliteDb = require('../src/db/database');

const root = path.join(__dirname, '..');

// Initialize SQLite tables, mock relations, and partial unique index for test execution
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS vendor_sub_orders (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    vendor_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing'
  );

  CREATE TABLE IF NOT EXISTS fulfillment_shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_sub_order_id INTEGER NOT NULL,
    courier_code TEXT DEFAULT NULL,
    booking_status TEXT NOT NULL,
    tracking_id TEXT DEFAULT NULL,
    external_consignment_id TEXT DEFAULT NULL
  );

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
  DROP INDEX IF EXISTS uq_active_sub_order;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_active_sub_order ON vendor_courier_booking_requests(sub_order_id)
    WHERE status IN ('pending', 'booking', 'booked', 'in_review');

  CREATE TABLE IF NOT EXISTS vendor_courier_booking_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_request_id INTEGER NOT NULL,
    sub_order_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id INTEGER NOT NULL,
    from_status TEXT DEFAULT NULL,
    to_status TEXT DEFAULT NULL,
    details_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

test('Migration 0038 schema defines vendor_courier_booking_requests and audit logs', () => {
  const pairs = loadMigrationPairs(path.join(root, 'src/db/migrations'));
  const m38 = pairs.find((p) => p.version === '0038');
  assert.ok(m38, 'Migration 0038 must exist');
  assert.strictEqual(m38.name, 'vendor_courier_booking_requests');

  // Verify UP SQL schema
  assert.match(m38.upSql, /CREATE TABLE IF NOT EXISTS `vendor_courier_booking_requests`/);
  assert.match(m38.upSql, /`active_sub_order_id` BIGINT GENERATED ALWAYS AS/);
  assert.match(m38.upSql, /'in_review'/);
  assert.match(m38.upSql, /UNIQUE KEY `uq_vcbr_active_sub_order`/);
  assert.match(m38.upSql, /CREATE TABLE IF NOT EXISTS `vendor_courier_booking_audit_logs`/);

  // Verify DOWN SQL rollback with data-destructive warning
  assert.match(m38.downSql, /DATA-DESTRUCTIVE ROLLBACK/);
  assert.match(m38.downSql, /DROP TABLE IF EXISTS `vendor_courier_booking_audit_logs`/);
  assert.match(m38.downSql, /DROP TABLE IF EXISTS `vendor_courier_booking_requests`/);
});

test('Vendor submits courier booking request - creates pending request and audit log', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9001);
  sqliteDb.run('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', 9001);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9001, 1, 101, 'processing');

  const res = await approvalRepo.createBookingRequest({
    subOrderId: 9001,
    vendorId: 101,
    courierCode: 'steadfast',
    note: 'Fragile grocery items, handle with care',
    idempotencyKey: 'test-req-9001-a',
  });

  assert.strictEqual(res.idempotentReplay, false);
  assert.ok(res.request);
  assert.strictEqual(Number(res.request.sub_order_id), 9001);
  assert.strictEqual(Number(res.request.vendor_id), 101);
  assert.strictEqual(res.request.courier_code, 'steadfast');
  assert.strictEqual(res.request.status, 'pending');

  const audit = sqliteDb.get('SELECT * FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ? AND action = ?', 9001, 'request_created');
  assert.ok(audit, 'Audit log for request_created must exist');
  assert.strictEqual(audit.actor_type, 'vendor');
});

test('Ownership-first idempotency validation: vendor ownership checked before idempotency lookup', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9002);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9002, 1, 102, 'processing');

  // Request created by vendor 102
  const initial = await approvalRepo.createBookingRequest({
    subOrderId: 9002,
    vendorId: 102,
    courierCode: 'steadfast',
    idempotencyKey: 'idemp-key-9002',
  });
  assert.strictEqual(initial.idempotentReplay, false);

  // Unauthorized vendor 999 attempts to replay the same idempotency key for sub-order 9002
  // Must fail with AuthorizationError BEFORE returning idempotent replay!
  await assert.rejects(
    async () => {
      await approvalRepo.createBookingRequest({
        subOrderId: 9002,
        vendorId: 999, // Unauthorized
        courierCode: 'steadfast',
        idempotencyKey: 'idemp-key-9002',
      });
    },
    (err) => err instanceof AuthorizationError && err.message.includes('not authorized')
  );

  // Vendor 102 correctly replays identical key: succeeds as idempotent replay
  const replay = await approvalRepo.createBookingRequest({
    subOrderId: 9002,
    vendorId: 102,
    courierCode: 'steadfast',
    idempotencyKey: 'idemp-key-9002',
  });
  assert.strictEqual(replay.idempotentReplay, true);
  assert.strictEqual(Number(replay.request.id), Number(initial.request.id));

  // Vendor attempts to use the same idempotency key on a different sub-order (sub-order 9003)
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9003, 1, 102, 'processing');
  await assert.rejects(
    async () => {
      await approvalRepo.createBookingRequest({
        subOrderId: 9003,
        vendorId: 102,
        courierCode: 'steadfast',
        idempotencyKey: 'idemp-key-9002', // Key already belongs to sub-order 9002
      });
    },
    (err) => err instanceof ConflictError && err.message.includes('Idempotency key collision')
  );
});

test('Simultaneous vendor submissions - database constraints allow only one active request', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9005);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9005, 1, 105, 'processing');

  const results = await Promise.allSettled([
    approvalRepo.createBookingRequest({ subOrderId: 9005, vendorId: 105, courierCode: 'steadfast' }),
    approvalRepo.createBookingRequest({ subOrderId: 9005, vendorId: 105, courierCode: 'pathao' }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent vendor submission must succeed');
  assert.strictEqual(rejected.length, 1, 'Second concurrent vendor submission must be rejected');
  assert.ok(
    rejected[0].reason instanceof ConflictError,
    'Rejection must be a ConflictError indicating active request exists'
  );
});

test('Simultaneous Admin approvals - atomic state lock ensures only one admin acquires booking lock', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9006);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9006, 1, 106, 'processing');

  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9006,
    vendorId: 106,
    courierCode: 'steadfast',
  });

  const originalExecute = courierRepo.executeOneClickBooking;
  try {
    courierRepo.executeOneClickBooking = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        success: true,
        courierName: 'Steadfast Courier',
        trackingId: 'ST-9006-LOCK',
        consignmentId: 'CS-9006-LOCK',
      };
    };

    const results = await Promise.allSettled([
      approvalRepo.approveBookingRequest({ requestId: created.request.id, adminId: 1, note: 'Admin 1 attempt' }),
      approvalRepo.approveBookingRequest({ requestId: created.request.id, adminId: 2, note: 'Admin 2 attempt' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent admin approval must acquire lock and succeed');
    assert.strictEqual(rejected.length, 1, 'Second concurrent admin approval must be rejected');
    assert.ok(
      rejected[0].reason instanceof ConflictError && rejected[0].reason.message.includes('lock could not be acquired'),
      'Rejected request must indicate lock could not be acquired'
    );
  } finally {
    courierRepo.executeOneClickBooking = originalExecute;
  }
});

test('Reconciliation fail-closed: uncertain or failed reconciliation halts booking and sets in_review', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9010);
  sqliteDb.run('DELETE FROM fulfillment_shipments WHERE vendor_sub_order_id = ?', 9010);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9010, 1, 110, 'processing');

  // Insert previous ambiguous shipment in 'unknown_timeout'
  sqliteDb.run(
    'INSERT INTO fulfillment_shipments (vendor_sub_order_id, courier_code, booking_status) VALUES (?, ?, ?)',
    9010, 'steadfast', 'unknown_timeout'
  );

  const req = await approvalRepo.createBookingRequest({
    subOrderId: 9010,
    vendorId: 110,
    courierCode: 'steadfast',
  });

  const originalReconcile = courierRepo.reconcileBookingResult;
  const originalExecute = courierRepo.executeOneClickBooking;
  let bookingCallAttempted = false;

  courierRepo.executeOneClickBooking = async () => {
    bookingCallAttempted = true;
    return { success: true, trackingId: 'ST-SHOULD-NOT-BE-CALLED' };
  };

  try {
    // 1. Simulate reconciliation error/network failure:
    courierRepo.reconcileBookingResult = async () => {
      throw new Error('Carrier API timeout during reconciliation');
    };

    await assert.rejects(
      async () => {
        await approvalRepo.approveBookingRequest({ requestId: req.request.id, adminId: 1 });
      },
      (err) => err instanceof ConflictError && err.message.includes('previous provider outcome for sub-order #9010 is uncertain')
    );

    // Verify booking was NOT executed (fail-closed!)
    assert.strictEqual(bookingCallAttempted, false, 'executeOneClickBooking must NEVER be called when reconciliation fails');

    // Verify request was transitioned to 'in_review' status
    const underReviewReq = await approvalRepo.getBookingRequestById(req.request.id);
    assert.strictEqual(underReviewReq.status, 'in_review');

    // Verify audit log recorded reconciliation uncertainty
    const auditUncertain = sqliteDb.get(
      'SELECT * FROM vendor_courier_booking_audit_logs WHERE booking_request_id = ? AND action = ?',
      req.request.id, 'reconciliation_uncertain_blocked'
    );
    assert.ok(auditUncertain);

    // 2. Simulate reconciliation recovering confirmed booking from carrier
    courierRepo.reconcileBookingResult = async () => {
      return {
        reconciled: true,
        outcome: 'found',
        bookingStatus: 'succeeded',
        trackingId: 'ST-RECOVERED-9010',
        externalConsignmentId: 'CS-RECOVERED-9010',
      };
    };

    const recoverRes = await approvalRepo.approveBookingRequest({ requestId: req.request.id, adminId: 1 });
    assert.strictEqual(recoverRes.success, true);
    assert.strictEqual(recoverRes.reconciled, true);
    assert.strictEqual(recoverRes.request.status, 'booked');
    assert.strictEqual(recoverRes.request.tracking_id, 'ST-RECOVERED-9010');
    assert.strictEqual(bookingCallAttempted, false, 'No new booking call should be made when parcel is recovered');
  } finally {
    courierRepo.reconcileBookingResult = originalReconcile;
    courierRepo.executeOneClickBooking = originalExecute;
  }
});

test('Reconciliation confirmed absence: clears request for safe retry and proceeds to booking', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9011);
  sqliteDb.run('DELETE FROM fulfillment_shipments WHERE vendor_sub_order_id = ?', 9011);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9011, 1, 111, 'processing');

  sqliteDb.run(
    'INSERT INTO fulfillment_shipments (vendor_sub_order_id, courier_code, booking_status) VALUES (?, ?, ?)',
    9011, 'steadfast', 'unknown_timeout'
  );

  const req = await approvalRepo.createBookingRequest({
    subOrderId: 9011,
    vendorId: 111,
    courierCode: 'steadfast',
  });

  const originalReconcile = courierRepo.reconcileBookingResult;
  const originalExecute = courierRepo.executeOneClickBooking;
  let bookingCallAttempted = false;

  try {
    courierRepo.reconcileBookingResult = async () => {
      return {
        reconciled: true,
        outcome: 'confirmed_absent',
        bookingStatus: 'failed',
        message: 'Carrier confirmed parcel does not exist',
      };
    };

    courierRepo.executeOneClickBooking = async () => {
      bookingCallAttempted = true;
      return {
        success: true,
        courierName: 'Steadfast Courier',
        trackingId: 'ST-FRESH-9011',
        consignmentId: 'CS-FRESH-9011',
      };
    };

    const res = await approvalRepo.approveBookingRequest({ requestId: req.request.id, adminId: 1 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(bookingCallAttempted, true, 'Booking call must proceed when absence is confirmed');
    assert.strictEqual(res.request.status, 'booked');
    assert.strictEqual(res.request.tracking_id, 'ST-FRESH-9011');
  } finally {
    courierRepo.reconcileBookingResult = originalReconcile;
    courierRepo.executeOneClickBooking = originalExecute;
  }
});

test('Rejection is atomic and forbidden during active booking or after completion', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9007);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9007, 1, 107, 'processing');

  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9007,
    vendorId: 107,
    courierCode: 'pathao',
  });

  // Manually transition to 'booking' to simulate in-flight provider call
  sqliteDb.run("UPDATE vendor_courier_booking_requests SET status = 'booking' WHERE id = ?", created.request.id);

  // Attempt to reject while booking is in progress
  await assert.rejects(
    async () => {
      await approvalRepo.rejectBookingRequest({
        requestId: created.request.id,
        adminId: 1,
        rejectionReason: 'Attempt reject during in-flight booking',
      });
    },
    (err) => err instanceof ConflictError && err.message.includes('currently in progress')
  );

  // Move to 'failed' and verify rejection is allowed from failed state
  sqliteDb.run("UPDATE vendor_courier_booking_requests SET status = 'failed' WHERE id = ?", created.request.id);
  const rejectRes = await approvalRepo.rejectBookingRequest({
    requestId: created.request.id,
    adminId: 1,
    rejectionReason: 'Address unserviceable by any provider',
  });
  assert.strictEqual(rejectRes.success, true);
  assert.strictEqual(rejectRes.request.status, 'rejected');

  // Verify audit log for rejection
  const audit = sqliteDb.get('SELECT * FROM vendor_courier_booking_audit_logs WHERE booking_request_id = ? AND action = ?', created.request.id, 'request_rejected');
  assert.ok(audit);
  assert.strictEqual(audit.to_status, 'rejected');
});

test('Timeout and safe retry idempotency with stable key', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9008);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9008, 1, 108, 'processing');

  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9008,
    vendorId: 108,
    courierCode: 'steadfast',
  });

  const capturedKeys = [];
  const originalExecute = courierRepo.executeOneClickBooking;
  const originalReconcile = courierRepo.reconcileBookingResult;
  let attempt = 0;
  try {
    courierRepo.reconcileBookingResult = async () => ({
      reconciled: true,
      outcome: 'confirmed_absent',
      bookingStatus: 'failed',
      message: 'Carrier confirmed no parcel exists; cleared for safe retry.'
    });

    courierRepo.executeOneClickBooking = async ({ idempotencyKey }) => {
      capturedKeys.push(idempotencyKey);
      attempt++;
      if (attempt === 1) {
        throw new Error('Steadfast network socket timeout (ECONNRESET)');
      }
      return {
        success: true,
        courierName: 'Steadfast Courier',
        trackingId: 'ST-9008-STABLE',
        consignmentId: 'CS-9008-STABLE',
      };
    };

    // 1st attempt: fails
    await assert.rejects(
      async () => {
        await approvalRepo.approveBookingRequest({ requestId: created.request.id, adminId: 1 });
      },
      (err) => err.code === 'COURIER_BOOKING_UNCERTAIN' || err.code === 'COURIER_BOOKING_FAILED'
    );

    const afterFail = await approvalRepo.getBookingRequestById(created.request.id);
    assert.ok(['failed', 'in_review'].includes(afterFail.status));

    // 2nd attempt: succeeds
    const retryRes = await approvalRepo.approveBookingRequest({ requestId: created.request.id, adminId: 1 });
    assert.strictEqual(retryRes.success, true);
    assert.strictEqual(retryRes.request.status, 'booked');
    assert.strictEqual(retryRes.request.tracking_id, 'ST-9008-STABLE');

    // Verify idempotency key was stable across attempts
    assert.strictEqual(capturedKeys.length, 2);
    assert.strictEqual(capturedKeys[0], `vcbr:${created.request.id}:suborder:9008`);
    assert.strictEqual(capturedKeys[1], `vcbr:${created.request.id}:suborder:9008`);
    assert.strictEqual(capturedKeys[0], capturedKeys[1], 'Idempotency key must remain deterministic across retries');
  } finally {
    courierRepo.executeOneClickBooking = originalExecute;
    courierRepo.reconcileBookingResult = originalReconcile;
  }
});

test('Transactional audit logging: audit log write failure prevents state transition', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9015);
  sqliteDb.run('INSERT OR REPLACE INTO vendor_sub_orders (id, order_id, vendor_id, status) VALUES (?, ?, ?, ?)', 9015, 1, 115, 'processing');

  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9015,
    vendorId: 115,
    courierCode: 'steadfast',
  });

  const originalRecordAudit = approvalRepo.recordAuditLog;
  try {
    approvalRepo.recordAuditLog = async () => {
      throw new Error('Database disk full: audit table write failed');
    };

    await assert.rejects(
      async () => {
        await approvalRepo.rejectBookingRequest({
          requestId: created.request.id,
          adminId: 1,
          rejectionReason: 'Rejection test with failing audit log',
        });
      },
      (err) => err.message.includes('audit table write failed')
    );

    const unchanged = await approvalRepo.getBookingRequestById(created.request.id);
    assert.strictEqual(unchanged.status, 'pending', 'Status must remain pending when audit log write fails');
  } finally {
    approvalRepo.recordAuditLog = originalRecordAudit;
  }
});

test('Routes and views integration verification', () => {
  const vendorRoutes = fs.readFileSync(path.join(root, 'src/routes/vendorPanel.js'), 'utf8');
  assert.match(vendorRoutes, /\/vendor\/sub-orders\/:subOrderId\/request-courier-booking/);
  assert.match(vendorRoutes, /createBookingRequest/);

  const adminRoutes = fs.readFileSync(path.join(root, 'src/routes/adminOrders.js'), 'utf8');
  assert.match(adminRoutes, /\/admin\/courier\/requests/);
  assert.match(adminRoutes, /\/admin\/courier\/requests\/:id\/approve/);
  assert.match(adminRoutes, /\/admin\/courier\/requests\/:id\/reject/);

  const adminView = fs.readFileSync(path.join(root, 'views/admin/courier-requests.ejs'), 'utf8');
  assert.match(adminView, /rejectRequestModal/);
  assert.match(adminView, /action="\/admin\/courier\/requests\/<%= reqItem\.id %>\/approve"/);

  const vendorOrdersView = fs.readFileSync(path.join(root, 'views/vendor/orders.ejs'), 'utf8');
  assert.match(vendorOrdersView, /request-courier-booking/);
  assert.match(vendorOrdersView, /ol\.courier_request_status/);

  const adminSidebar = fs.readFileSync(path.join(root, 'views/admin/partials/sidebar.ejs'), 'utf8');
  assert.match(adminSidebar, /href="\/admin\/courier\/requests"/);
});
