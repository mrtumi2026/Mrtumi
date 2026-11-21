'use strict';

/**
 * Regression tests for the COD-first checkout payment-method defect:
 * manual MFS options were synthesized (with a fallback/hard-coded wallet number)
 * even when their database rows were disabled or incomplete, so customers could
 * choose a method that could never complete checkout.
 *
 * These tests exercise the shared eligibility module used by both the checkout
 * display (`listCheckoutMethods`) and server-side order creation (`createOrder`),
 * plus static assertions that the fallbacks are gone and the protections remain.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  selectCheckoutMethods,
  evaluateCheckoutMethod,
  assertCheckoutMethodAllowed,
  normalizeWalletNumber,
  SEEDED_PLACEHOLDER_WALLET,
  CHECKOUT_UNAVAILABLE,
} = require('../src/services/paymentMethodEligibility');
const { ConflictError } = require('../src/utils/errors');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Synthetic fixtures only — no real wallet number is asserted or shipped.
const WALLET = '01700000000';
const INSTRUCTIONS_EN = 'Send Money and enter your TrxID.';
const INSTRUCTIONS_BN = 'সেন্ড মানি করে TrxID দিন।';

const codRow = (overrides = {}) => ({
  code: 'cod',
  name: 'Cash on Delivery (COD)',
  gateway_type: 'auto',
  mode: 'manual',
  account_number: '',
  instructions: 'Pay in cash on delivery.',
  instructions_bn: 'ডেলিভারির সময় নগদ পরিশোধ করুন।',
  status: 1,
  is_active: 1,
  ...overrides,
});

const manualRow = (code, overrides = {}) => ({
  code,
  name: code,
  gateway_type: 'manual',
  mode: 'manual',
  account_number: WALLET,
  instructions: INSTRUCTIONS_EN,
  instructions_bn: INSTRUCTIONS_BN,
  status: 1,
  is_active: 1,
  ...overrides,
});

test('COD enabled with every manual MFS channel disabled yields COD only', () => {
  const rows = [
    codRow(),
    manualRow('bkash_manual', { status: 0, is_active: 0 }),
    manualRow('nagad_manual', { status: 0, is_active: 0 }),
    manualRow('rocket_manual', { status: 0, is_active: 0 }),
    manualRow('bkash_api', { gateway_type: 'auto', mode: 'auto', account_number: '', status: 1 }),
    manualRow('nagad_api', { gateway_type: 'auto', mode: 'auto', account_number: '', status: 1 }),
    manualRow('rocket_api', { gateway_type: 'auto', mode: 'auto', account_number: '', status: 1 }),
  ];

  const methods = selectCheckoutMethods(rows);
  assert.deepEqual(methods.map((m) => m.code), ['cod']);
  assert.equal(methods[0].account_number, '');
});

test('no payment method at all is reported when COD is missing or disabled', () => {
  assert.deepEqual(selectCheckoutMethods([]), []);
  assert.deepEqual(selectCheckoutMethods(null), []);
  const disabledCod = [codRow({ status: 0, is_active: 0 }), manualRow('bkash_manual', { status: 0 })];
  assert.deepEqual(selectCheckoutMethods(disabledCod), []);
});

test('a forged request for a disabled or non-existent MFS method is rejected', () => {
  const disabled = manualRow('bkash_manual', { status: 0, is_active: 0 });
  for (const row of [disabled, null, undefined]) {
    assert.throws(() => assertCheckoutMethodAllowed(row, 'bkash_manual'), (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.message, CHECKOUT_UNAVAILABLE);
      return true;
    });
  }

  // Enabled Nagad row cannot be used by posting another brand's code.
  assert.throws(() => assertCheckoutMethodAllowed(manualRow('nagad_manual'), 'bkash'), ConflictError);

  // Automated/API channels are not offered by the storefront checkout at all.
  assert.throws(
    () => assertCheckoutMethodAllowed(manualRow('bkash_api', { gateway_type: 'auto', mode: 'auto' }), 'bkash_api'),
    ConflictError
  );

  // COD cannot be smuggled through a manual method code.
  assert.throws(() => assertCheckoutMethodAllowed(codRow(), 'bkash'), ConflictError);
});

test('enabled MFS without a real wallet number is hidden and rejected', () => {
  const broken = [
    manualRow('bkash_manual', { account_number: '' }),
    manualRow('bkash_manual', { account_number: '   ' }),
    manualRow('bkash_manual', { account_number: '12345' }),
    manualRow('bkash_manual', { account_number: '01712345' }),
    manualRow('bkash_manual', { account_number: '01711-000000' }), // seeded migration placeholder
    manualRow('bkash_manual', { account_number: '+8801711000000' }), // same placeholder, normalized
    manualRow('bkash_manual', { account_number: '8801711000000' }),
  ];

  for (const row of broken) {
    const verdict = evaluateCheckoutMethod(row);
    assert.equal(verdict.eligible, false);
    assert.ok(['missing_wallet'].includes(verdict.reason), `unexpected reason ${verdict.reason}`);
    assert.deepEqual(selectCheckoutMethods([codRow(), row]).map((m) => m.code), ['cod']);
    assert.throws(() => assertCheckoutMethodAllowed(row, 'bkash_manual'), ConflictError);
  }

  assert.equal(normalizeWalletNumber(SEEDED_PLACEHOLDER_WALLET), '');
});

test('enabled MFS without owner-configured instructions is hidden and rejected', () => {
  const rows = [
    manualRow('nagad_manual', { instructions: '', instructions_bn: '' }),
    manualRow('nagad_manual', { instructions: '   ', instructions_bn: null }),
  ];

  for (const row of rows) {
    const verdict = evaluateCheckoutMethod(row);
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.reason, 'missing_instructions');
    assert.deepEqual(selectCheckoutMethods([codRow(), row]).map((m) => m.code), ['cod']);
    assert.throws(() => assertCheckoutMethodAllowed(row, 'nagad_manual'), ConflictError);
  }

  // Bengali-only instructions are a valid owner configuration; nothing is substituted.
  const bnOnly = manualRow('nagad_manual', { instructions: '', instructions_bn: INSTRUCTIONS_BN });
  const methods = selectCheckoutMethods([codRow(), bnOnly]);
  assert.deepEqual(methods.map((m) => m.code), ['cod', 'nagad_manual']);
  assert.equal(methods[1].instructions, '');
  assert.equal(methods[1].instructions_bn, INSTRUCTIONS_BN);
});

test('enabled and fully configured MFS channels are displayed exactly as configured', () => {
  const bkash = manualRow('bkash_manual', { name: 'bKash Send Money', account_number: '01700000000' });
  const nagad = manualRow('nagad_manual', {
    name: 'Nagad Send Money',
    account_number: '01911111111',
    instructions: 'Nagad instruction',
    instructions_bn: 'নগদ নির্দেশনা',
  });

  const methods = selectCheckoutMethods([nagad, bkash, codRow()]);
  assert.deepEqual(methods.map((m) => m.code), ['cod', 'bkash_manual', 'nagad_manual']);
  assert.equal(methods[1].account_number, bkash.account_number);
  assert.equal(methods[1].name, 'bKash Send Money');
  assert.equal(methods[1].instructions, INSTRUCTIONS_EN);
  assert.equal(methods[2].account_number, nagad.account_number);
  assert.equal(methods[2].instructions, 'Nagad instruction');
  assert.equal(methods[2].instructions_bn, 'নগদ নির্দেশনা');

  // No injecting of missing brands: exactly two manual channels were configured.
  assert.equal(methods.some((m) => m.code === 'rocket_manual'), false);

  // A configured row passes server-side enforcement for its own brand.
  assert.equal(assertCheckoutMethodAllowed(bkash, 'bkash_manual').eligible, true);
  assert.equal(assertCheckoutMethodAllowed(bkash, 'bkash').eligible, true);
});

test('one brand is listed once and the canonical *_manual row wins', () => {
  const legacy = manualRow('bkash', { account_number: '01700000000', name: 'Legacy bKash' });
  const canonical = manualRow('bkash_manual', { account_number: '01822222222', name: 'bKash Manual' });

  const methods = selectCheckoutMethods([legacy, canonical]);
  assert.deepEqual(methods.map((m) => m.code), ['bkash_manual']);
  assert.equal(methods[0].account_number, '01822222222');

  // Legacy row alone is still a supported manual channel when it is complete.
  assert.deepEqual(selectCheckoutMethods([legacy]).map((m) => m.code), ['bkash']);
});

test('checkout sources contain no fallback or hard-coded wallet number', () => {
  const repository = read('src/repositories/checkoutRepository.js');
  const checkoutView = read('views/store/checkout.ejs');
  const footer = read('views/store/partials/footer.ejs');
  const storefrontJs = read('public/frontEnd/js/storefront.js');

  for (const [label, source] of Object.entries({
    repository,
    checkoutView,
    footer,
    storefrontJs,
  })) {
    assert.doesNotMatch(source, /01973437395/, `${label} still contains the hard-coded wallet number`);
    assert.doesNotMatch(source, /fallbackPhone/, `${label} still contains a fallback wallet variable`);
    assert.doesNotMatch(source, /\b01[3-9]\d{8}\b/, `${label} hard-codes a wallet-like phone number`);
  }

  // The repository no longer synthesizes gateway rows.
  assert.doesNotMatch(repository, /hasBkash|hasNagad|hasRocket/);
  assert.doesNotMatch(repository, /Send Money to our/);
  assert.doesNotMatch(repository, /rows\.push\(\{ code:/);

  // The view renders exactly the server-provided, already-filtered list.
  assert.doesNotMatch(checkoutView, /displayGateways\.push/);
  assert.match(checkoutView, /const displayGateways = \(typeof gateways !== 'undefined' && Array\.isArray\(gateways\)\) \? gateways : \[\]/);
  assert.match(checkoutView, /displayGateways\.forEach\(function\(gateway\)/);

  // Quick-order defaults to COD only and is replaced by the server's real list.
  assert.doesNotMatch(footer, /data-account=/);
  assert.match(storefrontJs, /if \(Array\.isArray\(methods\) && methods\.length\)/);
  assert.doesNotMatch(storefrontJs, /methods\.length > 1/);
});

test('display and order creation share the eligibility rule and keep existing TrxID protections', () => {
  const repository = read('src/repositories/checkoutRepository.js');

  assert.match(repository, /paymentMethodEligibility\.selectCheckoutMethods\(rows\)/);
  assert.match(repository, /paymentMethodEligibility\.assertCheckoutMethodAllowed\(gateway,paymentMethod\)/);

  // Existing manual-payment contract: sender + TrxID required, pending verification,
  // COD due only for COD, and the DB-level duplicate TrxID guard remains in place.
  assert.match(repository, /requireString\(input\.trx_id,'Transaction ID'/);
  assert.match(repository, /normalizeBdPhone\(input\.sender_number,'sender mobile number'\)/);
  assert.match(repository, /paymentStatus=isManualPayment\?'pending_verification':'unpaid'/);
  assert.match(repository, /const codDue=isManualPayment\?0:total/);
  assert.match(repository, /INSERT INTO order_payments[\s\S]*'pending_verification'/);

  const migration = read('src/db/migrations/0003_orders_payments_and_operations.up.sql');
  assert.match(migration, /UNIQUE KEY `uq_order_payments_gateway_trx` \(`gateway_code`, `provider_trx_id`\)/);
});
