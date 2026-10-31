'use strict';

/**
 * PHASE 04: Centralized Bangladesh Money (`BDT / ৳`), Numeral & `Asia/Dhaka` Date Formatters
 *
 * Supports both Bangla (`bn`) and English (`en`) UI rendering with deterministic
 * Indian-subcontinent digit grouping (`1,35,000`) and Bangla numerals (`০-৯`)
 * without depending on OS-specific full-ICU builds on shared cPanel hosts.
 */

const { toPaisa, fromPaisa } = require('./money');

const BANGLA_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

const BANGLA_MONTHS_SHORT = [
  'জানু',
  'ফেব্রু',
  'মার্চ',
  'এপ্রিল',
  'মে',
  'জুন',
  'জুলাই',
  'আগস্ট',
  'সেপ্টে',
  'অক্টো',
  'নভে',
  'ডিসে',
];

const ENGLISH_MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Convert ASCII digits (`0-9`) in a string to Bangla digits (`০-৯`).
 * @param {string|number} value
 * @returns {string}
 */
function toBanglaDigits(value) {
  return String(value ?? '').replace(/[0-9]/g, (d) => BANGLA_DIGITS[Number(d)]);
}

/**
 * Format an integer string with South Asian (`lakh`/`crore`: 3,2,2...) comma grouping.
 * @param {string} unsignedDigits
 * @returns {string}
 */
