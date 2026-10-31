'use strict';

/**
 * Integer Minor-Unit Money Representation & Arithmetic for BDT (৳)
 * 1 BDT = 100 paisa.
 * All storage and server-side calculations use exact safe integers (paisa).
 */

const PAISA_PER_BDT = 100;
const BASIS_POINTS_DIVISOR = 10000; // 100.00% = 10000 bps

function assertSafePaisa(value, fieldName = 'amountPaisa', { allowNegative = false } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${fieldName} must be a safe integer in paisa (got ${String(value)}).`);
  }
  if (!allowNegative && value < 0) {
    throw new RangeError(`${fieldName} cannot be negative (got ${value}).`);
  }
  return value;
}

/**
 * Converts a BDT input (number or string like "1300", "1300.5", "1300.50")
 * into exact integer paisa without IEEE-754 floating-point drift.
 */
function bdtToPaisa(bdtInput, { allowNegative = false } = {}) {
  if (bdtInput === null || bdtInput === undefined || bdtInput === '') {
    throw new TypeError('BDT value is required.');
  }

  let str;
  if (typeof bdtInput === 'number') {
    if (!Number.isFinite(bdtInput)) {
      throw new TypeError('BDT number must be finite.');
    }
    str = bdtInput.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  } else if (typeof bdtInput === 'string') {
    str = bdtInput.trim().replace(/,/g, '').replace(/^৳\s*/, '');
  } else {
    throw new TypeError(`Unsupported BDT input type: ${typeof bdtInput}`);
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(str)) {
    throw new SyntaxError(`Invalid BDT amount format: "${String(bdtInput)}"`);
  }

  const isNegative = str.startsWith('-');
  if (isNegative && !allowNegative) {
    throw new RangeError(`BDT amount cannot be negative: "${String(bdtInput)}"`);
  }

  const unsigned = isNegative ? str.slice(1) : str;
  const [wholePart, fracPart = ''] = unsigned.split('.');

  if (fracPart.length > 2) {
    throw new RangeError(
      `BDT amount "${String(bdtInput)}" exceeds 2 decimal places (sub-paisa precision not allowed).`
    );
  }

  const paddedFrac = fracPart.padEnd(2, '0');
  const paisaAbs = Number(wholePart) * PAISA_PER_BDT + Number(paddedFrac);
  const signed = isNegative ? -paisaAbs : paisaAbs;

  return assertSafePaisa(signed, 'bdtToPaisaResult', { allowNegative });
}

function paisaToBdtString(paisa, { fixedDecimals = false } = {}) {
  assertSafePaisa(paisa, 'paisa', { allowNegative: true });
  const sign = paisa < 0 ? '-' : '';
  const abs = Math.abs(paisa);
  const whole = Math.trunc(abs / PAISA_PER_BDT);
  const rem = abs % PAISA_PER_BDT;

  if (!fixedDecimals && rem === 0) {
    return `${sign}${whole}`;
  }
  return `${sign}${whole}.${String(rem).padStart(2, '0')}`;
}

function formatBdt(paisa, { locale = 'en', fixedDecimals = false } = {}) {
  assertSafePaisa(paisa, 'paisa', { allowNegative: true });
  const sign = paisa < 0 ? '-' : '';
  const abs = Math.abs(paisa);
  const whole = Math.trunc(abs / PAISA_PER_BDT);
  const rem = abs % PAISA_PER_BDT;

  const numLocale = locale === 'bn' ? 'bn-BD' : 'en-BD';
  const formattedWhole = whole.toLocaleString(numLocale);

  if (!fixedDecimals && rem === 0) {
    return `${sign}৳${formattedWhole}`;
  }
  const fracDigits =
    locale === 'bn'
      ? String(rem)
          .padStart(2, '0')
          .replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)])
      : String(rem).padStart(2, '0');
  return `${sign}৳${formattedWhole}.${fracDigits}`;
}

function addPaisa(a, b) {
  assertSafePaisa(a, 'a', { allowNegative: true });
  assertSafePaisa(b, 'b', { allowNegative: true });
  return assertSafePaisa(a + b, 'sumPaisa', { allowNegative: true });
}

function subtractPaisa(a, b, { allowNegative = false } = {}) {
  assertSafePaisa(a, 'a', { allowNegative: true });
  assertSafePaisa(b, 'b', { allowNegative: true });
  return assertSafePaisa(a - b, 'diffPaisa', { allowNegative });
}

function multiplyPaisaByQty(unitPricePaisa, qty) {
  assertSafePaisa(unitPricePaisa, 'unitPricePaisa');
  if (!Number.isSafeInteger(qty) || qty < 0) {
    throw new RangeError(`Quantity must be a non-negative integer (got ${String(qty)}).`);
  }
  return assertSafePaisa(unitPricePaisa * qty, 'lineTotalPaisa');
}

/**
 * Deterministic half-up basis-point percentage calculation:
 * 1000 bps = 10.00%, 250 bps = 2.50%
 */
function calculateBasisPointsPaisa(amountPaisa, rateBps) {
  assertSafePaisa(amountPaisa, 'amountPaisa');
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > BASIS_POINTS_DIVISOR) {
    throw new RangeError(`rateBps must be an integer between 0 and 10000 (got ${String(rateBps)}).`);
  }
  const numerator = amountPaisa * rateBps;
  const result = Math.floor((numerator + BASIS_POINTS_DIVISOR / 2) / BASIS_POINTS_DIVISOR);
  return assertSafePaisa(result, 'percentResultPaisa');
}

/**
 * Authoritative server-side order total & COD balance calculation in paisa.
 */
function computeOrderTotalsPaisa({
  items,
  discountPaisa = 0,
  shippingPaisa = 0,
  advanceRequiredPaisa = 0,
  paidPaisa = 0,
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RangeError('Order must contain at least one line item.');
  }
  assertSafePaisa(discountPaisa, 'discountPaisa');
  assertSafePaisa(shippingPaisa, 'shippingPaisa');
  assertSafePaisa(advanceRequiredPaisa, 'advanceRequiredPaisa');
  assertSafePaisa(paidPaisa, 'paidPaisa');

  let subtotalPaisa = 0;
  const computedItems = items.map((item, idx) => {
    const unitPricePaisa = assertSafePaisa(item.unitPricePaisa, `items[${idx}].unitPricePaisa`);
    const qty = item.qty;
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new RangeError(`items[${idx}].qty must be a positive integer.`);
    }
    const lineTotalPaisa = multiplyPaisaByQty(unitPricePaisa, qty);
    subtotalPaisa = addPaisa(subtotalPaisa, lineTotalPaisa);
    return { ...item, unitPricePaisa, qty, lineTotalPaisa };
  });

  const effectiveDiscountPaisa = Math.min(discountPaisa, subtotalPaisa);
  const totalPaisa = addPaisa(subtotalPaisa - effectiveDiscountPaisa, shippingPaisa);
  const clampedAdvancePaisa = Math.min(advanceRequiredPaisa, totalPaisa);

  if (paidPaisa > totalPaisa) {
    throw new RangeError(`paidPaisa (${paidPaisa}) cannot exceed totalPaisa (${totalPaisa}).`);
  }

  const codDuePaisa = subtractPaisa(totalPaisa, paidPaisa);

  return Object.freeze({
    items: computedItems,
    subtotalPaisa,
    discountPaisa: effectiveDiscountPaisa,
    shippingPaisa,
    totalPaisa,
    advanceRequiredPaisa: clampedAdvancePaisa,
    paidPaisa,
    codDuePaisa,
  });
}

module.exports = {
  PAISA_PER_BDT,
  BASIS_POINTS_DIVISOR,
  assertSafePaisa,
  bdtToPaisa,
  paisaToBdtString,
  formatBdt,
  addPaisa,
  subtractPaisa,
  multiplyPaisaByQty,
  calculateBasisPointsPaisa,
  computeOrderTotalsPaisa,
};
