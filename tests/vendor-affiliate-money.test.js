'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { policyForAdminRoute } = require('../src/middleware/legacyAdminRbac');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('vendor delivery path settles referral and affiliate rewards in the same transaction', () => {
  assert.match(read('src/repositories/vendorOrderRepository.js'), /applyOrderOutcomeTx\(tx, orderId, target\)/);
  assert.match(read('src/repositories/phase08Repository.js'), /applyOrderOutcomeTx\(tx, id, target\)/);
});

test('checkout and manual verification no longer write the incompatible legacy vendor split', () => {
  for (const file of ['src/repositories/checkoutRepository.js', 'src/repositories/adminPaymentGatewayRepository.js']) {
    assert.doesNotMatch(read(file), /splitOrderByVendor/);
  }
  assert.doesNotMatch(read('src/services/referralService.js'), /available_paisa/);
});

test('quick order keeps affiliate attribution', () => {
  assert.equal((read('src/routes/storefront.js').match(/affiliateCode: req\.body\.affiliate_code/g) || []).length, 2);
});

test('affiliate withdrawal debit is conditional on the available balance', () => {
  assert.match(read('src/services/affiliateService.js'), /status = 1 AND balance_paisa >= \?/);
});

test('affiliate administration requires finance permissions', () => {
  assert.equal(policyForAdminRoute('GET', '/admin/affiliates').key, 'finance.view');
  assert.equal(policyForAdminRoute('POST', '/admin/affiliates/withdrawals/1').key, 'finance.manage');
});
