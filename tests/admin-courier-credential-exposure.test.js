'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const {
  SAFE_COURIER_OPTIONS_ALLOWLIST,
  sanitizeCourierOptionsAllowlist,
  sanitizeAdminCourierRecord
} = require('../src/utils/adminSanitization');

test('Admin Credential Exposure: strict allowlist sanitization drops unknown & nested secret fields', () => {
  // Test direct option allowlist
  const maliciousOptions = {
    store_id: 123,
    city_id: 456,
    refresh_token: 'secret_refresh_tok',
    encrypted_refresh_token: 'enc:v1:fake_cipher',
    password: 'super_secret_password',
    client_secret: 'client_sec',
    unknown_custom_field: 'arbitrary_value',
    nested_credentials: {
      api_token: 'nested_tok',
      private_key: 'nested_key'
    },
    auth_header: 'Bearer xyz',
    danger_key_token: 'leak_attempt'
  };

  const sanitizedJson = sanitizeCourierOptionsAllowlist(maliciousOptions);
  assert.ok(sanitizedJson, 'Sanitized options JSON should not be empty');
  const parsed = JSON.parse(sanitizedJson);

  // Allowlisted safe fields must remain
  assert.equal(parsed.store_id, 123);
  assert.equal(parsed.city_id, 456);

  // Blacklisted & unknown & nested fields must be completely dropped
  assert.equal(parsed.refresh_token, undefined);
  assert.equal(parsed.encrypted_refresh_token, undefined);
  assert.equal(parsed.password, undefined);
  assert.equal(parsed.client_secret, undefined);
  assert.equal(parsed.unknown_custom_field, undefined);
  assert.equal(parsed.nested_credentials, undefined);
  assert.equal(parsed.auth_header, undefined);
  assert.equal(parsed.danger_key_token, undefined);

  // Assert keys match allowlist strictly
  for (const k of Object.keys(parsed)) {
    assert.ok(SAFE_COURIER_OPTIONS_ALLOWLIST.has(k), `Key ${k} must be in safe allowlist`);
  }
});

