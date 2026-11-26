'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maxUsablePaisa, DEFAULT_MAX_PERCENT, HIGHEST_ALLOWED_PERCENT } = require('../src/services/customerWalletService');

test('wallet limit defaults to 20% and can never cover a whole order', () => {
  assert.equal(DEFAULT_MAX_PERCENT, 20);
  assert.ok(HIGHEST_ALLOWED_PERCENT < 100);
});

test('wallet use is capped by the percent of product price after coupon', () => {
  assert.equal(maxUsablePaisa({ subtotalPaisa: 100000, balancePaisa: 50000, percent: 20 }), 20000);
  assert.equal(maxUsablePaisa({ subtotalPaisa: 100000, couponPaisa: 10000, balancePaisa: 50000, percent: 20 }), 18000);
});

test('wallet use is capped by balance, rounded down to whole taka and never negative', () => {
  assert.equal(maxUsablePaisa({ subtotalPaisa: 100000, balancePaisa: 7550, percent: 20 }), 7500);
  assert.equal(maxUsablePaisa({ subtotalPaisa: 33333, balancePaisa: 50000, percent: 20 }), 6600);
  assert.equal(maxUsablePaisa({ subtotalPaisa: 100000, balancePaisa: 50000, percent: 0 }), 0);
  assert.equal(maxUsablePaisa({ subtotalPaisa: 10000, couponPaisa: 20000, balancePaisa: 50000, percent: 20 }), 0);
});
