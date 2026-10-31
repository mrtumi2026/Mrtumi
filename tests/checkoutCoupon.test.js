'use strict';

process.env.LOG_SILENT = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { couponAmount } = require('../src/repositories/checkoutRepository');

const base = {
  code: 'SAVE', discount_type: 'percent', discount_value: 17, min_purchase_paisa: 0,
  max_discount_paisa: null, usage_limit: null, used_count: 0, expires_at: null, status: 1,
};

test('checkout coupon percentages retain canonical integer-paisa calculation and optional caps', () => {
  assert.deepEqual(couponAmount(base, 12345), { amount: 2098, code: 'SAVE' });
  assert.deepEqual(couponAmount({ ...base, max_discount_paisa: 2000 }, 12345), { amount: 2000, code: 'SAVE' });
});

test('fixed coupon discounts stay in paisa and cannot exceed the cart subtotal', () => {
  assert.deepEqual(couponAmount({ ...base, discount_type: 'fixed', discount_value: 2500 }, 5000), { amount: 2500, code: 'SAVE' });
  assert.deepEqual(couponAmount({ ...base, discount_type: 'fixed', discount_value: 8000 }, 5000), { amount: 5000, code: 'SAVE' });
});

test('the existing missing-coupon fallback remains no-discount; ineligible coupon rows are rejected', () => {
  assert.deepEqual(couponAmount(null, 5_000), { amount: 0, code: '' });
  const invalidRows = [
    { ...base, status: 0 },
    { ...base, expires_at: new Date(Date.now() - 60_000) },
    { ...base, usage_limit: 2, used_count: 2 },
    { ...base, min_purchase_paisa: 10_000 },
    { ...base, discount_type: 'other' },
    { ...base, discount_value: 101 },
  ];
  for (const row of invalidRows) assert.throws(() => couponAmount(row, 5_000), { code: 'VALIDATION_ERROR' });
});
