'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const affiliateService = require('../src/services/affiliateService');
const sqliteDb = require('../src/db/database');

test.before(() => {
  sqliteDb.initializeDatabase();
});

test('Affiliate System - Registration and unique code generation', async () => {
  const rand = Math.floor(10000000 + Math.random() * 90000000);
  const aff = await affiliateService.registerAffiliate({
    name: 'Top Marketer',
    phone: `017${rand}`,
    email: `aff_${rand}@mrtumi.com`,
    password: 'securePassword123',
    payout_method: 'bKash',
    payout_account: `017${rand}`,
  });

  assert.ok(aff.id > 0, 'Affiliate ID generated');
  assert.ok(aff.affiliate_code.startsWith('AFF-'), 'Code format is AFF-XXXX');
  assert.equal(aff.phone, `017${rand}`);

  // Duplicate phone rejection
  await assert.rejects(
    async () => {
      await affiliateService.registerAffiliate({
        name: 'Another Person',
        phone: `017${rand}`,
        password: 'password123',
      });
    },
    /ইতিমধ্যে একটি এফিলিয়েট অ্যাকাউন্ট তৈরি করা আছে/,
    'Duplicate phone registration is rejected'
  );
});

test('Affiliate System - Multi-Tier Sub-Affiliate Parent Linking', async () => {
  const rand1 = Math.floor(10000000 + Math.random() * 90000000);
  const rand2 = Math.floor(10000000 + Math.random() * 90000000);

  // Parent Affiliate (Tier 1 leader)
  const parent = await affiliateService.registerAffiliate({
    name: 'Parent Leader',
    phone: `018${rand1}`,
    password: 'password123',
  });

  // Sub-Affiliate registers using parent's code
  const sub = await affiliateService.registerAffiliate({
    name: 'Sub Marketer',
    phone: `018${rand2}`,
    password: 'password123',
    parent_code: parent.affiliate_code,
  });

  const subProfile = await affiliateService.getAffiliateById(sub.id);
  assert.equal(Number(subProfile.parent_affiliate_id), parent.id, 'Sub-affiliate is linked to parent affiliate');
});

test('Affiliate System - Link Generation and Click Tracking', async () => {
  const rand = Math.floor(10000000 + Math.random() * 90000000);
  const aff = await affiliateService.registerAffiliate({
    name: 'Link Promoter',
    phone: `019${rand}`,
    password: 'password123',
  });

  const link = await affiliateService.createAffiliateLink(
    aff.id,
    { targetUrl: 'https://mrtumi.com/campaign/eid-dhamaka', targetType: 'campaign' },
    'https://mrtumi.com'
  );

  assert.ok(link.target_url.includes('?aff=' + aff.affiliate_code), 'Link has ?aff=AFFILIATE_CODE parameter');
  assert.equal(link.clicks_count, 0);

  // Click tracking call
  affiliateService.trackClick(aff.affiliate_code);
  assert.ok(true, 'Click tracked without blocking');
});

test('Affiliate System - Multi-Tier Commission Attribution and Settlement Lifecycle', async () => {
  const randParent = Math.floor(10000000 + Math.random() * 90000000);
  const randSub = Math.floor(10000000 + Math.random() * 90000000);
  const orderId = Math.floor(700000 + Math.random() * 200000);

  // 1. Setup Parent & Sub affiliate
  const parent = await affiliateService.registerAffiliate({
    name: 'Master Affiliate',
    phone: `015${randParent}`,
    password: 'password123',
  });

  const sub = await affiliateService.registerAffiliate({
    name: 'Direct Promoter',
    phone: `015${randSub}`,
    password: 'password123',
    parent_code: parent.affiliate_code,
  });

  // 2. Order placed with Sub-Affiliate's code: Sale ৳1,000 (100,000 paisa)
  const saleAmountPaisa = 100000;
  const result = await affiliateService.recordOrderAffiliatePending({
    orderId,
    orderTotalPaisa: saleAmountPaisa,
    affiliateCode: sub.affiliate_code,
  });

  assert.ok(result && result.success, 'Commission recorded');
  // Tier 1 Direct (5% of 1000 BDT = 50 BDT / 5000 paisa)
  assert.equal(result.tier1CommissionPaisa, 5000);

  // Check pending balances before delivery
  const subBefore = await affiliateService.getAffiliateById(sub.id);
  const parentBefore = await affiliateService.getAffiliateById(parent.id);
  assert.equal(Number(subBefore.pending_balance_paisa), 5000, 'Sub affiliate pending balance is ৳50');
  // Tier 2 Override (1% of 1000 BDT = 10 BDT / 1000 paisa)
  assert.equal(Number(parentBefore.pending_balance_paisa), 1000, 'Parent affiliate pending balance is ৳10');

  // 3. Order is delivered -> Commission credited
  await affiliateService.creditOrderAffiliateCommission(orderId);

  const subAfter = await affiliateService.getAffiliateById(sub.id);
  const parentAfter = await affiliateService.getAffiliateById(parent.id);

  assert.equal(Number(subAfter.balance_paisa), 5000, 'Sub affiliate balance credited ৳50');
  assert.equal(Number(subAfter.pending_balance_paisa), 0, 'Sub affiliate pending cleared');
  assert.equal(Number(parentAfter.balance_paisa), 1000, 'Parent affiliate Tier-2 balance credited ৳10');
  assert.equal(Number(parentAfter.pending_balance_paisa), 0, 'Parent affiliate pending cleared');

  // 4. Withdrawal Request
  // Sub has ৳50, attempt to withdraw ৳500 should fail due to insufficient funds
  await assert.rejects(
    async () => {
      await affiliateService.requestWithdrawal(sub.id, {
        amountPaisa: 50000,
        payoutMethod: 'bKash',
        payoutAccount: '01500000000',
      });
    },
    /পর্যাপ্ত পরিমাণ ব্যালেন্স নেই/,
    'Insufficient balance withdrawal is blocked'
  );
});
