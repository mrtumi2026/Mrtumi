'use strict';

/**
 * Commission Engine
 * =================
 * Resolves the correct commission rule for a given vendor + category and
 * calculates the platform commission for a single order-item line.
 *
 * Rule priority (lowest number wins):
 *   vendor-specific  >  category-specific  >  global fallback
 *
 * All amounts are integer paisa (1 BDT = 100 paisa).
 */

const { ValidationError } = require('../utils/errors');
const { assertSafePaisa, calculateBasisPointsPaisa } = require('../utils/money');

const BASIS_POINTS_DIVISOR = 10_000; // 100.00% = 10000 bps

/**
 * Load the best-matching commission rule from the database for a given
 * vendor + category combination.
 *
 * @param {object} tx       - MySQL transaction client (queryOne/queryAll)
 * @param {number} vendorId - Vendor ID (nullable for platform-owned products)
 * @param {number} categoryId - Product primary category ID (nullable)
 * @returns {object} rule row
 */
async function resolveRule(tx, vendorId, categoryId) {
  // Build candidate list ordered by specificity, then priority
  const candidates = [];

  if (vendorId) {
    const vendorRule = await tx.queryOne(
      `SELECT * FROM commission_rules
       WHERE scope = 'vendor' AND vendor_id = ? AND active = 1
       ORDER BY priority ASC LIMIT 1`,
      [vendorId]
    );
    if (vendorRule) candidates.push(vendorRule);
  }

  if (categoryId) {
    const catRule = await tx.queryOne(
      `SELECT * FROM commission_rules
       WHERE scope = 'category' AND category_id = ? AND active = 1
       ORDER BY priority ASC LIMIT 1`,
      [categoryId]
    );
    if (catRule) candidates.push(catRule);
  }

  const globalRule = await tx.queryOne(
    `SELECT * FROM commission_rules
     WHERE scope = 'global' AND active = 1
     ORDER BY priority ASC LIMIT 1`,
    []
  );
  if (globalRule) candidates.push(globalRule);

  if (candidates.length === 0) {
    // Absolute fallback: 10% if no rule is seeded
    return { rule_type: 'percent', rate_bps: 1000, flat_paisa: 0, min_paisa: 0, max_paisa: null };
  }

  // Return the most-specific candidate (vendor > category > global)
  return candidates[0];
}

/**
 * Calculate platform commission for a single line item.
 *
 * @param {object} rule         - Commission rule row
 * @param {number} lineTotalPaisa - Gross line total in paisa
 * @returns {number} commissionPaisa - Always >= 0
 */
function calculateLineCommission(rule, lineTotalPaisa) {
  assertSafePaisa(lineTotalPaisa, 'lineTotalPaisa');

  let raw = 0;

  if (rule.rule_type === 'percent') {
    const bps = Number(rule.rate_bps);
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > BASIS_POINTS_DIVISOR) {
      throw new ValidationError(`Commission rule has invalid rate_bps: ${bps}`);
    }
    raw = calculateBasisPointsPaisa(lineTotalPaisa, bps);
  } else if (rule.rule_type === 'flat') {
    raw = assertSafePaisa(Number(rule.flat_paisa), 'flat_paisa');
  } else {
    throw new ValidationError(`Unknown commission rule_type: ${rule.rule_type}`);
  }

  // Apply floor
  const minPaisa = Number(rule.min_paisa || 0);
  raw = Math.max(raw, minPaisa);

  // Apply ceiling
  if (rule.max_paisa !== null && rule.max_paisa !== undefined) {
    const maxPaisa = Number(rule.max_paisa);
    raw = Math.min(raw, maxPaisa);
  }

  // Commission can never exceed the line total
  raw = Math.min(raw, lineTotalPaisa);

  return assertSafePaisa(raw, 'commissionPaisa');
}

/**
 * Calculate gateway fee deduction for a vendor's sub-order.
 *
 * @param {number} vendorEarningPaisa - Net vendor earning before gateway fee
 * @param {number} gatewayFeeBps      - Gateway fee in basis points (from payment_gateways row)
 * @returns {number} gatewayFeePaisa
 */
function calculateGatewayFee(vendorEarningPaisa, gatewayFeeBps) {
  assertSafePaisa(vendorEarningPaisa, 'vendorEarningPaisa');
  const bps = Number(gatewayFeeBps || 0);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > BASIS_POINTS_DIVISOR) return 0;
  return calculateBasisPointsPaisa(vendorEarningPaisa, bps);
}

/**
 * Compute net vendor earning for a sub-order.
 *
 * Net = subtotal - commission - gateway_fee + (shipping if vendor-fulfilled)
 *
 * @param {object} params
 * @param {number} params.subtotalPaisa
 * @param {number} params.commissionPaisa
 * @param {number} params.gatewayFeePaisa
 * @param {number} params.shippingPaisa     - 0 unless vendor-fulfilled
 * @returns {number} netVendorEarningPaisa  - May be 0 (clamped, never negative)
 */
function computeNetVendorEarning({ subtotalPaisa, commissionPaisa, gatewayFeePaisa, shippingPaisa }) {
  assertSafePaisa(subtotalPaisa,    'subtotalPaisa');
  assertSafePaisa(commissionPaisa,  'commissionPaisa');
  assertSafePaisa(gatewayFeePaisa,  'gatewayFeePaisa');
  assertSafePaisa(shippingPaisa,    'shippingPaisa');

  const net = subtotalPaisa - commissionPaisa - gatewayFeePaisa + shippingPaisa;
  // Clamp to 0 — vendor earning cannot be negative (edge case: huge flat fee vs tiny order)
  return Math.max(0, assertSafePaisa(net, 'netVendorEarning', { allowNegative: true }));
}

module.exports = {
  resolveRule,
  calculateLineCommission,
  calculateGatewayFee,
  computeNetVendorEarning,
};
