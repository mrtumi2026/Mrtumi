'use strict';

/**
 * Checkout payment-method eligibility (single source of truth).
 *
 * The storefront checkout can only complete two kinds of payment:
 *   1. Cash on Delivery (`cod`).
 *   2. Manual MFS (bKash / Nagad / Rocket "Send Money") verified by staff.
 *
 * Automated/API channels are not initialized by the storefront checkout, so they
 * are never offered there. Manual channels are offered only when their database
 * row is explicitly enabled AND the owner has configured both a real wallet
 * number and customer instructions. Nothing is synthesized, defaulted or
 * substituted: an incomplete row is hidden from the checkout and rejected when a
 * client submits it anyway.
 *
 * The same functions are used by `listCheckoutMethods()` (display) and
 * `createOrder()` (server-side enforcement) so the two rules cannot diverge.
 */

const { ConflictError } = require('../utils/errors');

const COD_CODE = 'cod';
const CHECKOUT_UNAVAILABLE = 'This payment method is not active or is not supported at checkout.';

/** Legacy and canonical manual MFS codes mapped to their customer-facing brand. */
const MANUAL_BRANDS = Object.freeze({
  bkash: 'bkash',
  bkash_manual: 'bkash',
  nagad: 'nagad',
  nagad_manual: 'nagad',
  rocket: 'rocket',
  rocket_manual: 'rocket',
});

const BRAND_ORDER = Object.freeze(['bkash', 'nagad', 'rocket']);

/**
 * The placeholder seeded by migrations 0020/0033 is not a real wallet number.
 * It must never be treated as configured.
 */
const SEEDED_PLACEHOLDER_WALLET = '01711000000';

const BD_MOBILE_REGEX = /^01[3-9]\d{8}$/;

/**
 * Returns a normalized BD mobile wallet number, or '' when the stored value is
 * empty, malformed, or only the seeded placeholder.
 */
function normalizeWalletNumber(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .trim()
    .replace(/[\s\-()]/g, '')
    .replace(/^\+?88/, '');
  if (!BD_MOBILE_REGEX.test(cleaned)) return '';
  if (cleaned === SEEDED_PLACEHOLDER_WALLET) return '';
  return cleaned;
}

/** A gateway row counts as enabled only when both status and is_active agree. */
function isGatewayEnabled(row) {
  if (!row) return false;
  if (Number(row.status) !== 1) return false;
  if (row.is_active === null || row.is_active === undefined) return true;
  return Number(row.is_active) === 1;
}

/** Brand of a manual MFS gateway row, or '' when the row is not a manual MFS channel. */
function manualBrandFor(row) {
  if (!row) return '';
  const code = String(row.code || '').trim().toLowerCase();
  const brand = MANUAL_BRANDS[code] || '';
  if (!brand) return '';
  const mode = String(row.mode == null ? '' : row.mode).trim().toLowerCase();
  const type = String(row.gateway_type == null ? '' : row.gateway_type).trim().toLowerCase();
  // An explicit non-manual marker (mode or gateway_type) disqualifies the row.
  if (mode && mode !== 'manual') return '';
  if (!mode && type && type !== 'manual') return '';
  if (mode === 'manual' && type && type !== 'manual' && type !== 'auto') return '';
  return brand;
}

function hasConfiguredInstructions(row) {
  if (!row) return false;
  return Boolean(
    String(row.instructions == null ? '' : row.instructions).trim() ||
      String(row.instructions_bn == null ? '' : row.instructions_bn).trim()
  );
}

/**
 * Evaluates one payment_gateways row for the storefront checkout.
 * @returns {{eligible: boolean, reason: string, brand?: string, wallet?: string}}
 */
