'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PathaoAdapter = require('../src/services/courier/adapters/PathaoAdapter');
const CourierProviderFactory = require('../src/services/courier/CourierProviderFactory');
const { encryptProviderToken } = require('../src/utils/providerTokenSecurity');
const { deliverVendorOtp } = require('../src/services/vendorOtpDelivery');

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('Pathao works from the login typed in admin: token, then a parcel without a forced city or zone', async () => {
  const calls = [];
  const adapter = new PathaoAdapter({
    code: 'pathao', provider_type: 'pathao', sandbox: 0, client_id: 'cid', secret_key: 'csecret',
    service_options_json: JSON.stringify({ store_id: 77, username: 'shop@example.com', password_enc: encryptProviderToken('pw-123') }),
    mockDbExecute: async () => ({ affectedRows: 1 }),
    fetchFn: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
      if (url.endsWith('/issue-token')) return reply(200, { access_token: 'tok-1', refresh_token: 'ref-1' });
      return reply(200, { data: { consignment_id: 'DT-1' } });
    }
  });
  const result = await adapter.bookShipment({
    invoiceNo: 'MT-1', recipient: { name: 'A', phone: '01712345678', address: 'House 1, Road 2, Jatrabari, Dhaka' }, codAmountPaisa: 12300
  });
  assert.equal(result.success, true);
  assert.equal(calls[0].url, 'https://api-hermes.pathao.com/aladdin/api/v1/issue-token');
  assert.equal(calls[0].body.grant_type, 'password');
  assert.equal(calls[0].body.password, 'pw-123');
  assert.equal(calls[1].headers.Authorization, 'Bearer tok-1');
  assert.equal(calls[1].body.store_id, 77);
  assert.equal(calls[1].body.item_type, 2);
  assert.equal(calls[1].body.amount_to_collect, 123);
  assert.equal(Object.hasOwn(calls[1].body, 'recipient_city'), false);
  assert.equal(Object.hasOwn(calls[1].body, 'recipient_zone'), false);
});

test('A courier without an integration never borrows another provider API', async () => {
  let called = false;
  const adapter = CourierProviderFactory.createAdapter({ code: 'sundarban', provider_type: 'custom', sandbox: 0, api_key: 'x', fetchFn: async () => { called = true; return reply(200, {}); } });
  const result = await adapter.bookShipment({});
  assert.equal(result.success, false);
  assert.equal(result.trackingId, null);
  assert.equal(called, false);
});

test('Vendor OTP SMS follows the admin switch', async () => {
  const settings = { bulksms_api_key: 'k', bulksms_sender_id: 's' };
  const fetchImpl = async () => reply(200, { response_code: 202 });
  await assert.rejects(deliverVendorOtp({ phone: '01712345678', code: '123456', settings, fetchImpl }), /disabled/);
  const sent = await deliverVendorOtp({ phone: '01712345678', code: '123456', settings: { ...settings, vendor_otp_sms_enabled: '1' }, fetchImpl });
  assert.equal(sent.sent, true);
  await assert.rejects(deliverVendorOtp({ phone: '01712345678', code: '123456', settings: { ...settings, vendor_otp_sms_enabled: '1', bulksms_enabled: '0' }, fetchImpl }), /disabled/);
});
