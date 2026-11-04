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
const path = require('node:path');
const fs = require('node:fs');

const { loadMigrationPairs } = require('../src/db/migrator');
const CourierBaseAdapter = require('../src/services/courier/CourierBaseAdapter');
const MockCourierAdapter = require('../src/services/courier/adapters/MockCourierAdapter');
const SteadfastAdapter = require('../src/services/courier/adapters/SteadfastAdapter');
const PathaoAdapter = require('../src/services/courier/adapters/PathaoAdapter');
const RedxAdapter = require('../src/services/courier/adapters/RedxAdapter');
const CourierProviderFactory = require('../src/services/courier/CourierProviderFactory');
const CourierRecommendationEngine = require('../src/services/courier/CourierRecommendationEngine');
const courierRepo = require('../src/repositories/courierIntegrationRepository');
const bn = require('../src/i18n/locales/bn');
const en = require('../src/i18n/locales/en');
const mysql = require('../src/db/mysqlPool');
const { resetDisposableMysqlDatabase } = require('../scripts/qa/mysql-test-database');

const root = path.join(__dirname, '..');

test('Migration 0029 defines multi-courier provider and shipment quote tracking schema changes', () => {
  const pairs = loadMigrationPairs();
  const m29 = pairs.find((pair) => pair.version === '0029');
  assert.ok(m29, 'Migration 0029 pair must be loaded');

  // Verify upSql
  assert.match(m29.upSql, /ALTER TABLE `courier_apis`/);
  assert.match(m29.upSql, /ADD COLUMN `provider_type` VARCHAR\(32\)/);
  assert.match(m29.upSql, /ADD COLUMN `webhook_token` VARCHAR\(120\)/);
  assert.match(m29.upSql, /ADD COLUMN `supports_live_quotes` TINYINT\(1\)/);
  assert.match(m29.upSql, /ADD COLUMN `service_options_json` TEXT/);

  assert.match(m29.upSql, /ALTER TABLE `fulfillment_shipments`/);
  assert.match(m29.upSql, /ADD COLUMN `quoted_charge_paisa` BIGINT UNSIGNED/);
  assert.match(m29.upSql, /ADD COLUMN `booking_idempotency_key` VARCHAR\(120\)/);
  assert.match(m29.upSql, /ADD COLUMN `recommendation_snapshot_json` TEXT/);
  assert.match(m29.upSql, /ADD COLUMN `booking_response_json` TEXT/);
  assert.match(m29.upSql, /ADD COLUMN `external_consignment_id` VARCHAR\(120\)/);

  // Verify reversible downSql
  assert.match(m29.downSql, /DROP COLUMN `provider_type`/);
  assert.match(m29.downSql, /DROP COLUMN `booking_idempotency_key`/);
});

test('Courier Provider Factory correctly instantiates appropriate adapters', () => {
  const sf = CourierProviderFactory.createAdapter({ code: 'steadfast', provider_type: 'steadfast' });
  assert.ok(sf instanceof SteadfastAdapter);

  const pathao = CourierProviderFactory.createAdapter({ code: 'pathao_express', provider_type: 'pathao' });
  assert.ok(pathao instanceof PathaoAdapter);

  const redx = CourierProviderFactory.createAdapter({ code: 'redx', provider_type: 'redx' });
  assert.ok(redx instanceof RedxAdapter);

  const mock = CourierProviderFactory.createAdapter({ code: 'mock_test', provider_type: 'mock' });
  assert.ok(mock instanceof MockCourierAdapter);
});

