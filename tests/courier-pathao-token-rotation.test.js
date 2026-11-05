'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PathaoAdapter = require('../src/services/courier/adapters/PathaoAdapter');

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Map([['content-type', 'application/json']]),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test('Pathao OAuth: sandbox token refresh and persistence', async () => {
  let rotatedHook = null;
  const pathao = new PathaoAdapter({
    code: 'pathao',
    sandbox: 1,
    onTokenRotated: async (payload) => {
      rotatedHook = payload;
    }
  });

  const res = await pathao.refreshAccessToken();
  assert.equal(res.success, true);
  assert.equal(res.accessToken, 'pathao_sandbox_refreshed_token');
  assert.equal(res.refreshToken, 'pathao_sandbox_refresh_token');
  assert.equal(res.recovered, false);
  assert.equal(pathao.apiKey, 'pathao_sandbox_refreshed_token');
  assert.equal(pathao.refreshToken, 'pathao_sandbox_refresh_token');
  assert.equal(pathao.serviceOptions.refresh_token, 'pathao_sandbox_refresh_token');
  assert.ok(rotatedHook, 'onTokenRotated callback must have fired');
  assert.equal(rotatedHook.accessToken, 'pathao_sandbox_refreshed_token');
  assert.equal(rotatedHook.refreshToken, 'pathao_sandbox_refresh_token');
});

test('Pathao OAuth: successful refresh-token rotation and persistence', async () => {
  let issueTokenPayload = null;
  let persistedRecord = null;

  const mockFetch = async (url, options = {}) => {
    if (url.includes('/issue-token')) {
      issueTokenPayload = JSON.parse(options.body);
      return mockResponse(200, {
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: 'new_rotated_access_token_123',
        refresh_token: 'new_rotated_refresh_token_456'
      });
    }
    return mockResponse(404, {});
  };

  const pathao = new PathaoAdapter({
    id: 42,
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: 'old_expired_access_token',
    client_id: 'cid_test',
    client_secret: 'csec_test',
    service_options_json: { refresh_token: 'old_active_refresh_token', store_id: 1 },
    fetchFn: mockFetch,
    onTokenRotated: async (data) => {
      persistedRecord = data;
    }
  });

  const result = await pathao.refreshAccessToken();
  assert.equal(result.success, true);
  assert.equal(result.recovered, false);
  assert.equal(result.accessToken, 'new_rotated_access_token_123');
  assert.equal(result.refreshToken, 'new_rotated_refresh_token_456');

  // Verify that the request body sent to Pathao used refresh_token grant
  assert.equal(issueTokenPayload.grant_type, 'refresh_token');
  assert.equal(issueTokenPayload.refresh_token, 'old_active_refresh_token');
  assert.equal(issueTokenPayload.client_id, 'cid_test');

  // Verify adapter internal state was updated
  assert.equal(pathao.apiKey, 'new_rotated_access_token_123');
  assert.equal(pathao.refreshToken, 'new_rotated_refresh_token_456');
  assert.equal(pathao.serviceOptions.refresh_token, 'new_rotated_refresh_token_456');

  // Verify persistence hook captured new rotated tokens
  assert.ok(persistedRecord);
  assert.equal(persistedRecord.providerId, 42);
  assert.equal(persistedRecord.accessToken, 'new_rotated_access_token_123');
  assert.equal(persistedRecord.refreshToken, 'new_rotated_refresh_token_456');
});

test('Pathao OAuth: automatic recovery via credentials when refresh_token is invalid', async () => {
  const capturedCalls = [];
  let persistedRecord = null;

  const mockFetch = async (url, options = {}) => {
    if (url.includes('/issue-token')) {
      const body = JSON.parse(options.body);
      capturedCalls.push(body.grant_type);

      // First call: refresh_token fails with 400 Bad Request (invalid_grant)
      if (body.grant_type === 'refresh_token') {
        return mockResponse(400, {
          error: 'invalid_grant',
          message: 'The refresh token is invalid or expired.'
        });
      }

      // Second call: recovery via password grant succeeds!
      if (body.grant_type === 'password') {
        return mockResponse(200, {
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: 'recovered_access_token_789',
          refresh_token: 'recovered_refresh_token_012'
        });
      }
    }
    return mockResponse(404, {});
  };

  const pathao = new PathaoAdapter({
    id: 42,
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: 'stale_jwt',
    client_id: 'cid_test',
    client_secret: 'csec_test',
    service_options_json: {
      refresh_token: 'expired_invalid_refresh_token',
      username: 'merchant@mrtumi.com',
      password: 'merchant_secret_password'
    },
    fetchFn: mockFetch,
    onTokenRotated: async (data) => {
      persistedRecord = data;
    }
  });

  const result = await pathao.refreshAccessToken();
  assert.equal(result.success, true);
  assert.equal(result.recovered, true, 'Result must indicate token was recovered');
  assert.equal(result.accessToken, 'recovered_access_token_789');
  assert.equal(result.refreshToken, 'recovered_refresh_token_012');

  // Verify call sequence: refresh_token attempted, then password recovery
  assert.deepEqual(capturedCalls, ['refresh_token', 'password']);

  // Verify adapter internal state
  assert.equal(pathao.apiKey, 'recovered_access_token_789');
  assert.equal(pathao.refreshToken, 'recovered_refresh_token_012');
  assert.equal(pathao.serviceOptions.refresh_token, 'recovered_refresh_token_012');

  // Verify persistence hook captured the recovered tokens
  assert.ok(persistedRecord);
  assert.equal(persistedRecord.accessToken, 'recovered_access_token_789');
  assert.equal(persistedRecord.refreshToken, 'recovered_refresh_token_012');
});

test('Pathao OAuth: 401 on booking triggers authenticatedFetch refresh, rotation and transparent retry', async () => {
  let callCount = 0;
  let persistedData = null;

  const mockFetch = async (url, options = {}) => {
    callCount++;
    if (url.includes('/orders')) {
      const auth = options.headers?.Authorization;
      if (auth === 'Bearer expired_token') {
        return mockResponse(401, { message: 'Unauthenticated.' });
      }
      if (auth === 'Bearer valid_fresh_token') {
        return mockResponse(200, {
          data: {
            consignment_id: 'PTH-CONS-OK-99',
            merchant_order_id: 'INV-777',
            order_status: 'Pickup Requested'
          }
        });
      }
    }
    if (url.includes('/issue-token')) {
      return mockResponse(200, {
        access_token: 'valid_fresh_token',
        refresh_token: 'fresh_refresh_token'
      });
    }
    return mockResponse(404, {});
  };

  const pathao = new PathaoAdapter({
    code: 'pathao',
    base_url: 'https://api-hermes.pathao.com',
    api_key: 'expired_token',
    client_id: 'cid',
    client_secret: 'csec',
    service_options_json: { refresh_token: 'ref_tok' },
    fetchFn: mockFetch,
    onTokenRotated: async (d) => { persistedData = d; }
  });

  const booking = await pathao.bookShipment({
    subOrderId: 9,
    invoiceNo: 'INV-777',
    recipient: { name: 'Customer Test', phone: '01712345678', address: '123 Test Road, Dhaka' }
  });

  assert.equal(booking.success, true);
  assert.equal(booking.trackingId, 'PTH-CONS-OK-99');
  assert.equal(pathao.apiKey, 'valid_fresh_token');
  assert.equal(pathao.refreshToken, 'fresh_refresh_token');
  assert.ok(persistedData);
  assert.equal(persistedData.accessToken, 'valid_fresh_token');
});
