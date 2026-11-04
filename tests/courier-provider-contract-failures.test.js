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

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CourierBaseAdapter = require('../src/services/courier/CourierBaseAdapter');
const SteadfastAdapter = require('../src/services/courier/adapters/SteadfastAdapter');
const PathaoAdapter = require('../src/services/courier/adapters/PathaoAdapter');
const RedxAdapter = require('../src/services/courier/adapters/RedxAdapter');
const MockCourierAdapter = require('../src/services/courier/adapters/MockCourierAdapter');
const courierRepo = require('../src/repositories/courierIntegrationRepository');
const mysql = require('../src/db/mysqlPool');
const { resetDisposableMysqlDatabase } = require('../scripts/qa/mysql-test-database');

// Helper to construct simulated HTTP responses
function mockHttpResponse({ status = 200, json = null, text = '', headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    json: async () => {
      if (json !== null) return json;
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    text: async () => text || JSON.stringify(json)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PROVIDER CONTRACT TESTS (Steadfast, Pathao, RedX)
// ─────────────────────────────────────────────────────────────────────────────

test('Steadfast Contract: verifies payload format, 200 response parsing, 401 auth failure, and tracking', async () => {
  let capturedRequest = null;
  const mockFetch = async (url, options) => {
    capturedRequest = { url, options };
    if (options.headers['Api-Key'] === 'invalid_key') {
      return mockHttpResponse({ status: 401, json: { status: 401, message: 'Invalid API Key or Secret Key' } });
    }
    if (url.includes('/create_order')) {
      return mockHttpResponse({
        status: 200,
        json: {
          status: 200,
          message: 'Order created successfully',
          consignment: {
            consignment_id: 98765,
            invoice: 'INV-1001',
            tracking_code: 'SF-TRK-98765',
            recipient_name: 'Karim Rahman',
            status: 'in_review'
          }
        }
      });
    }
    if (url.includes('/status_by_trackingcode')) {
      return mockHttpResponse({
        status: 200,
        json: { status: 200, delivery_status: 'delivered', tracking_code: 'SF-TRK-98765' }
      });
    }
    return mockHttpResponse({ status: 404 });
  };

  const sf = new SteadfastAdapter({
    code: 'steadfast',
    base_url: 'https://portal.packzy.com/api/v1',
    api_key: 'valid_key',
    secret_key: 'valid_secret',
    sandbox: 0,
    fetchFn: mockFetch
  });

  // A. Request Payload & 200 OK Response Parsing
  const booking = await sf.bookShipment({
    subOrderId: 1,
    invoiceNo: 'INV-1001',
    recipient: { name: 'Karim Rahman', phone: '01712345678', address: 'House 1, Road 2, Dhanmondi', note: 'Fragile' },
    codAmountPaisa: 150000 // ৳1,500
  });

  assert.equal(booking.success, true);
  assert.equal(booking.trackingId, 'SF-TRK-98765');
  assert.equal(booking.consignmentId, '98765');
  assert.equal(capturedRequest.url, 'https://portal.packzy.com/api/v1/create_order');
  const sentBody = JSON.parse(capturedRequest.options.body);
  assert.equal(sentBody.invoice, 'INV-1001');
  assert.equal(sentBody.recipient_name, 'Karim Rahman');
  assert.equal(sentBody.recipient_phone, '01712345678');
  assert.equal(sentBody.cod_amount, 1500);
  assert.equal(capturedRequest.options.headers['Api-Key'], 'valid_key');
  assert.equal(capturedRequest.options.headers['Secret-Key'], 'valid_secret');

  // B. Authentication failure (401)
  const sfBadAuth = new SteadfastAdapter({
    code: 'steadfast',
    base_url: 'https://portal.packzy.com/api/v1',
    api_key: 'invalid_key',
    secret_key: 'invalid_secret',
    sandbox: 0,
    fetchFn: mockFetch
  });
  const badAuthRes = await sfBadAuth.bookShipment({
    subOrderId: 1,
    invoiceNo: 'INV-1001',
    recipient: { name: 'Karim Rahman', phone: '01712345678', address: 'Dhanmondi' }
  });
  assert.equal(badAuthRes.success, false);
  assert.match(badAuthRes.error, /Invalid API Key/i);

  // C. Tracking Status Query
  const tracking = await sf.trackShipment('SF-TRK-98765');
  assert.equal(tracking.trackingId, 'SF-TRK-98765');
  assert.equal(tracking.normalizedStatus, 'delivered');
  assert.equal(tracking.rawStatus, 'delivered');
});

test('Pathao Contract: verifies payload format, 200 response parsing, 401 auth failure, and tracking', async () => {
  let capturedRequest = null;
  const mockFetch = async (url, options) => {
    capturedRequest = { url, options };
    if (options.headers['Authorization'] === 'Bearer invalid_token') {
      return mockHttpResponse({ status: 401, json: { message: 'Unauthenticated.' } });
    }
    if (url.includes('/aladdin/api/v1/orders') && options.method === 'POST') {
      return mockHttpResponse({
        status: 200,
        json: {
          type: 'success',
          code: 200,
          message: 'Order created successfully',
          data: {
            consignment_id: 'PTH-CONS-12345',
            merchant_order_id: 'INV-2002',
            order_status: 'Pickup Requested',
            delivery_fee: 60
          }
        }
      });
    }
    if (url.includes('/info')) {
      return mockHttpResponse({
        status: 200,
        json: {
          data: {
            consignment_id: 'PTH-CONS-12345',
            order_status: 'In Transit'
          }
        }
      });
    }
    return mockHttpResponse({ status: 404 });
  };

  const pathao = new PathaoAdapter({
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: 'valid_jwt_token',
    sandbox: 0,
    service_options_json: { store_id: 42 },
    fetchFn: mockFetch
  });

  // A. Request Payload & 200 OK Response Parsing
  const booking = await pathao.bookShipment({
    subOrderId: 2,
    invoiceNo: 'INV-2002',
    recipient: { name: 'Rahim Ali', phone: '01812345678', address: 'House 12, Road 4, Sector 7, Uttara, Dhaka' },
    parcel: { weightGrams: 2000 },
    codAmountPaisa: 250000 // ৳2,500
  });

  assert.equal(booking.success, true);
  assert.equal(booking.trackingId, 'PTH-CONS-12345');
  assert.equal(booking.consignmentId, 'PTH-CONS-12345');
  assert.equal(capturedRequest.url, 'https://api-hermes.pathao.com/aladdin/api/v1/orders');
  const sentBody = JSON.parse(capturedRequest.options.body);
  assert.equal(sentBody.merchant_order_id, 'INV-2002');
  assert.equal(sentBody.recipient_name, 'Rahim Ali');
  assert.equal(sentBody.recipient_phone, '01812345678');
  assert.equal(sentBody.item_weight, 2);
  assert.equal(sentBody.amount_to_collect, 2500);
  assert.equal(capturedRequest.options.headers['Authorization'], 'Bearer valid_jwt_token');

  // B. Authentication failure (401)
  const pathaoBadAuth = new PathaoAdapter({
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: 'invalid_token',
    sandbox: 0,
    fetchFn: mockFetch
  });
  const badAuthRes = await pathaoBadAuth.bookShipment({
    subOrderId: 2,
    invoiceNo: 'INV-2002',
    recipient: { name: 'Rahim Ali', phone: '01812345678', address: 'House 12, Road 4, Sector 7, Uttara' }
  });
  assert.equal(badAuthRes.success, false);
  assert.match(badAuthRes.error, /Unauthenticated|failed/i);

  // C. Tracking Status Query
  const tracking = await pathao.trackShipment('PTH-CONS-12345');
  assert.equal(tracking.trackingId, 'PTH-CONS-12345');
  assert.equal(tracking.normalizedStatus, 'in_transit');
});

test('RedX Contract: verifies payload format, 200 response parsing, 401 auth failure, and tracking', async () => {
  let capturedRequest = null;
  const mockFetch = async (url, options) => {
    capturedRequest = { url, options };
    if (options.headers['API-ACCESS-TOKEN'] === 'Bearer invalid_redx_token') {
      return mockHttpResponse({ status: 401, json: { message: 'Unauthorized access token.' } });
    }
    if (url.includes('/parcels') && options.method === 'POST') {
      return mockHttpResponse({
        status: 200,
        json: {
          tracking_id: 'RDX-998877',
          message: 'Parcel accepted'
        }
      });
    }
    if (url.includes('/tracking/')) {
      return mockHttpResponse({
        status: 200,
        json: {
          tracking: {
            status: 'picked_up',
            message: 'Picked up from merchant'
          }
        }
      });
    }
    return mockHttpResponse({ status: 404 });
  };

  const redx = new RedxAdapter({
    code: 'redx',
    base_url: 'https://openapi.redx.com.bd',
    api_key: 'valid_redx_token',
    sandbox: 0,
    fetchFn: mockFetch
  });

  // A. Request Payload & 200 OK Response Parsing
  const booking = await redx.bookShipment({
    subOrderId: 3,
    invoiceNo: 'INV-3003',
    recipient: { name: 'Salma Khatun', phone: '01912345678', address: 'Chawkbazar, Chittagong', district: 'Chittagong' },
    parcel: { weightGrams: 1500 },
    codAmountPaisa: 80000 // ৳800
  });

  assert.equal(booking.success, true);
  assert.equal(booking.trackingId, 'RDX-998877');
  assert.equal(booking.consignmentId, 'RDX-998877');
  assert.equal(capturedRequest.url, 'https://openapi.redx.com.bd/v1.0.0-beta/parcels');
  const sentBody = JSON.parse(capturedRequest.options.body);
  assert.equal(sentBody.merchant_invoice_id, 'INV-3003');
  assert.equal(sentBody.customer_name, 'Salma Khatun');
  assert.equal(sentBody.customer_phone, '01912345678');
  assert.equal(sentBody.parcel_weight, 1500);
  assert.equal(sentBody.cash_collection_amount, 800);
  assert.equal(capturedRequest.options.headers['API-ACCESS-TOKEN'], 'Bearer valid_redx_token');

  // B. Authentication failure (401)
  const redxBadAuth = new RedxAdapter({
    code: 'redx',
    base_url: 'https://openapi.redx.com.bd',
    api_key: 'invalid_redx_token',
    sandbox: 0,
    fetchFn: mockFetch
  });
  const badAuthRes = await redxBadAuth.bookShipment({
    subOrderId: 3,
    invoiceNo: 'INV-3003',
    recipient: { name: 'Salma Khatun', phone: '01912345678', address: 'Chawkbazar' }
  });
  assert.equal(badAuthRes.success, false);
  assert.match(badAuthRes.error, /Unauthorized/i);

  // C. Tracking Status Query
  const tracking = await redx.trackShipment('RDX-998877');
  assert.equal(tracking.trackingId, 'RDX-998877');
  assert.equal(tracking.normalizedStatus, 'in_transit');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. FAILURE SCENARIO TESTING (All 3 Adapters)
// ─────────────────────────────────────────────────────────────────────────────

test('Failure Scenarios: Network timeout, 429 rate limit, 5xx server errors, malformed responses and missing IDs', async () => {
  // Scenario A: Network Timeout (AbortController trigger)
  const timeoutFetch = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  const sfTimeout = new SteadfastAdapter({ code: 'sf', api_key: 'k', secret_key: 's', sandbox: 0, fetchFn: timeoutFetch });
  const timeoutRes = await sfTimeout.bookShipment({
    subOrderId: 10,
    invoiceNo: 'INV-T1',
    recipient: { name: 'Test', phone: '01700000000', address: 'Address' }
  });
  assert.equal(timeoutRes.success, false);
  assert.equal(timeoutRes.isTimeout, true);
  assert.match(timeoutRes.error, /timed out after 8 seconds/i);

  // Scenario B: Provider 429 Rate Limit
  const rateLimitFetch = async () => {
    return mockHttpResponse({ status: 429, json: { message: 'Too many requests. Rate limit 60 req/min exceeded.' } });
  };
  const pathao429 = new PathaoAdapter({ code: 'pathao', api_key: 'k', sandbox: 0, fetchFn: rateLimitFetch });
  const rateLimitRes = await pathao429.bookShipment({
    subOrderId: 11,
    invoiceNo: 'INV-T2',
    recipient: { name: 'Test', phone: '01700000000', address: 'Detailed address at least 10 chars' }
  });
  assert.equal(rateLimitRes.success, false);
  assert.match(rateLimitRes.error, /Too many requests/i);

  // Scenario C: Provider 500 / 502 Bad Gateway Server Errors
  const serverErrorFetch = async () => {
    return mockHttpResponse({ status: 502, text: '<html><body>502 Bad Gateway</body></html>' });
  };
  const redx502 = new RedxAdapter({ code: 'redx', api_key: 'k', sandbox: 0, fetchFn: serverErrorFetch });
  const serverErrRes = await redx502.bookShipment({
    subOrderId: 12,
    invoiceNo: 'INV-T3',
    recipient: { name: 'Test', phone: '01700000000', address: 'Address' }
  });
  assert.equal(serverErrRes.success, false);
  assert.match(serverErrRes.error, /JSON|RedX booking failed|502/i);

  // Scenario D: 200 OK response with missing/null tracking ID
  const missingIdFetch = async () => {
    return mockHttpResponse({ status: 200, json: { status: 200, message: 'Success', consignment: null } });
  };
  const sfMissingId = new SteadfastAdapter({ code: 'sf', api_key: 'k', secret_key: 's', sandbox: 0, fetchFn: missingIdFetch });
  const missingIdRes = await sfMissingId.bookShipment({
    subOrderId: 13,
    invoiceNo: 'INV-T4',
    recipient: { name: 'Test', phone: '01700000000', address: 'Address' }
  });
  assert.equal(missingIdRes.success, false);
  assert.equal(missingIdRes.trackingId, null);
  assert.equal(missingIdRes.consignmentId, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SECURITY & SENSITIVE DATA REDACTION
// ─────────────────────────────────────────────────────────────────────────────

test('Security: Credentials and sensitive tokens are strictly redacted and never leaked in responses or error logs', () => {
  const sensitivePayload = {
    Api_Key: 'secret_live_key_99999',
    Secret_Key: 'top_secret_auth_hash',
    Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    bearer_token: 'bearer_token_xyz',
    password: 'super_secret_db_password',
    token: 'oauth2_refresh_token',
    client_secret: 'oauth_client_secret_xyz',
    access_token: 'live_access_token_123',
    refresh_token: 'live_refresh_token_456',
    credential_payload: 'sensitive_credentials',
    account_details: {
      api_key: 'nested_key_777',
      auth_token: 'nested_token_888'
    },
    items_list: [
      { secret: 'item_secret_1' },
      { token: 'item_token_2' }
    ],
    consignment: {
      tracking_code: 'TRK-VISIBLE-1234',
      consignment_id: 'CID-VISIBLE-5678',
      internal_api_key: 'leaked_internal_key'
    }
  };

  const sanitized = CourierBaseAdapter.sanitize(sensitivePayload);
  assert.equal(sanitized.Api_Key, '[REDACTED]');
  assert.equal(sanitized.Secret_Key, '[REDACTED]');
  assert.equal(sanitized.Authorization, '[REDACTED]');
  assert.equal(sanitized.bearer_token, '[REDACTED]');
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.token, '[REDACTED]');
  assert.equal(sanitized.client_secret, '[REDACTED]');
  assert.equal(sanitized.access_token, '[REDACTED]');
  assert.equal(sanitized.refresh_token, '[REDACTED]');
  assert.equal(sanitized.credential_payload, '[REDACTED]');
  assert.equal(sanitized.account_details.api_key, '[REDACTED]');
  assert.equal(sanitized.account_details.auth_token, '[REDACTED]');
  assert.equal(sanitized.items_list[0].secret, '[REDACTED]');
  assert.equal(sanitized.items_list[1].token, '[REDACTED]');
  assert.equal(sanitized.consignment.internal_api_key, '[REDACTED]');

  // Negative tests: verify secrets are NEVER equal to original plain values
  assert.notEqual(sanitized.Api_Key, 'secret_live_key_99999');
  assert.notEqual(sanitized.Secret_Key, 'top_secret_auth_hash');
  assert.notEqual(sanitized.account_details.api_key, 'nested_key_777');
  assert.notEqual(sanitized.items_list[0].secret, 'item_secret_1');

  // Non-sensitive tracking & consignment identifiers MUST remain intact
  assert.equal(sanitized.consignment.tracking_code, 'TRK-VISIBLE-1234');
  assert.equal(sanitized.consignment.consignment_id, 'CID-VISIBLE-5678');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DUPLICATE BOOKING SAFETY & RECONCILIATION GATING (Live DB Tests)
// ─────────────────────────────────────────────────────────────────────────────

test('Database-backed Safety: Concurrent requests, idempotency replays, ambiguous blocking, and reconciliation gating', { skip: !MYSQL_HOST ? SKIP : false }, async (t) => {
  const pool = mysql.getPool();
  const db = mysql.createQueryClient(pool);
  t.after(() => mysql.closePool());
  await resetDisposableMysqlDatabase(pool);

  // 1. Seed active mock courier in courier_apis
  await db.execute(`
    INSERT INTO courier_apis (code, name, provider_type, base_url, api_key, secret_key, client_id, sandbox, supports_live_quotes, status, updated_at)
    VALUES ('mock_courier', 'Mock Express Services', 'mock', 'http://localhost/mock', 'test_key', 'test_secret', 'cid', 1, 1, 1, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE status = 1, supports_live_quotes = 1
  `);

  // 2. Seed customer, vendor, order, and vendor_sub_order
  const custRes = await db.execute(`
    INSERT INTO customers (name, email, phone, password_hash, status, created_at, updated_at)
    VALUES ('Safety Test Customer', 'safety@example.test', '01755555555', 'hash', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `);
  const custId = custRes.insertId;

  const vendRes = await db.execute(`
    INSERT INTO vendors (shop_name, owner_name, email, phone, password_hash, status, created_at, updated_at)
    VALUES ('Safety Vendor Shop', 'Vendor Owner', 'safety_vendor@example.test', '01766666666', 'hash', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `);
  const vendId = vendRes.insertId;

  const orderRes = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-SAFE-101', 'Recipient', '01711111111', 'House 5, Road 9, Dhanmondi', 'Inside Dhaka', 'cod', 'unpaid', 60000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const orderId = orderRes.insertId;

  const subOrderRes = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, vendor_order_no, status, delivery_mode, vendor_entitlement_paisa, marketplace_fee_paisa, net_payable_paisa, created_at, updated_at)
    VALUES (?, ?, 'VSO-SAFE-101', 'ready_for_pickup', 'vendor_managed', 54000, 6000, 54000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [orderId, vendId]);
  const subOrderId = subOrderRes.insertId;

  const actor = { vendorId: vendId };
  const idempotencyKey = `idemp-safe-${Date.now()}`;

  // Step A: First booking succeeds
  const firstBooking = await courierRepo.executeOneClickBooking({
    subOrderId,
    courierCode: 'mock_courier',
    idempotencyKey,
    actor
  });
  assert.equal(firstBooking.success, true);
  assert.ok(firstBooking.trackingId.startsWith('MCK-'));

  // Step B: Idempotent replay with same idempotency key returns cached result
  const replayBooking = await courierRepo.executeOneClickBooking({
    subOrderId,
    courierCode: 'mock_courier',
    idempotencyKey,
    actor
  });
  assert.equal(replayBooking.idempotentReplay, true);
  assert.equal(replayBooking.success, true);
  assert.equal(replayBooking.trackingId, firstBooking.trackingId);

  // Step C: Concurrent attempt on already booked shipment throws ValidationError
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId,
        courierCode: 'mock_courier',
        idempotencyKey: 'different_key',
        actor
      });
    },
    (err) => {
      assert.match(err.message, /already booked/);
      return true;
    }
  );

  // Step C1: Explicit concurrent race test on fresh sub-order (two simultaneous requests)
  const raceOrderRes = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-SAFE-RACE-1', 'Recipient Race 1', '01722222222', 'House 1, Road 1, Dhanmondi', 'Inside Dhaka', 'cod', 'unpaid', 60000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const raceOrderId = raceOrderRes.insertId;

  const raceSubOrderRes = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, vendor_order_no, status, delivery_mode, vendor_entitlement_paisa, marketplace_fee_paisa, net_payable_paisa, created_at, updated_at)
    VALUES (?, ?, 'VSO-RACE-PARALLEL', 'ready_for_pickup', 'vendor_managed', 54000, 6000, 54000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [raceOrderId, vendId]);
  const raceSubOrderId = raceSubOrderRes.insertId;

  const [raceRes1, raceRes2] = await Promise.allSettled([
    courierRepo.executeOneClickBooking({
      subOrderId: raceSubOrderId,
      courierCode: 'mock_courier',
      idempotencyKey: `idemp-race-1-${Date.now()}`,
      actor
    }),
    courierRepo.executeOneClickBooking({
      subOrderId: raceSubOrderId,
      courierCode: 'mock_courier',
      idempotencyKey: `idemp-race-2-${Date.now()}`,
      actor
    })
  ]);

  const raceSuccesses = [raceRes1, raceRes2].filter(r => r.status === 'fulfilled');
  const raceRejections = [raceRes1, raceRes2].filter(r => r.status === 'rejected');

  assert.equal(raceSuccesses.length, 1, 'Exactly one concurrent booking attempt must succeed');
  assert.equal(raceRejections.length, 1, 'The other concurrent booking attempt must be rejected');
  assert.match(raceRejections[0].reason.message, /already booked|ambiguous state/);

  // Verify database state: exactly 1 shipment record was created and has succeeded status
  const raceShipmentCheck = await db.query(
    `SELECT * FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [raceSubOrderId]
  );
  assert.equal(raceShipmentCheck.length, 1, 'Must have exactly one shipment record');
  assert.equal(raceShipmentCheck[0].booking_status, 'succeeded');

  // Step C2: Explicit concurrent race with identical idempotency key
  const raceOrderResSameKey = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-SAFE-RACE-2', 'Recipient Race 2', '01733333333', 'House 2, Road 2, Dhanmondi', 'Inside Dhaka', 'cod', 'unpaid', 60000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const raceOrderIdSameKey = raceOrderResSameKey.insertId;

  const raceSubOrderResSameKey = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, vendor_order_no, status, delivery_mode, vendor_entitlement_paisa, marketplace_fee_paisa, net_payable_paisa, created_at, updated_at)
    VALUES (?, ?, 'VSO-RACE-SAMEKEY', 'ready_for_pickup', 'vendor_managed', 54000, 6000, 54000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [raceOrderIdSameKey, vendId]);
  const raceSubOrderIdSameKey = raceSubOrderResSameKey.insertId;
  const sharedKey = `idemp-shared-${Date.now()}`;

  const [sameKey1, sameKey2] = await Promise.allSettled([
    courierRepo.executeOneClickBooking({
      subOrderId: raceSubOrderIdSameKey,
      courierCode: 'mock_courier',
      idempotencyKey: sharedKey,
      actor
    }),
    courierRepo.executeOneClickBooking({
      subOrderId: raceSubOrderIdSameKey,
      courierCode: 'mock_courier',
      idempotencyKey: sharedKey,
      actor
    })
  ]);

  const sameKeyFulfilled = [sameKey1, sameKey2].filter(r => r.status === 'fulfilled');
  assert.ok(sameKeyFulfilled.length >= 1, 'At least one request succeeds with shared idempotency key');
  for (const res of sameKeyFulfilled) {
    assert.equal(res.value.success, true);
  }
  const sameKeyShipments = await db.query(
    `SELECT * FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [raceSubOrderIdSameKey]
  );
  assert.equal(sameKeyShipments.length, 1, 'Must have exactly one shipment record with shared idempotency key');

  // Step D: Create a third sub-order to test timeout and ambiguous state concurrency
  const orderRes2 = await db.execute(`
    INSERT INTO orders (customer_id, invoice_no, customer_name, customer_phone, shipping_address, shipping_zone, payment_method, payment_status, total_paisa, created_at, updated_at)
    VALUES (?, 'INV-SAFE-TIMEOUT', 'Timeout Recipient', '01800000000', 'Uttara, Dhaka', 'Inside Dhaka', 'cod', 'unpaid', 40000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [custId]);
  const orderId2 = orderRes2.insertId;

  const subOrderRes2 = await db.execute(`
    INSERT INTO vendor_sub_orders (order_id, vendor_id, vendor_order_no, status, delivery_mode, vendor_entitlement_paisa, marketplace_fee_paisa, net_payable_paisa, created_at, updated_at)
    VALUES (?, ?, 'VSO-SAFE-202', 'ready_for_pickup', 'vendor_managed', 36000, 4000, 36000, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [orderId2, vendId]);
  const subOrderId2 = subOrderRes2.insertId;

  // Booking triggers timeout due to 01800000000 phone trigger
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId: subOrderId2,
        courierCode: 'mock_courier',
        actor
      });
    },
    (err) => {
      assert.equal(err.code, 'COURIER_BOOKING_TIMEOUT');
      return true;
    }
  );

  // Verify shipment is in unknown_timeout state
  const timeoutShipment = await db.queryOne(
    `SELECT booking_status FROM fulfillment_shipments WHERE vendor_sub_order_id = ?`,
    [subOrderId2]
  );
  assert.equal(timeoutShipment.booking_status, 'unknown_timeout');

  // Priority 4 verification: ambiguous shipments reporting contract
  const ambiguousReport = await courierRepo.getAmbiguousShipmentsReport({ olderThanMinutes: 0 });
  assert.ok(Array.isArray(ambiguousReport));
  const pendingItem = ambiguousReport.find(r => r.vendor_sub_order_id === subOrderId2);
  assert.ok(pendingItem, 'Timed-out shipment must appear in ambiguous shipments report');
  assert.equal(pendingItem.booking_status, 'unknown_timeout');
  assert.equal(typeof pendingItem.age_minutes, 'number');
  assert.equal(pendingItem.invoice_no, 'INV-SAFE-TIMEOUT');

  // Attempting concurrent or subsequent re-booking MUST be blocked!
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId: subOrderId2,
        courierCode: 'mock_courier',
        actor
      });
    },
    (err) => {
      assert.match(err.message, /ambiguous state/);
      return true;
    }
  );

  // Step E: Inconclusive reconciliation (unknown_error) keeps booking blocked
  const recInconclusive = await courierRepo.reconcileBookingResult({
    subOrderId: subOrderId2,
    actor
  });
  assert.equal(recInconclusive.outcome, 'unknown_error');
  assert.equal(recInconclusive.reconciled, false);

  // Re-booking is STILL blocked
  await assert.rejects(
    async () => {
      await courierRepo.executeOneClickBooking({
        subOrderId: subOrderId2,
        courierCode: 'mock_courier',
        actor
      });
    },
    (err) => {
      assert.match(err.message, /ambiguous state/);
      return true;
    }
  );

  // Step F: Verified absence (confirmed_absent) unlocks safe retry
  await db.execute(`UPDATE orders SET invoice_no = 'INV-REC-ABSENT-SAFE' WHERE id = ?`, [orderId2]);
  const recAbsent = await courierRepo.reconcileBookingResult({
    subOrderId: subOrderId2,
    actor
  });
  assert.equal(recAbsent.outcome, 'confirmed_absent');
  assert.equal(recAbsent.bookingStatus, 'failed');

  // Retry is now unlocked! Change phone to valid to succeed
  await db.execute(`UPDATE orders SET customer_phone = '01788888888' WHERE id = ?`, [orderId2]);
  const retrySuccess = await courierRepo.executeOneClickBooking({
    subOrderId: subOrderId2,
    courierCode: 'mock_courier',
    actor
  });
  assert.equal(retrySuccess.success, true);
  assert.ok(retrySuccess.trackingId.startsWith('MCK-'));
});
