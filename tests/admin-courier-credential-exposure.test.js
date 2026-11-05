'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

test('Admin Credential Exposure: secrets, refresh tokens and passwords never appear in rendered HTML or data-record attributes', async () => {
  const templatePath = path.join(__dirname, '..', 'views', 'admin', 'crud-module.ejs');

  // Simulate raw database record with sensitive credentials
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
        store_id: 5,
        city_id: 1
      }),
      supports_live_quotes: 1,
      status: 1,
      sandbox: 0,
      updated_at: '2026-11-05 12:00:00'
    }
  ];

  // Exact sanitization logic applied in src/routes/adminSettings.js
  const sanitizedRows = rawRows.map(r => {
    let safeServiceOptions = '';
    if (r.service_options_json) {
      try {
        const parsed = typeof r.service_options_json === 'string' ? JSON.parse(r.service_options_json) : r.service_options_json;
        const sanitized = Object.assign({}, parsed);
        delete sanitized.refresh_token;
        delete sanitized.encrypted_refresh_token;
        delete sanitized.password;
        delete sanitized.client_secret;
        safeServiceOptions = Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : '';
      } catch (_e) {
        safeServiceOptions = '';
      }
    }

    return {
      id: r.id,
      name: r.name,
      code: r.code,
      base_url: r.base_url,
      client_id: r.client_id,
      supports_live_quotes: r.supports_live_quotes,
      status: r.status,
      sandbox: r.sandbox,
      api_key: r.api_key ? '••••••••' + String(r.api_key).slice(-4) : '',
      secret_key: r.secret_key ? '••••••••' : '',
      service_options_json: safeServiceOptions,
      updated_at: r.updated_at
    };
  });

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

  // 1. Assert plaintext tokens and secrets are NEVER anywhere in rendered HTML
  assert.doesNotMatch(renderedHtml, /secret_plaintext_refresh_token_abc/, 'Plaintext refresh token must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /merchant_plaintext_secret_password/, 'Plaintext password must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /super_sensitive_client_secret_999/, 'Client secret must never appear in HTML');
  assert.doesNotMatch(renderedHtml, /enc:v1:fake_encrypted/, 'Encrypted refresh token must never appear in HTML');

  // 2. Assert data-record attribute on edit button is sanitized
  const editBtnMatch = renderedHtml.match(/class="[^"]*edit-crud-btn[^"]*"[^>]*data-record='([^']+)'/);
  assert.ok(editBtnMatch, 'Edit button must exist');
  const recordJson = editBtnMatch[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<');
  const record = JSON.parse(recordJson);

  assert.equal(record.api_key, '••••••••' + 'sensitive_jwt_access_token_xyz'.slice(-4));
  assert.equal(record.secret_key, '••••••••');
  assert.ok(record.service_options_json);
  const parsedOpts = JSON.parse(record.service_options_json);
  assert.equal(parsedOpts.refresh_token, undefined, 'data-record must not contain refresh_token');
  assert.equal(parsedOpts.encrypted_refresh_token, undefined, 'data-record must not contain encrypted_refresh_token');
  assert.equal(parsedOpts.password, undefined, 'data-record must not contain password');
  assert.equal(parsedOpts.client_secret, undefined, 'data-record must not contain client_secret');
  assert.equal(parsedOpts.store_id, 5, 'Non-sensitive configuration (store_id) must be preserved for editing');
});
