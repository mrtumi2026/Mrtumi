'use strict';

const { ValidationError } = require('../utils/errors');

const MODES = Object.freeze({ RESELLER: 'reseller_price', OFFICIAL: 'marketplace_official' });

function money(value, label, { allowZero = true } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new ValidationError(`${label} must be a valid non-negative amount in paisa.`);
  }
  return n;
}

/** Pure, integer-paisa calculation. Values are per unit except where noted. */
function calculateResellerPricing(input = {}) {
  const mode = String(input.mode || '');
  if (!Object.values(MODES).includes(mode)) throw new ValidationError('A valid reseller pricing mode is required.');
  const quantity = Number(input.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) {
    throw new ValidationError('Quantity must be an integer from 1 to 100000.');
  }
  const official = money(input.officialUnitPricePaisa, 'Official price', { allowZero: false });
  const vendor = money(input.vendorEntitlementUnitPaisa, 'Vendor entitlement', { allowZero: false });
  const fee = money(input.platformFeeUnitPaisa ?? 0, 'Platform fee');
  const adjustment = money(input.adjustmentUnitPaisa ?? 0, 'Adjustment');
  const minimum = input.minimumSellingUnitPaisa == null ? 0 : money(input.minimumSellingUnitPaisa, 'Minimum selling price');
  const maximum = input.maximumSellingUnitPaisa == null ? Number.MAX_SAFE_INTEGER : money(input.maximumSellingUnitPaisa, 'Maximum selling price');
  if (maximum < minimum) throw new ValidationError('Maximum reseller price cannot be below the minimum.');

  let customerUnitPrice;
  let resellerUnitEarning;
  let platformUnitRevenue;
  let commissionUnit = 0;
  if (mode === MODES.RESELLER) {
    customerUnitPrice = money(input.resellerSellingUnitPaisa, 'Reseller selling price', { allowZero: false });
    if (customerUnitPrice < minimum || customerUnitPrice > maximum) throw new ValidationError('Reseller selling price is outside the configured range.');
    if (customerUnitPrice < vendor) throw new ValidationError('Reseller price cannot be below the vendor entitlement.');
    resellerUnitEarning = customerUnitPrice - vendor - fee - adjustment;
    platformUnitRevenue = fee;
    if (resellerUnitEarning < 0) throw new ValidationError('This price would create a negative reseller earning.');
  } else {
    customerUnitPrice = official;
    if (customerUnitPrice < minimum || customerUnitPrice > maximum) throw new ValidationError('Official price is outside the configured eligible range.');
    const bps = Number(input.resellerCommissionBps ?? 0);
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) throw new ValidationError('Reseller commission rate must be 0–10000 basis points.');
    commissionUnit = Number((BigInt(customerUnitPrice) * BigInt(bps)) / 10000n);
    resellerUnitEarning = commissionUnit - adjustment;
    platformUnitRevenue = customerUnitPrice - vendor - commissionUnit - fee - adjustment;
    if (customerUnitPrice < vendor || resellerUnitEarning < 0 || platformUnitRevenue < 0) {
      throw new ValidationError('Official price does not cover vendor entitlement, reseller commission and platform fees.');
    }
  }

  const productAmount = customerUnitPrice * quantity;
  const vendorEntitlement = vendor * quantity;
  const platformFee = fee * quantity;
  const adjustments = adjustment * quantity;
  const resellerEarning = resellerUnitEarning * quantity;
  const platformRevenue = platformUnitRevenue * quantity;
  const commission = commissionUnit * quantity;
  const values = [productAmount, vendorEntitlement, platformFee, adjustments, resellerEarning, platformRevenue, commission];
  if (values.some((n) => !Number.isSafeInteger(n))) throw new ValidationError('Calculated amount exceeds the supported range.');

  return Object.freeze({
    mode, quantity, customerUnitPricePaisa: customerUnitPrice, productAmountPaisa: productAmount,
    vendorEntitlementPaisa: vendorEntitlement, platformFeePaisa: platformFee,
    adjustmentPaisa: adjustments, resellerEarningPaisa: resellerEarning,
    resellerCommissionPaisa: commission, platformRevenuePaisa: platformRevenue,
  });
}

module.exports = { MODES, calculateResellerPricing };