test('Mock Courier Adapter generates accurate quotes, handles serviceability, and simulates booking', async () => {
  const adapter = new MockCourierAdapter({ code: 'mock_std', name: 'Mock Express', rate_profile: 'express' });

  // Inside Dhaka quote
  const quoteDhaka = await adapter.getQuote({
    origin: { city: 'Dhaka' },
    destination: { district: 'Dhaka', city: 'Dhaka' },
    weightGrams: 2000,
    codAmountPaisa: 50000 // ৳500 COD
  });

  assert.equal(quoteDhaka.available, true);
  assert.equal(quoteDhaka.chargePaisa, 12000); // ৳100 base + ৳20 extra kg = ৳120 = 12000 paisa
  assert.equal(quoteDhaka.codFeePaisa, 500); // 1% of 50000 = 500 paisa
  assert.equal(quoteDhaka.isLiveQuote, true);
  assert.equal(quoteDhaka.estimatedDaysMin, 1);

  // Serviceability check for unserviceable zone
  const unserviceable = await adapter.getQuote({
    origin: { city: 'Dhaka' },
    destination: { district: 'unserviceable_zone' }
  });
  assert.equal(unserviceable.available, false);
  assert.match(unserviceable.reasonUnavailable, /outside delivery network/);

  // Successful booking in sandbox
  const booking = await adapter.bookShipment({
    subOrderId: 101,
    invoiceNo: 'INV-101',
    recipient: { name: 'Customer Test', phone: '01700000000', address: 'Dhanmondi, Dhaka' },
    codAmountPaisa: 50000,
    idempotencyKey: 'idemp-101-1'
  });

  assert.equal(booking.success, true);
  assert.ok(booking.trackingId.startsWith('MCK-'));
  assert.ok(booking.consignmentId.startsWith('CN-101-'));

  // Simulated failure with trigger phone
  const failedBooking = await adapter.bookShipment({
    subOrderId: 102,
    invoiceNo: 'INV-102',
    recipient: { name: 'Rejection Test', phone: '01999999999', address: 'Dhanmondi, Dhaka' }
  });
  assert.equal(failedBooking.success, false);
  assert.match(failedBooking.error, /Simulated courier booking rejection/);
});

test('Steadfast and RedX adapters report contract tariff without fabricating live quotes', async () => {
  const sf = new SteadfastAdapter({ code: 'steadfast', name: 'Steadfast Courier' });
  const quote = await sf.getQuote({
    origin: { city: 'Dhaka' },
    destination: { district: 'Dhaka' },
    weightGrams: 1000,
    codAmountPaisa: 0
  });

  assert.equal(quote.available, true);
  assert.equal(quote.chargePaisa, 6000); // ৳60 for Dhaka
  assert.equal(quote.isLiveQuote, false, 'Steadfast must transparently declare tariff schedule rather than faking live quote');
  assert.match(quote.notes, /contract tariff schedule/);

  const redx = new RedxAdapter({ code: 'redx', name: 'RedX Courier' });
  const redxQuote = await redx.getQuote({
    origin: { city: 'Dhaka' },
    destination: { district: 'Chittagong' },
    weightGrams: 1000
  });
  assert.equal(redxQuote.available, true);
  assert.equal(redxQuote.chargePaisa, 13000); // ৳130 Outside Dhaka
  assert.equal(redxQuote.isLiveQuote, false);
});

test('Intelligent Recommendation Engine evaluates quotes, ranks options, and provides transparent explanations', () => {
  const quotes = [
    {
      providerCode: 'fast_courier',
      providerName: 'Fast Courier',
      available: true,
      chargePaisa: 8000, // ৳80
      codFeePaisa: 0,
      estimatedDaysMin: 1,
      estimatedDaysMax: 1,
      isLiveQuote: true,
      serviceType: 'express'
    },
    {
      providerCode: 'budget_courier',
      providerName: 'Budget Courier',
      available: true,
      chargePaisa: 6000, // ৳60
      codFeePaisa: 0,
      estimatedDaysMin: 3,
      estimatedDaysMax: 4,
      isLiveQuote: false,
      serviceType: 'budget'
    },
    {
      providerCode: 'unsupported_courier',
      providerName: 'Unsupported Courier',
      available: false,
      chargePaisa: 0,
      reasonUnavailable: 'Remote zone not supported'
    }
  ];

  const evaluation = CourierRecommendationEngine.evaluateQuotes(quotes, { isCod: false });
  assert.ok(evaluation.recommendedQuote, 'Must produce a recommendation');
  assert.ok(evaluation.reasonBn.length > 0, 'Must have Bangla explanation');
  assert.ok(evaluation.reasonEn.length > 0, 'Must have English explanation');
  assert.equal(evaluation.unserviceable.length, 1);
  assert.equal(evaluation.unserviceable[0].providerCode, 'unsupported_courier');
  assert.ok(evaluation.alternatives.length >= 1);
  assert.ok(evaluation.alternatives[0].tradeOffBn.length > 0, 'Must have comparative trade-off description');
});

