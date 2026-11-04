'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveCsrfToken, requireCsrf } = require('../src/middleware/csrf');
const logger = require('../src/utils/logger');
const { createErrorHandler } = require('../src/middleware/errorHandler');
const { AppError } = require('../src/utils/errors');
const { visibleSessionToken } = require('../src/utils/sessionView');
const authRepository = require('../src/repositories/authRepository');


test('CSRF credentials in query strings are rejected; header and parsed-body tokens remain accepted', () => {
  const sessionID = 'security-test-session';
  const nonce = 'security-test-nonce';
  const token = deriveCsrfToken(sessionID, nonce);
  const makeRequest = ({ header, body, query } = {}) => ({
    method: 'POST', sessionID, session: { _csrfNonce: nonce },
    headers: { ...(header ? { 'x-csrf-token': header } : {}) },
    body: body === undefined ? {} : body,
    query: query === undefined ? {} : query,
  });
  const check = (req) => {
    let error = null;
    requireCsrf(req, {}, (nextError) => { error = nextError || null; });
    return error;
  };

  assert.equal(check(makeRequest({ header: token })), null);
  assert.equal(check(makeRequest({ body: { _csrf: token } })), null);
  assert.equal(check(makeRequest({ query: { _csrf: token } }))?.code, 'CSRF_INVALID');
});

test('structured logs redact email, address and financial fields without altering audit snapshots', () => {
  const redacted = logger.redactValue({
    customer_email: 'person@example.invalid',
    shipping_address: '12 Example Road, Dhaka',
    customer_phone: '01712345678',
    amount_paisa: 12500,
  });
  assert.equal(redacted.customer_email, '[REDACTED]');
  assert.equal(redacted.shipping_address, '[REDACTED]');
  assert.equal(redacted.customer_phone, '01712****78');
  assert.equal(redacted.amount_paisa, 12500, 'audit snapshots retain the original financial evidence');

  const previousSilent = process.env.LOG_SILENT;
  const originalError = console.error;
  const originalLog = console.log;
  let line = '';
  process.env.LOG_SILENT = 'false';
  console.error = (value) => { line = String(value); };
  console.log = (value) => { line = String(value); };
  try {
    const req = {
      requestId: 'security-log-test', method: 'GET', path: '/admin/reports',
      originalUrl: '/admin/reports?access_token=do-not-log',
      headers: { accept: 'application/json' }, xhr: false,
    };
    const res = {
      statusCode: 200, headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      send(body) { this.body = body; return this; },
    };
    createErrorHandler()(new Error('private connection string and customer@example.invalid'), req, res, () => {});
    assert.equal(res.body.error.message, 'An unexpected internal error occurred.');
    assert.ok(!JSON.stringify(res.body).includes('private connection string'));
    const entry = JSON.parse(line);
    assert.equal(entry.meta.path, '/admin/reports');
    assert.ok(!line.includes('do-not-log'));
    assert.ok(!line.includes('customer@example.invalid'), 'error metadata must not leak email addresses');

    process.env.LOG_SILENT = 'true';
    const detailResponse = {
      statusCode: 200, headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      send(body) { this.body = body; return this; },
    };
    createErrorHandler()(new AppError('VALIDATION_ERROR', 'Request rejected.', 422, {
      amount_paisa: 12500, customer_email: 'private@example.invalid', shipping_address: '12 Private Road',
    }), req, detailResponse, () => {});
    assert.equal(detailResponse.body.error.details.amount_paisa, '[REDACTED]');
    assert.equal(detailResponse.body.error.details.customer_email, '[REDACTED]');
    assert.equal(detailResponse.body.error.details.shipping_address, '[REDACTED]');

    process.env.LOG_SILENT = 'false';
    logger.info('Structured financial log', { amount_paisa: 12500, balance: 9000 });
    const financialEntry = JSON.parse(line);
    assert.equal(financialEntry.meta.amount_paisa, '[REDACTED]');
    assert.equal(financialEntry.meta.balance, '[REDACTED]');
  } finally {
    console.error = originalError;
    console.log = originalLog;
    if (previousSilent === undefined) delete process.env.LOG_SILENT;
    else process.env.LOG_SILENT = previousSilent;
  }
});

test('production views never receive the session identifier as a client-visible token', () => {
  assert.equal(visibleSessionToken('sid-value', true), '');
  assert.equal(visibleSessionToken('sid-value', false), 'sid-value');
  assert.equal(visibleSessionToken(null, false), '');
});

test('fresh Admin identity query excludes password hashes and still loads current role permissions', async () => {
  let sql = '';
  const pool = {
      async query(statement) {
      sql = statement;
      if (statement.includes('role_permissions')) return [[], []];
      return [[{
        id: 9, role_id: 3, name: 'Security Admin', email: 'admin@example.invalid', phone: '01712345678',
        role_label: 'Staff', avatar_url: '/uploads/default/user.svg', status: 1,
        role_name: 'Least Privilege', role_slug: 'least_privilege',
      }], []];
    },
    async queryAll() { return []; },
  };
  const admin = await authRepository.findActiveAdminById(9, pool, { db: { client: 'mysql' } });
  assert.doesNotMatch(sql, /password_hash|SELECT\s+u\.\*/i);
  assert.deepEqual(admin.permissions, []);
  assert.equal(admin.role_slug, 'least_privilege');
  assert.equal(Object.hasOwn(admin, 'password_hash'), false);
});

test('fresh Vendor and Reseller view identities project away credentials and private addresses', async () => {
  const statements = [];
  const pool = {
    async query(statement) {
      statements.push(statement);
      return [[{ id: 4, shop_name: 'Safe Shop', owner_name: 'Owner', name: 'Partner', phone: '01700000000', email: 'safe@example.invalid', balance: 12, deposit_amount: 2, status: 1 }], []];
    },
  };
  const config = { db: { client: 'mysql' } };
  const vendor = await authRepository.findVendorById(4, pool, config);
  const reseller = await authRepository.findResellerById(4, pool, config);
  assert.equal(vendor.id, 4);
  assert.equal(reseller.id, 4);
  assert.equal(statements.length, 2);
  for (const sql of statements) {
    assert.doesNotMatch(sql, /SELECT\s+\*|password_hash|`address`/i);
  }
});
