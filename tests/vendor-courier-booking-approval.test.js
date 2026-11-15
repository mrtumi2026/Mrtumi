'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const approvalRepo = require('../src/repositories/vendorCourierApprovalRepository');
const courierRepo = require('../src/repositories/courierIntegrationRepository');
const { ConflictError, ValidationError, NotFoundError, AuthorizationError } = require('../src/utils/errors');
const sqliteDb = require('../src/db/database');

const root = path.join(__dirname, '..');

test('vendorCourierApprovalRepository - ensureTable creates schema cleanly', async () => {
  await approvalRepo.ensureTable();
  const info = sqliteDb.all("PRAGMA table_info('vendor_courier_booking_requests')");
  assert.ok(info.length > 0, 'Table vendor_courier_booking_requests must exist');
  const colNames = info.map((c) => c.name);
  for (const expected of ['id', 'sub_order_id', 'order_id', 'vendor_id', 'courier_code', 'status', 'tracking_id', 'rejection_reason', 'failure_reason', 'idempotency_key']) {
    assert.ok(colNames.includes(expected), `Column ${expected} must exist`);
  }
});

test('Vendor submits courier booking request - creates pending request', async () => {
  // Clear any existing test records
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9001);

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
  assert.strictEqual(res.request.vendor_notes, 'Fragile grocery items, handle with care');
});

test('Idempotency protection - duplicate submission returns existing request', async () => {
  const res = await approvalRepo.createBookingRequest({
    subOrderId: 9001,
    vendorId: 101,
    courierCode: 'steadfast',
    note: 'Duplicate attempt',
    idempotencyKey: 'test-req-9001-a',
  });

  assert.strictEqual(res.idempotentReplay, true);
  assert.strictEqual(res.request.status, 'pending');
});

test('Duplicate request prevention - cannot create second pending request for same sub-order', async () => {
  await assert.rejects(
    async () => {
      await approvalRepo.createBookingRequest({
        subOrderId: 9001,
        vendorId: 101,
        courierCode: 'pathao',
        idempotencyKey: 'different-key-9001',
      });
    },
    (err) => err instanceof ConflictError && err.message.includes('already pending')
  );
});

test('Admin lists booking requests with filtering and pagination', async () => {
  const list = await approvalRepo.listBookingRequests({ status: 'pending', page: 1, perPage: 10 });
  assert.ok(list.requests);
  assert.ok(list.pagination);
  assert.ok(list.requests.some((r) => Number(r.sub_order_id) === 9001));
});

test('Admin rejects booking request with recorded reason', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9002);
  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9002,
    vendorId: 102,
    courierCode: 'steadfast',
    idempotencyKey: 'test-req-9002',
  });

  const rejectRes = await approvalRepo.rejectBookingRequest({
    requestId: created.request.id,
    adminId: 1,
    rejectionReason: 'Invalid delivery address provided',
    note: 'Customer phone unreachable',
  });

  assert.strictEqual(rejectRes.success, true);
  assert.strictEqual(rejectRes.request.status, 'rejected');
  assert.strictEqual(rejectRes.request.rejection_reason, 'Invalid delivery address provided');

  // Vendor is now permitted to submit a new request after rejection
  const retryRes = await approvalRepo.createBookingRequest({
    subOrderId: 9002,
    vendorId: 102,
    courierCode: 'pathao',
    note: 'Updated address confirmed with customer',
    idempotencyKey: 'test-req-9002-retry',
  });
  assert.strictEqual(retryRes.request.status, 'pending');
});

test('Admin approves booking request - triggers courier integration and marks booked', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9003);
  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9003,
    vendorId: 103,
    courierCode: 'steadfast',
    idempotencyKey: 'test-req-9003',
  });

  // Mock courierRepo.executeOneClickBooking for unit test execution
  const originalExecute = courierRepo.executeOneClickBooking;
  try {
    courierRepo.executeOneClickBooking = async ({ subOrderId, courierCode, actor }) => {
      assert.strictEqual(actor.platformAdmin, true);
      return {
        success: true,
        courierName: 'Steadfast Courier',
        trackingId: 'ST-9003-TRACK',
        consignmentId: 'CS-9003-CONSIGN',
      };
    };

    const approveRes = await approvalRepo.approveBookingRequest({
      requestId: created.request.id,
      adminId: 1,
      note: 'Verified and approved by operations lead',
    });

    assert.strictEqual(approveRes.success, true);
    assert.strictEqual(approveRes.request.status, 'booked');
    assert.strictEqual(approveRes.request.tracking_id, 'ST-9003-TRACK');
    assert.strictEqual(approveRes.request.consignment_id, 'CS-9003-CONSIGN');

    // Attempting to approve an already booked request throws ConflictError
    await assert.rejects(
      async () => {
        await approvalRepo.approveBookingRequest({ requestId: created.request.id, adminId: 1 });
      },
      (err) => err instanceof ConflictError && err.message.includes('already been booked')
    );

    // Attempting to reject an already booked request throws ConflictError
    await assert.rejects(
      async () => {
        await approvalRepo.rejectBookingRequest({ requestId: created.request.id, adminId: 1, rejectionReason: 'Too late' });
      },
      (err) => err instanceof ConflictError && err.message.includes('already booked')
    );
  } finally {
    courierRepo.executeOneClickBooking = originalExecute;
  }
});

test('Courier API failure preserves request with failed status and allows safe retry', async () => {
  sqliteDb.run('DELETE FROM vendor_courier_booking_requests WHERE sub_order_id = ?', 9004);
  const created = await approvalRepo.createBookingRequest({
    subOrderId: 9004,
    vendorId: 104,
    courierCode: 'pathao',
    idempotencyKey: 'test-req-9004',
  });

  const originalExecute = courierRepo.executeOneClickBooking;
  let attemptCount = 0;
  try {
    // 1st attempt: simulate network timeout / API error
    courierRepo.executeOneClickBooking = async () => {
      attemptCount++;
      if (attemptCount === 1) {
        throw new Error('Pathao API gateway timeout (504)');
      }
      return {
        success: true,
        courierName: 'Pathao Courier',
        trackingId: 'PTH-9004-OK',
        consignmentId: 'PTH-9004-OK',
      };
    };

    await assert.rejects(
      async () => {
        await approvalRepo.approveBookingRequest({ requestId: created.request.id, adminId: 1 });
      },
      (err) => err.code === 'COURIER_BOOKING_FAILED' && err.message.includes('Pathao API gateway timeout')
    );

    const failedReq = await approvalRepo.getBookingRequestById(created.request.id);
    assert.strictEqual(failedReq.status, 'failed');
    assert.ok(failedReq.failure_reason.includes('Pathao API gateway timeout'));

    // 2nd attempt: safe retry succeeds without duplicate request
    const retryRes = await approvalRepo.approveBookingRequest({ requestId: created.request.id, adminId: 1 });
    assert.strictEqual(retryRes.success, true);
    assert.strictEqual(retryRes.request.status, 'booked');
    assert.strictEqual(retryRes.request.tracking_id, 'PTH-9004-OK');
    assert.strictEqual(retryRes.request.failure_reason, null);
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