test('Localization contains all necessary multi-courier and booking keys in both bn.js and en.js', () => {
  const requiredKeys = [
    'compareAndBookCourier',
    'recommendedCourier',
    'whyRecommended',
    'deliveryCharge',
    'estimatedDays',
    'bookNow',
    'alternativeCouriers',
    'tradeOff',
    'liveQuote',
    'tariffSchedule',
    'manualBookingEntry',
    'syncTracking'
  ];

  for (const k of requiredKeys) {
    assert.ok(bn.vendorFulfillment[k], `Missing Bengali key: vendorFulfillment.${k}`);
    assert.ok(en.vendorFulfillment[k], `Missing English key: vendorFulfillment.${k}`);
  }
});

test('Admin and Vendor routes have multi-courier quote, one-click booking, and tracking endpoints protected by CSRF and RBAC', () => {
  const adminRoutes = fs.readFileSync(path.join(root, 'src/routes/adminOrders.js'), 'utf8');
  assert.match(adminRoutes, /\/admin\/fulfillment\/sub-orders\/:subOrderId\/courier-quotes/);
  assert.match(adminRoutes, /\/admin\/fulfillment\/sub-orders\/:subOrderId\/one-click-book[\s\S]*?requirePermission\('orders\.manage'\)[\s\S]*?requireCsrf/);
  assert.match(adminRoutes, /\/admin\/fulfillment\/sub-orders\/:subOrderId\/track-sync/);

  const vendorRoutes = fs.readFileSync(path.join(root, 'src/routes/vendorPanel.js'), 'utf8');
  assert.match(vendorRoutes, /\/vendor\/sub-orders\/:subOrderId\/courier-quotes/);
  assert.match(vendorRoutes, /\/vendor\/sub-orders\/:subOrderId\/one-click-book[\s\S]*?requireCsrf/);
  assert.match(vendorRoutes, /\/vendor\/sub-orders\/:subOrderId\/track-sync/);
});

test('Vendor view includes compare & book modal, recommendation view, and preserves handover separation', () => {
  const vendorView = fs.readFileSync(path.join(root, 'views/vendor/orders.ejs'), 'utf8');
  assert.match(vendorView, /openCourierCompareModal/);
  assert.match(vendorView, /id="courierCompareModal"/);
  assert.match(vendorView, /recommendedCourier/);
  assert.match(vendorView, /confirmHandover/);
  assert.match(vendorView, /syncTracking/);
});

test('CourierBaseAdapter sanitization redacts sensitive credentials without corrupting tracking identifiers', () => {
  const rawPayload = {
    api_key: 'secret_key_12345',
    secret_key: 'top_secret_67890',
    bearer_token: 'jwt.token.here',
    consignment_id: 'CN-987654',
    tracking_code: 'TRK-12345',
    invoice: 'INV-1001',
    merchant_order_id: 'SUB-2002',
    nested: {
      auth_password: 'mypassword',
      status: 'success',
      sub_tracking: 'TRK-NESTED'
    }
  };

  const sanitized = CourierBaseAdapter.sanitize(rawPayload);
  assert.equal(sanitized.api_key, '[REDACTED]');
  assert.equal(sanitized.secret_key, '[REDACTED]');
  assert.equal(sanitized.bearer_token, '[REDACTED]');
  assert.equal(sanitized.nested.auth_password, '[REDACTED]');

  // Vital reconciliation identifiers must remain accessible
  assert.equal(sanitized.consignment_id, 'CN-987654');
  assert.equal(sanitized.tracking_code, 'TRK-12345');
  assert.equal(sanitized.invoice, 'INV-1001');
  assert.equal(sanitized.merchant_order_id, 'SUB-2002');
  assert.equal(sanitized.nested.status, 'success');
  assert.equal(sanitized.nested.sub_tracking, 'TRK-NESTED');
});

test('Phone and address validation prevents malformed booking payloads to courier APIs', async () => {
  const sf = new SteadfastAdapter({ code: 'steadfast', api_key: 'dummy', secret_key: 'dummy' });
  const pathao = new PathaoAdapter({ code: 'pathao', api_key: 'dummy' });

  // Invalid phone test for Steadfast
  const badPhoneBooking = await sf.bookShipment({
    subOrderId: 101,
    invoiceNo: 'INV-1',
    recipient: { name: 'Customer', phone: '12345', address: 'Dhanmondi, Dhaka' }
  });
  assert.equal(badPhoneBooking.success, false);
  assert.match(badPhoneBooking.error, /Invalid Bangladesh recipient phone number format/);

  // Short address test for Pathao (< 10 chars)
  const shortAddressBooking = await pathao.bookShipment({
    subOrderId: 102,
    invoiceNo: 'INV-2',
    recipient: { name: 'Customer', phone: '01712345678', address: 'Dhaka' }
  });
  assert.equal(shortAddressBooking.success, false);
  assert.match(shortAddressBooking.error, /at least 10 characters/);
});

