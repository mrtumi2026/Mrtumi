'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBdPhone, validatePassword, saveAddress } = require('../src/repositories/customerRepository');
const checkoutRepository = require('../src/repositories/checkoutRepository');
const { loadMigrationPairs } = require('../src/db/migrator');
const { createErrorHandler } = require('../src/middleware/errorHandler');

test('Phase 07 validates Bangladesh mobile number forms without accepting malformed values', () => {
  assert.equal(normalizeBdPhone('01712345678'), '01712345678');
  assert.equal(normalizeBdPhone('+8801712345678'), '01712345678');
  assert.equal(normalizeBdPhone('880 1712345678'), '01712345678');
  for (const value of ['0171234567', '02123456789', '017123456789', '']) {
    assert.throws(() => normalizeBdPhone(value), { code: 'VALIDATION_ERROR' });
  }
});

test('Phase 07 checkout rejects malformed server-cart entries as validation errors, not TypeErrors', () => {
  for (const invalidLine of [null, undefined]) {
    assert.throws(
      () => checkoutRepository.normalizeLines([invalidLine]),
      (err) => err.code === 'VALIDATION_ERROR' && err.statusCode === 400,
      'malformed cart lines should fail closed as HTTP 400 validation errors, not raw TypeErrors'
    );
  }
});

test('Phase 07 malformed address payloads and structured text fields fail before database access', async () => {
  for (const malformed of [null, undefined]) {
    await assert.rejects(
      () => saveAddress(1, malformed),
      (err) => err.code === 'VALIDATION_ERROR' && err.statusCode === 400,
      'malformed address payloads must not leak a TypeError or become a server error'
    );
  }
  const valid = { label: 'Home', recipient_name: 'Owner', recipient_phone: '01712345678', division: 'Dhaka', district: 'Dhaka', upazila: 'Dhanmondi', street_address: 'House 1, Road 2' };
  for (const field of Object.keys(valid)) {
    for (const malformed of [{ unexpected: true }, ['unexpected'], true]) {
      await assert.rejects(
        () => saveAddress(1, { ...valid, [field]: malformed }),
        (err) => err.code === 'VALIDATION_ERROR' && err.statusCode === 400 && err.message === 'Address fields must be text.',
        `structured ${field} value must fail field validation before database access`
      );
    }
  }
});

test('Malformed JSON request bodies return a client error instead of HTTP 500', () => {
  const req = { requestId: 'phase07-malformed-json', method: 'POST', originalUrl: '/customer/account/addresses', path: '/customer/account/addresses', headers: { accept: 'application/json' }, xhr: false };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
  createErrorHandler()({ type: 'entity.parse.failed', status: 400, message: 'malformed JSON' }, req, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_REQUEST_BODY');
});

test('Phase 07 customer order reads reject invalid or unsafe identifiers and page numbers before database access', async () => {
  const customerRepository = require('../src/repositories/customerRepository');
  for (const id of [0, -1, 'not-an-id', '9007199254740992']) {
    await assert.rejects(() => customerRepository.getProfile(id), (err) => err.code === 'VALIDATION_ERROR');
    await assert.rejects(() => customerRepository.getOrderDetails(1, id), (err) => err.code === 'VALIDATION_ERROR');
  }
  for (const page of [0, -1, 1.5, '2tail', [], {}]) {
    await assert.rejects(() => customerRepository.listOrders(1, page), (err) => err.code === 'VALIDATION_ERROR');
  }
});

test('Phase 07 enforces password bounds compatible with bcrypt', () => {
  assert.equal(validatePassword('correct horse battery'), 'correct horse battery');
  assert.throws(() => validatePassword('short'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePassword('x'.repeat(73)), { code: 'VALIDATION_ERROR' });
});

test('Phase 07 cart migration is reversible and registered in ordered pairs', () => {
  const pairs = loadMigrationPairs();
  const pair = pairs.find((item) => item.version === '0005');
  assert.ok(pair);
  assert.match(pair.upSql, /CREATE TABLE IF NOT EXISTS `customer_cart_items`/);
  assert.match(pair.downSql, /DROP TABLE IF EXISTS `customer_cart_items`/);
});
