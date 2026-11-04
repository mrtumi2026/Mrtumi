'use strict';

const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const SKIP = 'SKIPPED locally: no disposable MySQL/MariaDB service; required in exact database CI.';
if (REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true but MYSQL_TEST_HOST was not provided.');
if (MYSQL_HOST) {
  process.env.NODE_ENV = 'test';
  process.env.DB_CLIENT = 'mysql';
  process.env.DB_HOST = MYSQL_HOST;
  process.env.DB_PORT = String(process.env.MYSQL_TEST_PORT || 3306);
  process.env.DB_NAME = process.env.MYSQL_TEST_DB || 'mrtumi_test';
  process.env.DB_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test';
  process.env.DB_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw';
}

const { test } = require('node:test');
const assert = require('node:assert/strict');

const courierRepo = require('../src/repositories/courierIntegrationRepository');
const mysql = require('../src/db/mysqlPool');
const { resetDisposableMysqlDatabase } = require('../scripts/qa/mysql-test-database');
const { ValidationError, AuthorizationError, NotFoundError } = require('../src/utils/errors');

// ─────────────────────────────────────────────────────────────────────────────
// 1. UNIT & INPUT VALIDATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Operational Override: Input validation and Super Admin authorization guards', async () => {
  // A. Non-admin or missing actor throws AuthorizationError
  await assert.rejects(
    async () => {
      await courierRepo.resolveAmbiguousBookingOverride({
        shipmentId: 1,
        resolution: 'confirm_parcel_exists',
        providerEvidence: 'Steadfast portal confirmed #12345',
        trackingReference: 'TRK-100',
        actor: { vendorId: 5 } // Vendor cannot execute manual override
      });
    },
    (err) => {
      assert.ok(err instanceof AuthorizationError);
      assert.match(err.message, /Super Admin/i);
      return true;
    }
  );

  // B. Missing resolution or invalid resolution action throws ValidationError
  await assert.rejects(
    async () => {
      await courierRepo.resolveAmbiguousBookingOverride({
        shipmentId: 1,
        resolution: 'invalid_action',
        providerEvidence: 'Steadfast portal confirmed #12345',
        actor: { userId: 1, isSuperAdmin: true, platformAdmin: true }
      });
    },
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /confirm_parcel_exists/);
      return true;
    }
  );

  // C. Missing provider evidence or evidence shorter than 5 chars throws ValidationError
  await assert.rejects(
    async () => {
      await courierRepo.resolveAmbiguousBookingOverride({
        shipmentId: 1,
        resolution: 'confirm_parcel_absent',
        providerEvidence: 'no', // too short (< 5 chars)
        actor: { userId: 1, isSuperAdmin: true, platformAdmin: true }
      });
    },
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /Provider evidence is mandatory/);
      return true;
    }
  );

  // D. confirm_parcel_exists without trackingReference throws ValidationError
  await assert.rejects(
    async () => {
      await courierRepo.resolveAmbiguousBookingOverride({
        shipmentId: 1,
        resolution: 'confirm_parcel_exists',
        providerEvidence: 'Valid evidence reference #999',
        trackingReference: '', // missing tracking
        actor: { userId: 1, isSuperAdmin: true, platformAdmin: true }
      });
    },
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /Tracking reference is mandatory/);
      return true;
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIVE DISPOSABLE MYSQL 8.0 & MARIADB 10.11 DATABASE-BACKED TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Operational Recovery & Monitoring: Reporting, vendor isolation, audit history, and manual override', { skip: !MYSQL_HOST ? SKIP : false }, async (t) => {
  const pool = mysql.getPool();
  const db = mysql.createQueryClient(pool);
  t.after(() => mysql.closePool());
  await resetDisposableMysqlDatabase(pool);

  // 1. Seed active mock courier in courier_apis (schema contract: no created_at)
  await db.execute(`
    INSERT INTO courier_apis (code, name, provider_type, base_url, api_key, secret_key, client_id, sandbox, supports_live_quotes, status, updated_at)
    VALUES ('mock_courier', 'Mock Express Services', 'mock', 'http://localhost/mock', 'test_key', 'test_secret', 'cid', 1, 1, 1, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE status = 1, supports_live_quotes = 1
  `);

  // 2. Seed Customer
  const custRes = await db.execute(`
    INSERT INTO customers (name, email, phone, password_hash, status, created_at, updated_at)
    VALUES ('Recovery Cust', 'recovery@example.test', '01711223344', 'hash', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `);
  const custId = custRes.insertId;

  // 3. Seed two separate vendors for isolation testing
  const vendResA = await db.execute(`
    INSERT INTO vendors (shop_name, owner_name, email, phone, password_hash, status, created_at, updated_at)
    VALUES ('Vendor Shop Alpha', 'Owner Alpha', 'alpha@example.test', '01710000001', 'hash', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `);
  const vendIdA = vendResA.insertId;

  const vendResB = await db.execute(`
    INSERT INTO vendors (shop_name, owner_name, email, phone, password_hash, status, created_at, updated_at)
    VALUES ('Vendor Shop Beta', 'Owner Beta', 'beta@example.test', '01710000002', 'hash', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `);
  const vendIdB = vendResB.insertId;

  // 4. Create Order 1 & Sub-Order 1 (Vendor A) -> will trigger unknown_timeout
  const orderRes1 = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-OP-001', 'Recipient 1', '01800000000', '101 Alpha Road, Dhaka', 'Inside Dhaka', 'cod', 'unpaid', 50000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const orderId1 = orderRes1.insertId;

  const subOrderRes1 = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, vendor_order_no, status, delivery_mode, vendor_entitlement_paisa, marketplace_fee_paisa, net_payable_paisa, created_at, updated_at)
    VALUES (?, ?, 'VSO-OP-A1', 'ready_for_pickup', 'vendor_managed', 45000, 5000, 45000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [orderId1, vendIdA]);
  const subOrderId1 = subOrderRes1.insertId;

  // 5. Create Order 2 & Sub-Order 2 (Vendor B) -> will be placed in in_review state
  const orderRes2 = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-OP-002', 'Recipient 2', '01799887766', '202 Beta Street, Chittagong', 'Outside Dhaka', 'cod', 'unpaid', 75000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const orderId2 = orderRes2.insertId;

  const subOrderRes2 = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, vendor_order_no, status, delivery_mode, vendor_entitlement_paisa, marketplace_fee_paisa, net_payable_paisa, created_at, updated_at)
    VALUES (?, ?, 'VSO-OP-B1', 'ready_for_pickup', 'vendor_managed', 67500, 7500, 67500, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [orderId2, vendIdB]);
  const subOrderId2 = subOrderRes2.insertId;

  // 6. Create Order 3 & Sub-Order 3 (Vendor A) -> will succeed normally
  const orderRes3 = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-OP-003', 'Recipient 3', '01755443322', '303 Alpha Lane, Dhaka', 'Inside Dhaka', 'cod', 'unpaid', 30000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const orderId3 = orderRes3.insertId;

  const subOrderRes3 = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, vendor_order_no, status, delivery_mode, vendor_entitlement_paisa, marketplace_fee_paisa, net_payable_paisa, created_at, updated_at)
    VALUES (?, ?, 'VSO-OP-A2', 'ready_for_pickup', 'vendor_managed', 27000, 3000, 27000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [orderId3, vendIdA]);
  const subOrderId3 = subOrderRes3.insertId;

  const superAdminActor = { userId: 1, isSuperAdmin: true, platformAdmin: true };
  const vendorActorA = { vendorId: vendIdA };
  const vendorActorB = { vendorId: vendIdB };

  // Step A: Trigger timeout booking for Sub-Order 1 (phone 01800000000)
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId: subOrderId1,
        courierCode: 'mock_courier',
        actor: vendorActorA
      });
    },
    (err) => {
      assert.equal(err.code, 'COURIER_BOOKING_TIMEOUT');
      return true;
    }
  );

  const shipment1 = await db.queryOne(
    `SELECT id, booking_status, courier_code FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [subOrderId1]
  );
  assert.ok(shipment1);
  assert.equal(shipment1.booking_status, 'unknown_timeout');
  assert.equal(shipment1.courier_code, 'mock_courier');

  // Step B: Set up Sub-Order 2 shipment in 'in_review' status
  const shipRes2 = await db.execute(
    `INSERT INTO fulfillment_shipments (vendor_sub_order_id, courier_code, tracking_id, status, booking_status, created_at, updated_at)
     VALUES (?, 'mock_courier', 'MCK-REV-002', 'ready_for_pickup', 'in_review', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [subOrderId2]
  );
  const shipmentId2 = shipRes2.insertId;

  // Step C: Book Sub-Order 3 successfully
  const bookSuccess3 = await courierRepo.executeOneClickBooking({
    subOrderId: subOrderId3,
    courierCode: 'mock_courier',
    actor: vendorActorA
  });
  assert.equal(bookSuccess3.success, true);
  assert.ok(bookSuccess3.trackingId.startsWith('MCK-'));

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: Ambiguous Shipment Monitoring & Reporting
  // ─────────────────────────────────────────────────────────────────────────

  // Admin query returns both ambiguous shipments (subOrderId1 and subOrderId2), excluding succeeded subOrderId3
  const adminListing = await courierRepo.listAmbiguousShipments({
    actor: superAdminActor
  });
  assert.equal(adminListing.pagination.total, 2, 'Total ambiguous shipments must be 2');
  assert.equal(adminListing.shipments.length, 2);

  const subOrderIdsInListing = adminListing.shipments.map(s => s.vendor_sub_order_id);
  assert.ok(subOrderIdsInListing.includes(subOrderId1));
  assert.ok(subOrderIdsInListing.includes(subOrderId2));
  assert.ok(!subOrderIdsInListing.includes(subOrderId3), 'Succeeded shipment must not appear in ambiguous list');

  // Filter by status = 'unknown_timeout'
  const timeoutListing = await courierRepo.listAmbiguousShipments({
    status: 'unknown_timeout',
    actor: superAdminActor
  });
  assert.equal(timeoutListing.shipments.length, 1);
  assert.equal(timeoutListing.shipments[0].vendor_sub_order_id, subOrderId1);

  // Filter by status = 'in_review'
  const inReviewListing = await courierRepo.listAmbiguousShipments({
    status: 'in_review',
    actor: superAdminActor
  });
  assert.equal(inReviewListing.shipments.length, 1);
  assert.equal(inReviewListing.shipments[0].vendor_sub_order_id, subOrderId2);

  // Age calculation verification
  const item1 = adminListing.shipments.find(s => s.vendor_sub_order_id === subOrderId1);
  assert.ok(Number(item1.age_minutes) >= 0);
  assert.equal(typeof item1.is_stalled, 'boolean');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Vendor Isolation & Cross-Vendor Protection
  // ─────────────────────────────────────────────────────────────────────────

  // Vendor A listing returns ONLY Vendor A's shipment (subOrderId1)
  const vendorAListing = await courierRepo.listAmbiguousShipments({
    actor: vendorActorA
  });
  assert.equal(vendorAListing.pagination.total, 1);
  assert.equal(vendorAListing.shipments[0].vendor_sub_order_id, subOrderId1);
  assert.equal(vendorAListing.shipments[0].vendor_id, vendIdA);

  // Vendor B listing returns ONLY Vendor B's shipment (subOrderId2)
  const vendorBListing = await courierRepo.listAmbiguousShipments({
    actor: vendorActorB
  });
  assert.equal(vendorBListing.pagination.total, 1);
  assert.equal(vendorBListing.shipments[0].vendor_sub_order_id, subOrderId2);
  assert.equal(vendorBListing.shipments[0].vendor_id, vendIdB);

  // Vendor A trying to snoop Vendor B's audit trail strictly throws AuthorizationError
  await assert.rejects(
    async () => {
      await courierRepo.getShipmentAuditTrail({
        shipmentId: shipmentId2,
        actor: vendorActorA
      });
    },
    (err) => {
      assert.ok(err instanceof AuthorizationError);
      return true;
    }
  );

  // Super Admin can view audit trail for any shipment
  const adminAuditTrail = await courierRepo.getShipmentAuditTrail({
    shipmentId: shipment1.id,
    actor: superAdminActor
  });
  assert.ok(adminAuditTrail.shipment);
  assert.equal(adminAuditTrail.shipment.id, shipment1.id);
  assert.ok(Array.isArray(adminAuditTrail.events));
  assert.ok(adminAuditTrail.events.length >= 1);
  assert.equal(adminAuditTrail.events[0].resultCode, 'timeout');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: Repeated Idempotent Reconciliation
  // ─────────────────────────────────────────────────────────────────────────

  // First reconciliation on subOrderId1 (inconclusive outcome: unknown_error)
  const rec1 = await courierRepo.reconcileBookingResult({
    subOrderId: subOrderId1,
    actor: superAdminActor
  });
  assert.equal(rec1.outcome, 'unknown_error');
  assert.equal(rec1.reconciled, false);

  // Second reconciliation attempt
  const rec2 = await courierRepo.reconcileBookingResult({
    subOrderId: subOrderId1,
    actor: superAdminActor
  });
  assert.equal(rec2.outcome, 'unknown_error');
  assert.equal(rec2.reconciled, false);

  // Verify shipment remains in unknown_timeout and booking is STILL blocked
  const checkBlocked = await db.queryOne(
    `SELECT booking_status FROM fulfillment_shipments WHERE id = ?`,
    [shipment1.id]
  );
  assert.equal(checkBlocked.booking_status, 'unknown_timeout');

  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId: subOrderId1,
        courierCode: 'mock_courier',
        actor: vendorActorA
      });
    },
    (err) => {
      assert.match(err.message, /ambiguous state/);
      return true;
    }
  );

  // Listing reflects multiple reconciliation attempts
  const updatedListing = await courierRepo.listAmbiguousShipments({
    actor: superAdminActor
  });
  const updatedItem1 = updatedListing.shipments.find(s => s.vendor_sub_order_id === subOrderId1);
  assert.ok(updatedItem1.reconciliation_attempts >= 2);

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 4: Super Admin Manual Override with Provider Evidence
  // ─────────────────────────────────────────────────────────────────────────

  // 4A: Super Admin verifies parcel exists on carrier portal (confirm_parcel_exists)
  const overrideExistsResult = await courierRepo.resolveAmbiguousBookingOverride({
    shipmentId: shipment1.id,
    resolution: 'confirm_parcel_exists',
    providerEvidence: 'Steadfast Merchant Portal Ticket #887766: Support verified parcel created',
    trackingReference: 'SF-OVR-887766',
    note: 'Verified with Steadfast agent Rahim',
    actor: superAdminActor
  });

  assert.equal(overrideExistsResult.success, true);
  assert.equal(overrideExistsResult.bookingStatus, 'succeeded');
  assert.equal(overrideExistsResult.trackingId, 'SF-OVR-887766');

  // Verify DB state
  const shipmentAfterOverrideExists = await db.queryOne(
    `SELECT booking_status, tracking_id FROM fulfillment_shipments WHERE id = ?`,
    [shipment1.id]
  );
  assert.equal(shipmentAfterOverrideExists.booking_status, 'succeeded');
  assert.equal(shipmentAfterOverrideExists.tracking_id, 'SF-OVR-887766');

  // Verify Audit Trail has recorded the manual_override event
  const auditExists = await courierRepo.getShipmentAuditTrail({
    shipmentId: shipment1.id,
    actor: superAdminActor
  });
  const lastEvent = auditExists.events[auditExists.events.length - 1];
  assert.equal(lastEvent.eventType, 'manual_override');
  assert.equal(lastEvent.resultCode, 'succeeded');
  assert.match(lastEvent.note, /Steadfast Merchant Portal Ticket #887766/);

  // Attempting to re-book now fails with 'already booked'
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId: subOrderId1,
        courierCode: 'mock_courier',
        actor: vendorActorA
      });
    },
    (err) => {
      assert.match(err.message, /already booked/);
      return true;
    }
  );

  // 4B: Super Admin verifies parcel does NOT exist on carrier portal (confirm_parcel_absent)
  // for Sub-Order 2 (which was in in_review)
  const overrideAbsentResult = await courierRepo.resolveAmbiguousBookingOverride({
    shipmentId: shipmentId2,
    resolution: 'confirm_parcel_absent',
    providerEvidence: 'RedX Support confirmed ticket #112233: Zero parcel records found',
    note: 'Safe retry authorized by Operations Lead',
    actor: superAdminActor
  });

  assert.equal(overrideAbsentResult.success, true);
  assert.equal(overrideAbsentResult.bookingStatus, 'failed');

  // Verify DB state
  const shipmentAfterOverrideAbsent = await db.queryOne(
    `SELECT booking_status FROM fulfillment_shipments WHERE id = ?`,
    [shipmentId2]
  );
  assert.equal(shipmentAfterOverrideAbsent.booking_status, 'failed');

  // Safe retry is now UNLOCKED!
  const retrySubOrder2 = await courierRepo.executeOneClickBooking({
    subOrderId: subOrderId2,
    courierCode: 'mock_courier',
    actor: vendorActorB
  });
  assert.equal(retrySubOrder2.success, true);
  assert.ok(retrySubOrder2.trackingId.startsWith('MCK-'));

  const finalShipment2 = await db.queryOne(
    `SELECT booking_status, tracking_id FROM fulfillment_shipments WHERE id = ?`,
    [shipmentId2]
  );
  assert.equal(finalShipment2.booking_status, 'succeeded');
  assert.equal(finalShipment2.tracking_id, retrySubOrder2.trackingId);

  // Verify ambiguous listing now has ZERO ambiguous shipments left!
  const emptyListing = await courierRepo.listAmbiguousShipments({
    actor: superAdminActor
  });
  assert.equal(emptyListing.pagination.total, 0);
  assert.equal(emptyListing.shipments.length, 0);
});