function evaluateCheckoutMethod(row) {
  if (!row) return { eligible: false, reason: 'missing' };
  if (!isGatewayEnabled(row)) return { eligible: false, reason: 'disabled' };

  const code = String(row.code || '').trim().toLowerCase();
  if (code === COD_CODE) return { eligible: true, reason: 'cod' };

  const brand = manualBrandFor(row);
  if (!brand) return { eligible: false, reason: 'unsupported' };

  const wallet = normalizeWalletNumber(row.account_number);
  if (!wallet) return { eligible: false, reason: 'missing_wallet' };
  if (!hasConfiguredInstructions(row)) return { eligible: false, reason: 'missing_instructions' };

  return { eligible: true, reason: 'manual', brand, wallet };
}

function toCheckoutMethod(row) {
  return {
    code: String(row.code),
    name: String(row.name == null ? '' : row.name),
    account_number: String(row.account_number == null ? '' : row.account_number),
    instructions: String(row.instructions == null ? '' : row.instructions),
    instructions_bn: String(row.instructions_bn == null ? '' : row.instructions_bn),
    gateway_type: String(row.gateway_type == null ? 'manual' : row.gateway_type),
    mode: String(row.mode == null ? 'manual' : row.mode),
  };
}

/**
 * Filters and orders the checkout methods that are actually usable.
 * COD is always first; manual brands follow in bKash → Nagad → Rocket order.
 * When several rows represent one brand, the canonical `<brand>_manual` row wins.
 */
function selectCheckoutMethods(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let cod = null;
  const manual = new Map();

  for (const row of list) {
    const verdict = evaluateCheckoutMethod(row);
    if (!verdict.eligible) continue;

    if (verdict.reason === 'cod') {
      if (!cod) cod = row;
      continue;
    }

    const prior = manual.get(verdict.brand);
    if (!prior) {
      manual.set(verdict.brand, row);
      continue;
    }
    const priorCanonical = String(prior.code).toLowerCase() === `${verdict.brand}_manual`;
    const nextCanonical = String(row.code).toLowerCase() === `${verdict.brand}_manual`;
    if (nextCanonical && !priorCanonical) manual.set(verdict.brand, row);
  }

  const ordered = [];
  if (cod) ordered.push(toCheckoutMethod(cod));
  for (const brand of BRAND_ORDER) {
    const row = manual.get(brand);
    if (row) ordered.push(toCheckoutMethod(row));
  }
  return ordered;
}

/** Brand implied by the method code a client submitted (e.g. `bkash`, `bkash_manual`). */
function requestedManualBrand(paymentMethod) {
  return String(paymentMethod == null ? '' : paymentMethod)
    .trim()
    .toLowerCase()
    .replace(/^manual_/, '')
    .replace(/_manual$/, '');
}

/**
 * Server-side enforcement used by order creation.
 * Throws a generic ConflictError for disabled, missing, incomplete or forged methods.
 * @returns {{eligible: true, reason: string, brand?: string, wallet?: string}}
 */
function assertCheckoutMethodAllowed(row, paymentMethod) {
  const requested = String(paymentMethod == null ? '' : paymentMethod).trim().toLowerCase();
  const verdict = evaluateCheckoutMethod(row);

  if (!verdict.eligible) throw new ConflictError(CHECKOUT_UNAVAILABLE);
  if (verdict.reason === 'cod') {
    if (requested !== COD_CODE) throw new ConflictError(CHECKOUT_UNAVAILABLE);
    return verdict;
  }
  if (requestedManualBrand(requested) !== verdict.brand) {
    throw new ConflictError(CHECKOUT_UNAVAILABLE);
  }
  return verdict;
}

module.exports = {
  COD_CODE,
  CHECKOUT_UNAVAILABLE,
  MANUAL_BRANDS,
  SEEDED_PLACEHOLDER_WALLET,
  normalizeWalletNumber,
  isGatewayEnabled,
  manualBrandFor,
  hasConfiguredInstructions,
  evaluateCheckoutMethod,
  selectCheckoutMethods,
  requestedManualBrand,
  assertCheckoutMethodAllowed,
};
