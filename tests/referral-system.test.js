'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const referralService = require('../src/services/referralService');
const sqliteDb = require('../src/db/database');

test.before(() => {
  sqliteDb.initializeDatabase();
});

test('Referral System - code generation format and uniqueness', () => {
  const custCode1 = referralService.generateCode('customer', 101);
  const custCode2 = referralService.generateCode('customer', 102);
  const vendCode = referralService.generateCode('vendor', 5);

  assert.ok(custCode1.startsWith('MT-C'), 'Customer referral code starts with MT-C');
  assert.ok(vendCode.startsWith('MT-V'), 'Vendor referral code starts with MT-V');
  assert.notEqual(custCode1, custCode2, 'Different customer IDs generate different codes');
});

test('Referral System - getOrCreateReferralCode creates and reuses code', async () => {
  const testCustomerId = 100000 + Math.floor(Math.random() * 900000);
  const initial = await referralService.getOrCreateReferralCode('customer', testCustomerId, 'https://mrtumi.com');

  assert.ok(initial.code, 'Referral code was generated');
  assert.ok(initial.referralLink.includes('?ref=' + encodeURIComponent(initial.code)), 'Referral link contains ref query');
  assert.equal(initial.isActive, true, 'Referral code is active');

  // Second call must return the exact same code
  const repeated = await referralService.getOrCreateReferralCode('customer', testCustomerId, 'https://mrtumi.com');
  assert.equal(repeated.code, initial.code, 'Existing code is returned on subsequent calls');
});

test('Referral System - validateReferralCode validates active codes and rejects invalid ones', async () => {
  const testCustomerId = 100000 + Math.floor(Math.random() * 900000);
  const created = await referralService.getOrCreateReferralCode('customer', testCustomerId);

  const validated = await referralService.validateReferralCode(created.code);
  assert.ok(validated, 'Valid code returns details');
  assert.equal(validated.code, created.code);
  assert.equal(validated.actorType, 'customer');
  assert.equal(validated.actorId, testCustomerId);

  // Invalid / non-existent codes
  const invalid = await referralService.validateReferralCode('NON-EXISTENT-XYZ');
  assert.equal(invalid, null, 'Non-existent code returns null');

  const empty = await referralService.validateReferralCode('');
  assert.equal(empty, null, 'Empty string returns null');
});

test('Referral System - recordReferralOrderPending and creditReferralReward lifecycle', async () => {
  const referrerCustomerId = 200000 + Math.floor(Math.random() * 800000);
  const refereeCustomerId = referrerCustomerId + 1;
  const testOrderId = 500000 + Math.floor(Math.random() * 400000);

  // 1. Referrer gets a referral code
  const ref = await referralService.getOrCreateReferralCode('customer', referrerCustomerId);

  // 2. Prevent self-referral
  const selfReferral = await referralService.recordReferralOrderPending({
    orderId: testOrderId,
    orderTotalPaisa: 50000, // 500 BDT
    referralCode: ref.code,
    refereeCustomerId: referrerCustomerId, // Same as referrer
    refereePhone: '01700000000',
  });
  assert.equal(selfReferral, null, 'Self-referral is blocked');

  // 3. Valid friend order placed
  const recorded = await referralService.recordReferralOrderPending({
    orderId: testOrderId,
    orderTotalPaisa: 60000, // 600 BDT
    referralCode: ref.code,
    refereeCustomerId: refereeCustomerId,
    refereePhone: '01800000000',
  });
  assert.ok(recorded, 'Referral reward recorded as pending');
  assert.equal(recorded.status, 'pending');
  assert.equal(recorded.rewardPaisa, 5000); // ৳50 cashback
  assert.equal(recorded.rewardPoints, 50);

  // 4. Order gets delivered -> reward credited to wallet
  const creditResult = await referralService.creditReferralRewardForOrder(testOrderId);
  assert.ok(creditResult && creditResult.success, 'Referral reward credited upon delivery');
  assert.equal(creditResult.rewardPaisa, 5000);

  // 5. Verify customer wallet stats
  const stats = await referralService.getCustomerWalletAndReferralStats(referrerCustomerId);
  assert.equal(stats.balancePaisa, 5000, 'Wallet balance updated with reward paisa');
  assert.equal(stats.pointsBalance, 50, 'Points balance updated with reward points');
  assert.ok(stats.transactions.length >= 1, 'Transaction recorded in history');
  assert.equal(stats.completedCount, 1, 'Completed count is 1');
});

test('Referral System - Vendor referral code generation and stats', async () => {
  const vendorId = 10000 + Math.floor(Math.random() * 80000);
  const vendorRef = await referralService.getOrCreateReferralCode('vendor', vendorId, 'https://mrtumi.com');

  assert.ok(vendorRef.code.startsWith('MT-V'), 'Vendor code starts with MT-V');
  assert.ok(vendorRef.referralLink.includes(vendorRef.code), 'Vendor referral link contains code');

  const vStats = await referralService.getVendorReferralStats(vendorId);
  assert.equal(vStats.referralCode, vendorRef.code);
  assert.equal(typeof vStats.invitedCount, 'number');
  assert.equal(typeof vStats.totalEarnedPaisa, 'number');
});
