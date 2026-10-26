'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBdPhone, validatePassword } = require('../src/repositories/customerRepository');
const { loadMigrationPairs } = require('../src/db/migrator');

test('Phase 07 validates Bangladesh mobile number forms without accepting malformed values', () => {
  assert.equal(normalizeBdPhone('01712345678'), '01712345678');
  assert.equal(normalizeBdPhone('+8801712345678'), '01712345678');
  assert.equal(normalizeBdPhone('880 1712345678'), '01712345678');
  for (const value of ['0171234567', '02123456789', '017123456789', '']) {
    assert.throws(() => normalizeBdPhone(value), { code: 'VALIDATION_ERROR' });
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