test('Admin Credential Exposure: secrets and unknown fields never appear in rendered HTML or data-record attributes', async () => {
  const templatePath = path.join(__dirname, '..', 'views', 'admin', 'crud-module.ejs');

  // Simulate raw database record with sensitive credentials and unexpected injected fields
  const rawRows = [
    {
      id: 1,
      name: 'Pathao Courier API',
      code: 'pathao',
      base_url: 'https://api-hermes.pathao.com',
      client_id: 'merchant_client_id_123',
      api_key: 'sensitive_jwt_access_token_xyz',
      secret_key: 'super_sensitive_client_secret_999',
      service_options_json: JSON.stringify({
        refresh_token: 'secret_plaintext_refresh_token_abc',
        encrypted_refresh_token: 'enc:v1:fake_encrypted_refresh_token',
        password: 'merchant_plaintext_secret_password',
        client_secret: 'client_secret_in_options',
        unknown_metadata: 'injected_metadata_payload',
        nested_auth: { internal_token: 'nested_token_123' },
        store_id: 5,
        city_id: 1
      }),
      supports_live_quotes: 1,
      status: 1,
      sandbox: 0,
      updated_at: '2026-11-05 12:00:00',
      injected_top_level_secret: 'leak_this_top_secret',
      auth_token: 'bearer_token_xyz'
    }
  ];

  // Exact allowlist sanitization applied in src/routes/adminSettings.js
  const sanitizedRows = rawRows.map(r => sanitizeAdminCourierRecord(r));

  const viewData = {
    pageTitle: 'Courier API Integration',
    subtitle: 'API Management',
    createAction: '/admin/courierapi/create',
    updatePrefix: '/admin/courierapi/update',
    deletePrefix: '/admin/courierapi/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Courier Service' },
      { key: 'code', label: 'Code' },
      { key: 'api_key', label: 'API Key' },
      { key: 'base_url', label: 'Endpoint URL' },
      { key: 'supports_live_quotes', label: 'Live Quotes', type: 'status' },
      { key: 'status', label: 'Active', type: 'status' }
    ],
    fields: [
      { name: 'name', label: 'Courier Name', type: 'text', required: true },
      { name: 'code', label: 'Code', type: 'text', required: true },
      { name: 'api_key', label: 'API Key / Token', type: 'password', required: true },
      { name: 'secret_key', label: 'Secret Key', type: 'password' },
      { name: 'client_id', label: 'Client ID', type: 'text' },
      { name: 'base_url', label: 'Base API URL', type: 'text' },
      { name: 'supports_live_quotes', label: 'Supports Live Quotes (1/0)', type: 'number', value: '0' },
      { name: 'service_options_json', label: 'Service Options (JSON)', type: 'textarea' },
      { name: 'sandbox', label: 'Sandbox (1/0)', type: 'number', value: '1' }
    ],
    rows: sanitizedRows,
    messages: { success: [], error: [] },
    flash: {},
    csrfToken: 'test_csrf_token',
    currentUser: { role: 'Super Admin', name: 'Admin Test' },
    adminUser: { name: 'Admin Test', role: 'Super Admin', avatar: '' },
    siteSettings: { site_name: 'Mr. Tumi Grocery & Gift', favicon: '' },
    pendingOrdersCount: 0,
    pendingOrdersList: [],
    pendingReviewsCount: 0,
    pendingProductsCount: 0,
    pendingWithdrawalsCount: 0,
    pendingVendorApplicationsCount: 0,
    pendingAffiliatesCount: 0,
    lowStockCount: 0,
    openComplaintsCount: 0,
    unreadNotificationsCount: 0,
    fmt: { number: (n) => String(n), currency: (n) => String(n) },
    t: (k) => k,
    locale: 'en',
    currentPath: '/admin/courierapi/manage',
    hasPermission: () => true
  };

  const renderedHtml = await ejs.renderFile(templatePath, viewData);

  // 1. Assert plaintext tokens, secrets and unknown injected fields are NEVER anywhere in rendered HTML
  assert.doesNotMatch(renderedHtml, /secret_plaintext_refresh_token_abc/, 'Plaintext refresh token must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /merchant_plaintext_secret_password/, 'Plaintext password must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /super_sensitive_client_secret_999/, 'Client secret must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /enc:v1:fake_encrypted/, 'Encrypted refresh token must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /leak_this_top_secret/, 'Top-level injected secret must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /bearer_token_xyz/, 'Injected auth token must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /injected_metadata_payload/, 'Unknown metadata in options must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /nested_token_123/, 'Nested auth tokens must never appear in HTML');

  // 2. Assert data-record attribute on edit button is sanitized strictly to allowlist
  const editBtnMatch = renderedHtml.match(/class="[^"]*edit-crud-btn[^"]*"[^>]*data-record='([^']+)'/);
  assert.ok(editBtnMatch, 'Edit button must exist');
  const recordJson = editBtnMatch[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<');
  const record = JSON.parse(recordJson);

  assert.equal(record.api_key, '••••••••' + 'sensitive_jwt_access_token_xyz'.slice(-4));
  assert.equal(record.secret_key, '••••••••');
  assert.equal(record.injected_top_level_secret, undefined, 'data-record must not contain unknown top-level fields');
  assert.equal(record.auth_token, undefined, 'data-record must not contain unknown auth tokens');

  assert.ok(record.service_options_json);
  const parsedOpts = JSON.parse(record.service_options_json);
  assert.equal(parsedOpts.refresh_token, undefined, 'data-record must not contain refresh_token');
  assert.equal(parsedOpts.encrypted_refresh_token, undefined, 'data-record must not contain encrypted_refresh_token');
  assert.equal(parsedOpts.password, undefined, 'data-record must not contain password');
  assert.equal(parsedOpts.client_secret, undefined, 'data-record must not contain client_secret');
  assert.equal(parsedOpts.unknown_metadata, undefined, 'data-record must not contain unknown_metadata');
  assert.equal(parsedOpts.nested_auth, undefined, 'data-record must not contain nested_auth');

  // Only allowlisted configuration is preserved
  assert.equal(parsedOpts.store_id, 5, 'Allowlisted store_id must be preserved for editing');
  assert.equal(parsedOpts.city_id, 1, 'Allowlisted city_id must be preserved for editing');
});
