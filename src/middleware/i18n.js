'use strict';

/**
 * PHASE 04: Request Locale Resolution & Persistence Middleware
 *
 * Resolution precedence:
 *   1. Explicit `?lang=bn|en` query parameter (also persists preference)
 *   2. Active server session (`req.session.locale`)
 *   3. `mrtumi_lang` browser cookie
 *   4. `env.defaultLocale` (`'bn'`)
 */

const { env } = require('../config/env');
const { SUPPORTED_LOCALES, normalizeLocale, createI18nContext } = require('../i18n');

const LOCALE_COOKIE_NAME = 'mrtumi_lang';
const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return map;
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try {
        map[k] = decodeURIComponent(v);
      } catch (_e) {
        map[k] = v;
      }
    }
  });
  return map;
}

/**
 * Sanitize a `returnTo` path so locale switching can NEVER be abused as an open redirect.
 * Only permits relative paths starting with a single `/` and no protocol/backslash/CRLF.
 *
 * @param {string|undefined|null} candidate
 * @returns {string}
 */
function sanitizeReturnTo(candidate) {
  if (!candidate || typeof candidate !== 'string') return '/';
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/';
  if (/[\r\n\\]/.test(trimmed)) return '/';
  try {
    const parsed = new URL(trimmed, 'http://mrtumi.local');
    if (parsed.origin !== 'http://mrtumi.local') return '/';
    // Strip stale `lang` query param when switching via `/locale/:lang` so future toggles aren't pinned
    parsed.searchParams.delete('lang');
    const qs = parsed.searchParams.toString();
    return `${parsed.pathname}${qs ? `?${qs}` : ''}`;
  } catch (_err) {
    return '/';
  }
}

/**
 * Persist chosen locale to cookie (appending cleanly to existing Set-Cookie headers) + session.
 */
function persistLocalePreference(req, res, locale) {
  const safeLocale = normalizeLocale(locale, env.defaultLocale);
  if (req.session && typeof req.session === 'object') {
    req.session.locale = safeLocale;
  }

  const securePart = env.cookieSecure || env.isProduction ? '; Secure' : '';
  const cookieStr = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(safeLocale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${securePart}`;

  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieStr]);
  } else if (Array.isArray(existing)) {
    const filtered = existing.filter((c) => !String(c).startsWith(`${LOCALE_COOKIE_NAME}=`));
    res.setHeader('Set-Cookie', [...filtered, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookieStr]);
  }
}

/**
 * Build a language-switch URL back to the current page while preserving `_sid` iframe token if present.
 */
function buildLocaleSwitchUrl(req, targetLocale) {
  const safeTarget = normalizeLocale(targetLocale);
  const returnTo = sanitizeReturnTo(req.originalUrl || req.url || '/');
  const params = new URLSearchParams();
  params.set('returnTo', returnTo);
  if (req.query && typeof req.query._sid === 'string' && req.query._sid) {
    params.set('_sid', req.query._sid);
  }
  return `/locale/${safeTarget}?${params.toString()}`;
}

function i18nMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.trim().toLowerCase() : '';

  let activeLocale = normalizeLocale(env.defaultLocale, 'bn');

  if (queryLang && SUPPORTED_LOCALES.includes(queryLang)) {
    activeLocale = normalizeLocale(queryLang);
    persistLocalePreference(req, res, activeLocale);
  } else if (req.session && typeof req.session.locale === 'string' && SUPPORTED_LOCALES.includes(req.session.locale)) {
    activeLocale = normalizeLocale(req.session.locale);
  } else if (cookies[LOCALE_COOKIE_NAME] && SUPPORTED_LOCALES.includes(cookies[LOCALE_COOKIE_NAME])) {
    activeLocale = normalizeLocale(cookies[LOCALE_COOKIE_NAME]);
    if (req.session && typeof req.session === 'object' && !req.session.locale) {
      req.session.locale = activeLocale;
    }
  }

  const ctx = createI18nContext(activeLocale);

  req.locale = ctx.locale;
  req.t = ctx.t;
  req.fmt = ctx.fmt;

  res.locals.locale = ctx.locale;
  res.locals.htmlLang = ctx.htmlLang;
  res.locals.isBangla = ctx.isBangla;
  res.locals.isEnglish = ctx.isEnglish;
  res.locals.t = ctx.t;
  res.locals.fmt = ctx.fmt;
  res.locals.switchUrls = {
    bn: buildLocaleSwitchUrl(req, 'bn'),
    en: buildLocaleSwitchUrl(req, 'en'),
  };

  res.setHeader('Content-Language', ctx.locale);
  return next();
}

module.exports = {
  LOCALE_COOKIE_NAME,
  sanitizeReturnTo,
  persistLocalePreference,
  buildLocaleSwitchUrl,
  i18nMiddleware,
};