test('Tri-state reconciliation distinguishes found, confirmed_absent, and unknown_error; misses are never assumed absent', async () => {
  const mock = new MockCourierAdapter({ code: 'mock_test', api_key: 'test_key' });

  // 1. Timeout & Unknown outcome simulation on booking
  const timeoutResult = await mock.bookShipment({
    subOrderId: 201,
    recipient: { phone: '01800000000' }
  });
  assert.equal(timeoutResult.success, false);
  assert.equal(timeoutResult.isTimeout, true);

  const unknownResult = await mock.bookShipment({
    subOrderId: 202,
    recipient: { phone: '01811111111' }
  });
  assert.equal(unknownResult.success, false);
  assert.equal(unknownResult.isUnknownOutcome, true);

  // 2. Case A: Found outcome
  const recFound = await mock.reconcileBooking({ invoiceNo: 'INV-REC-FOUND-123' });
  assert.equal(recFound.outcome, 'found');
  assert.equal(recFound.found, true);
  assert.equal(recFound.confirmedAbsent, false);
  assert.ok(recFound.trackingId.startsWith('MCK-REC-'));

  // 3. Case B: Confirmed absent outcome (provider explicitly verifies no parcel was created)
  const recAbsent = await mock.reconcileBooking({ invoiceNo: 'INV-REC-ABSENT-456' });
  assert.equal(recAbsent.outcome, 'confirmed_absent');
  assert.equal(recAbsent.found, false);
  assert.equal(recAbsent.confirmedAbsent, true);

  // 4. Case C: Unknown error / Inconclusive (lookup miss is NOT confirmed absence)
  const recInconclusive = await mock.reconcileBooking({ invoiceNo: 'INV-OTHER-789' });
  assert.equal(recInconclusive.outcome, 'unknown_error');
  assert.equal(recInconclusive.found, false);
  assert.equal(recInconclusive.confirmedAbsent, false);
  assert.match(recInconclusive.error, /inconclusive/i);

  // 5. Steadfast and Pathao adapters never treat unverified lookup misses as confirmed absence
  const sf = new SteadfastAdapter({ code: 'steadfast', api_key: 'key', secret_key: 'sec', sandbox: 1 });
  const sfRec = await sf.reconcileBooking({ invoiceNo: 'INV-999' });
  assert.equal(sfRec.outcome, 'unknown_error');
  assert.equal(sfRec.confirmedAbsent, false);

  const pathao = new PathaoAdapter({ code: 'pathao', api_key: 'tok', sandbox: 1 });
  const pathaoRec = await pathao.reconcileBooking({ invoiceNo: 'INV-888' });
  assert.equal(pathaoRec.outcome, 'unknown_error');
  assert.equal(pathaoRec.confirmedAbsent, false);
});

