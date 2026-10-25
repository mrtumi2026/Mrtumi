'use strict';

/**
 * PHASE 04: Bilingual Localization Core (`bn` default, `en` alternate)
 */

const bn = require('./locales/bn');
const en = require('./locales/en');
const { createBoundFormatters } = require('../utils/formatters');

const SUPPORTED_LOCALES = Object.freeze(['bn', 'en']);
const DEFAULT_LOCALE = 'bn';

const DICTIONARIES = Object.freeze({
  bn,
  en,
});

/**
 * Normalize an arbitrary locale hint (`bn`, `bn-BD`, `en-US`, etc.) to `'bn'` or `'en'`.
 * Always defaults to `'bn'` when missing or unsupported.
 *
 * @param {string|undefined|null} rawLocale
 * @param {'bn'|'en'} [fallback='bn']
 * @returns {'bn'|'en'}
 */
function normalizeLocale(rawLocale, fallback = DEFAULT_LOCALE) {
  if (!rawLocale || typeof rawLocale !== 'string') {
    return SUPPORTED_LOCALES.includes(fallback) ? fallback : DEFAULT_LOCALE;
  }
  const base = rawLocale.trim().toLowerCase().split(/[-_]/)[0];
  if (SUPPORTED_LOCALES.includes(base)) {
    return /** @type {'bn'|'en'} */ (base);
  }
  return SUPPORTED_LOCALES.includes(fallback) ? fallback : DEFAULT_LOCALE;
}

/**
 * Safely resolve a dotted path (`store.heroTitle`) inside a dictionary object.
 * @param {Record<string, any>} dict
 * @param {string} key
 * @returns {string|undefined}
 */
function getNestedValue(dict, key) {
  if (!dict || !key || typeof key !== 'string') return undefined;
  const parts = key.split('.');
  let cur = dict;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) {
      return undefined;
    }
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Interpolate `{token}` placeholders safely.
 * @param {string} template
 * @param {Record<string, any>} [vars={}]
 * @returns {string}
 */
function interpolate(template, vars = {}) {
  if (!vars || typeof vars !== 'object') return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null) {
      return String(vars[name]);
    }
    return '';
  });
}

/**
 * Translate a key into the requested locale (`bn` fallback, human-friendly last-segment safety net).
 * Never emits raw dotted keys like `store.heroTitle` into visible UI.
 *
 * @param {'bn'|'en'} locale
 * @param {string} key
 * @param {Record<string, any>} [vars={}]
 * @param {string} [explicitFallback]
 * @returns {string}
 */
function translate(locale, key, vars = {}, explicitFallback) {
  const safeLocale = normalizeLocale(locale);
  const primary = getNestedValue(DICTIONARIES[safeLocale], key);
  if (primary !== undefined) {
    return interpolate(primary, vars);
  }
  const fallbackBn = getNestedValue(DICTIONARIES.bn, key);
  if (fallbackBn !== undefined) {
    return interpolate(fallbackBn, vars);
  }
  if (typeof explicitFallback === 'string') {
    return interpolate(explicitFallback, vars);
  }
  // Last-resort humanization so raw dotted keys never leak to customers
  const tail = String(key || '').split('.').pop() || '';
  return tail
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Flatten nested dictionary keys (`['a.b', 'a.c', ...]`) for parity audits & tests.
 * @param {Record<string, any>} obj
 * @param {string} [prefix='']
 * @returns {string[]}
 */
function flattenDictionaryKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenDictionaryKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys.sort();
}

/**
 * Create bound i18n context for an HTTP request / template render.
 * @param {string} rawLocale
 */
function createI18nContext(rawLocale) {
  const locale = normalizeLocale(rawLocale);
  const fmt = createBoundFormatters(locale);
  return {
    locale,
    htmlLang: locale,
    isBangla: locale === 'bn',
    isEnglish: locale === 'en',
    t: (key, vars, fallback) => translate(locale, key, vars, fallback),
    fmt,
  };
}

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  DICTIONARIES,
  normalizeLocale,
  getNestedValue,
  translate,
  flattenDictionaryKeys,
  createI18nContext,
};