function groupSouthAsianDigits(unsignedDigits) {
  const clean = String(unsignedDigits).replace(/^0+(?=\d)/, '');
  if (clean.length <= 3) return clean;
  const lastThree = clean.slice(-3);
  const leading = clean.slice(0, -3);
  const groupedLeading = leading.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${groupedLeading},${lastThree}`;
}

/**
 * Format a numeric count or quantity according to active locale (`bn` | `en`).
 * @param {number|string} value
 * @param {'bn'|'en'} [locale='bn']
 * @param {{ decimals?: number, useGrouping?: boolean }} [options]
 * @returns {string}
 */
function formatLocalizedNumber(value, locale = 'bn', options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return locale === 'en' ? '0' : '০';
  }
  const decimals = Number.isInteger(options.decimals) ? options.decimals : 0;
  const useGrouping = options.useGrouping !== false;
  const sign = num < 0 ? '-' : '';
  const fixed = Math.abs(num).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const groupedInt = useGrouping ? groupSouthAsianDigits(intPart) : intPart;
  const combined = decPart !== undefined ? `${sign}${groupedInt}.${decPart}` : `${sign}${groupedInt}`;
  return locale === 'en' ? combined : toBanglaDigits(combined);
}

/**
 * Format exact integer `paisa` (`1 BDT = 100 paisa`) for `bn` or `en` UI display.
 * @param {number|string|bigint} paisaValue
 * @param {'bn'|'en'} [locale='bn']
 * @param {{ showDecimals?: boolean, symbol?: string }} [options]
 * @returns {string}
 */
function formatPaisaDisplay(paisaValue, locale = 'bn', options = {}) {
  const parsed = Number(paisaValue ?? 0);
  const safePaisa = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  const sign = safePaisa < 0 ? '-' : '';
  const absPaisa = Math.abs(safePaisa);
  const hasSubUnit = absPaisa % 100 !== 0;
  const showDecimals = Boolean(options.showDecimals || hasSubUnit);
  const symbol = options.symbol !== undefined ? options.symbol : '৳';

  const bdtWhole = Math.trunc(absPaisa / 100);
  const groupedWhole = groupSouthAsianDigits(String(bdtWhole));
  const remainder = String(absPaisa % 100).padStart(2, '0');
  const rawNumber = showDecimals ? `${groupedWhole}.${remainder}` : groupedWhole;
  const localizedNumber = locale === 'en' ? rawNumber : toBanglaDigits(rawNumber);
  return `${sign}${symbol}${localizedNumber}`;
}

/**
 * Format a major-unit BDT amount safely via integer `paisa` conversion.
 * Compatible with existing Phase 01-03 views while Phase 05-18 route migrations complete.
 * @param {number|string} bdtAmount
 * @param {'bn'|'en'} [locale='bn']
 * @param {{ showDecimals?: boolean, symbol?: string }} [options]
 * @returns {string}
 */
function formatBdtDisplay(bdtAmount, locale = 'bn', options = {}) {
  if (bdtAmount === null || bdtAmount === undefined || bdtAmount === '') {
    return formatPaisaDisplay(0, locale, options);
  }
  try {
    const paisa = toPaisa(bdtAmount);
    return formatPaisaDisplay(paisa, locale, options);
  } catch (_err) {
    const fallbackNum = Number(bdtAmount);
    if (!Number.isFinite(fallbackNum)) {
      return formatPaisaDisplay(0, locale, options);
    }
    return formatPaisaDisplay(Math.round(fallbackNum * 100), locale, options);
  }
}

/**
 * Parse SQLite (`YYYY-MM-DD HH:MM:SS`), MySQL, ISO-8601, or Date objects safely.
 * Bare SQL timestamps (`YYYY-MM-DD HH:MM:SS`) from UTC `CURRENT_TIMESTAMP` are treated as UTC.
 * @param {Date|string|number} input
 * @returns {Date|null}
 */
function parseTimestamp(input) {
  if (!input) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const raw = String(input).trim();
  if (!raw) return null;

  // Bare SQL date (`YYYY-MM-DD`) -> anchor at noon UTC so date never shifts across zones
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Bare SQL datetime (`YYYY-MM-DD HH:MM:SS`) -> UTC
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    const d = new Date(`${raw.replace(/\s+/, 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract `Asia/Dhaka` (`UTC+06:00`) calendar parts deterministically.
 * Bangladesh does not observe DST (`UTC+06:00` year-round).
 * @param {Date} date
 */
function getDhakaParts(date) {
  const dhakaEpochMs = date.getTime() + 6 * 60 * 60 * 1000;
  const shifted = new Date(dhakaEpochMs);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hours24: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

/**
 * Format a date in `Asia/Dhaka` timezone (`25 Oct 2026` / `২৫ অক্টো ২০২৬`).
 * @param {Date|string|number} input
 * @param {'bn'|'en'} [locale='bn']
 * @returns {string}
 */
function formatDhakaDate(input, locale = 'bn') {
  const parsed = parseTimestamp(input);
  if (!parsed) return '—';
  const { year, monthIndex, day } = getDhakaParts(parsed);
  const dayStr = String(day).padStart(2, '0');
  if (locale === 'en') {
    return `${dayStr} ${ENGLISH_MONTHS_SHORT[monthIndex]} ${year}`;
  }
  return `${toBanglaDigits(dayStr)} ${BANGLA_MONTHS_SHORT[monthIndex]} ${toBanglaDigits(year)}`;
}

/**
 * Format a date + 12-hour clock time in `Asia/Dhaka` (`UTC+06:00`).
 * @param {Date|string|number} input
 * @param {'bn'|'en'} [locale='bn']
 * @returns {string}
 */
function formatDhakaDateTime(input, locale = 'bn') {
  const parsed = parseTimestamp(input);
  if (!parsed) return '—';
  const { year, monthIndex, day, hours24, minutes } = getDhakaParts(parsed);
  const dayStr = String(day).padStart(2, '0');
  const hour12 = hours24 % 12 || 12;
  const hourStr = String(hour12).padStart(2, '0');
  const minStr = String(minutes).padStart(2, '0');

  if (locale === 'en') {
    const period = hours24 >= 12 ? 'PM' : 'AM';
    return `${dayStr} ${ENGLISH_MONTHS_SHORT[monthIndex]} ${year}, ${hourStr}:${minStr} ${period}`;
  }

  const bnPeriod = hours24 >= 12 ? 'অপরাহ্ণ' : 'পূর্বাহ্ণ';
  return `${toBanglaDigits(dayStr)} ${BANGLA_MONTHS_SHORT[monthIndex]} ${toBanglaDigits(year)}, ${toBanglaDigits(hourStr)}:${toBanglaDigits(minStr)} ${bnPeriod}`;
}

/**
 * Build bound formatter helpers for templates (`res.locals.fmt`).
 * @param {'bn'|'en'} locale
 */
function createBoundFormatters(locale = 'bn') {
  return {
    bdt: (amount, opts) => formatBdtDisplay(amount, locale, opts),
    paisa: (paisa, opts) => formatPaisaDisplay(paisa, locale, opts),
    number: (val, opts) => formatLocalizedNumber(val, locale, opts),
    digits: (val) => (locale === 'en' ? String(val ?? '') : toBanglaDigits(val)),
    date: (val) => formatDhakaDate(val, locale),
    dateTime: (val) => formatDhakaDateTime(val, locale),
    fromPaisa,
  };
}

module.exports = {
  toBanglaDigits,
  groupSouthAsianDigits,
  formatLocalizedNumber,
  formatPaisaDisplay,
  formatBdtDisplay,
  formatDhakaDate,
  formatDhakaDateTime,
  createBoundFormatters,
};