test('Live disposable MySQL/MariaDB: timeout persistence, duplicate booking prevention, tri-state reconciliation and retry gating', { skip: !MYSQL_HOST ? SKIP : false }, async (t) => {
  const pool = mysql.getPool();
  const db = mysql.createQueryClient(pool);
  t.after(() => mysql.closePool());
  await resetDisposableMysqlDatabase(pool);

  // 1. Seed active mock courier in courier_apis
  await db.execute(`
    INSERT INTO courier_apis (code, name, provider_type, base_url, api_key, secret_key, client_id, sandbox, supports_live_quotes, status, created_at, updated_at)
    VALUES ('mock_courier', 'Mock Express Services', 'mock', 'http://localhost/mock', 'test_key', 'test_secret', 'cid', 1, 1, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE status = 1, supports_live_quotes = 1
  `);

  // 2. Seed customer, vendor, order, and vendor_sub_order in ready_for_pickup status
  const custRes = await db.execute(`
    INSERT INTO customers (name, email, phone, status, created_at, updated_at)
    VALUES ('Test Customer', 'cust@example.test', '01712345678', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `);
  const custId = custRes.insertId;

  const vendRes = await db.execute(`
    INSERT INTO vendors (shop_name, owner_name, email, phone, status, created_at, updated_at)
    VALUES ('Test Vendor Shop', 'Vendor Owner', 'vendor@example.test', '01787654321', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `);
  const vendId = vendRes.insertId;

  const orderRes = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-REC-TEST', 'Test Recipient', '01800000000', '123 Test Street, Dhanmondi', 'Inside Dhaka', 'cod', 'unpaid', 50000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const orderId = orderRes.insertId;

  const subOrderRes = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, status, subtotal_paisa, commission_paisa, vendor_payout_paisa, delivery_mode, booking_status, created_at, updated_at)
    VALUES (?, ?, 'ready_for_pickup', 50000, 5000, 45000, 'vendor_managed', NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [orderId, vendId]);
  const subOrderId = subOrderRes.insertId;

  const actor = { vendorId: vendId };

  // Step A: Attempt booking that triggers timeout (recipient phone 01800000000)
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId,
        courierCode: 'mock_courier',
        actor
      });
    },
    (err) => {
      assert.equal(err.code, 'COURIER_BOOKING_TIMEOUT');
      return true;
    }
  );

  // Step B: Verify timeout persistence in database
  const shipmentAfterTimeout = await db.queryOne(
    `SELECT booking_status, courier_code FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [subOrderId]
  );
  assert.ok(shipmentAfterTimeout, 'Shipment record must exist');
  assert.equal(shipmentAfterTimeout.booking_status, 'unknown_timeout');

  const timeoutEvent = await db.queryOne(
    `SELECT event_type, result_code FROM fulfillment_shipment_events WHERE vendor_id = ? ORDER BY id DESC LIMIT 1`,
    [vendId]
  );
  assert.ok(timeoutEvent);
  assert.equal(timeoutEvent.result_code, 'timeout');

  // Step C: Duplicate/ambiguous booking prevention: Attempting to re-book while in unknown_timeout MUST throw ValidationError
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId,
        courierCode: 'mock_courier',
        actor
      });
    },
    (err) => {
      assert.match(err.message, /ambiguous state/);
      return true;
    }
  );

  // Step D: Inconclusive reconciliation (unknown_error) - does NOT clear retry
  // Order invoice is 'INV-REC-TEST-...' which doesn't match REC-FOUND or REC-ABSENT -> returns unknown_error
  const inconclResult = await courierRepo.reconcileBookingResult({
    subOrderId,
    actor
  });
  assert.equal(inconclResult.reconciled, false);
  assert.equal(inconclResult.outcome, 'unknown_error');

  const shipmentStillBlocked = await db.queryOne(
    `SELECT booking_status FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [subOrderId]
  );
  assert.equal(shipmentStillBlocked.booking_status, 'unknown_timeout');

  // Booking attempt is STILL blocked!
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId,
        courierCode: 'mock_courier',
        actor
      });
    },
    (err) => {
      assert.match(err.message, /ambiguous state/);
      return true;
    }
  );

  // Step E: Authoritative absence reconciliation (confirmed_absent)
  // Update order invoice to include REC-ABSENT to simulate verified absence
  await db.execute(`UPDATE orders SET invoice_no = 'INV-REC-ABSENT-100' WHERE id = ?`, [orderId]);

  const absentResult = await courierRepo.reconcileBookingResult({
    subOrderId,
    actor
  });
  assert.equal(absentResult.reconciled, true);
  assert.equal(absentResult.outcome, 'confirmed_absent');
  assert.equal(absentResult.bookingStatus, 'failed');

  const shipmentCleared = await db.queryOne(
    `SELECT booking_status FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [subOrderId]
  );
  assert.equal(shipmentCleared.booking_status, 'failed');

  // Step F: Retry is now UNLOCKED! Update recipient phone to normal to avoid timeout trigger
  await db.execute(`UPDATE orders SET customer_phone = '01799999999' WHERE id = ?`, [orderId]);

  const retryBooking = await courierRepo.executeOneClickBooking({
    subOrderId,
    courierCode: 'mock_courier',
    actor
  });
  assert.equal(retryBooking.success, true);
  assert.ok(retryBooking.trackingId.startsWith('MCK-'));

  const shipmentSuccess = await db.queryOne(
    `SELECT booking_status, tracking_id FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [subOrderId]
  );
  assert.equal(shipmentSuccess.booking_status, 'succeeded');
  assert.ok(shipmentSuccess.tracking_id);

  // Step G: Subsequent booking attempt throws 'already booked' error
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId,
        courierCode: 'mock_courier',
        actor
      });
    },
    (err) => {
      assert.match(err.message, /already booked/);
      return true;
    }
  );
});
