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

// Initialize SQLite tables and partial unique index for test execution
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
  CREATE UNIQUE INDEX IF NOT EXISTS uq_active_sub_order ON vendor_courier_booking_requests(sub_order_id)
    WHERE status IN ('pending', 'booking', 'booked');

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
  assert.match(m38.upSql, /UNIQUE KEY `uq_vcbr_active_sub_order`/);
  assert.match(m38.upSql, /CREATE TABLE IF NOT EXISTS `vendor_courier_booking_audit_logs`/);

  // Verify DOWN SQL rollback
  assert.match(m38.downSql, /DROP TABLE IF EXISTS `vendor_courier_booking_audit_logs`/);
  assert.match(m38.downSql, /DROP TABLE IF EXISTS `vendor_courier_booking_requests`/);
});

test('Vendor submits courier booking request - creates pending request and audit log', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9001);
  sqliteDb.run('DELETE FROM vendor_courier_booking_audit_logs WHERE sub_order_id = ?', 9001);

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

test('Simultaneous vendor submissions - database constraints allow only one active request', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9005);

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
  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9006,
    vendorId: 106,
    courierCode: 'steadfast',
  });

  const originalExecute = courierRepo.executeOneClickBooking;
  try {
    courierRepo.executeOneClickBooking = async () => {
      // Simulate delay in courier provider API response
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

test('Rejection is atomic and forbidden during active booking or after completion', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9007);
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
  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9008,
    vendorId: 108,
    courierCode: 'steadfast',
  });

  const capturedKeys = [];
  const originalExecute = courierRepo.executeOneClickBooking;
  let attempt = 0;
  try {
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
      (err) => err.code === 'COURIER_BOOKING_FAILED'
    );

    const afterFail = await approvalRepo.getBookingRequestById(created.request.id);
    assert.strictEqual(afterFail.status, 'failed');

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
