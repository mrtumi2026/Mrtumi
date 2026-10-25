'use strict';

/**
 * PHASE 04: Language Switcher Route (`bn` <-> `en`)
 *
 * Supports both `GET /locale/:lang?returnTo=/...` (link-based, progressive enhancement,
 * works without JavaScript) and `POST /locale` / JSON API response.
 */

const express = require('express');
const { normalizeLocale, SUPPORTED_LOCALES } = require('../i18n');
const { sanitizeReturnTo, persistLocalePreference } = require('../middleware/i18n');
const { sendSuccess } = require('../utils/apiResponse');

const router = express.Router();

function resolveRedirectTarget(req) {
  const explicit = req.query?.returnTo || req.body?.returnTo;
  if (explicit) {
    return sanitizeReturnTo(String(explicit));
  }
  const referer = req.get('referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      return sanitizeReturnTo(`${refUrl.pathname}${refUrl.search}`);
    } catch (_err) {
      return '/';
    }
  }
  return '/';
}

function appendSidIfNeeded(targetUrl, sid) {
  if (!sid || typeof sid !== 'string' || !/^[a-f0-9]{16,128}$/i.test(sid)) {
    return targetUrl;
  }
  try {
    const parsed = new URL(targetUrl, 'http://mrtumi.local');
    if (!parsed.searchParams.has('_sid')) {
      parsed.searchParams.set('_sid', sid);
    }
    const qs = parsed.searchParams.toString();
    return `${parsed.pathname}${qs ? `?${qs}` : ''}`;
  } catch (_err) {
    return targetUrl;
  }
}

router.get('/locale/:lang', (req, res) => {
  const requested = String(req.params.lang || '').trim().toLowerCase();
  const locale = SUPPORTED_LOCALES.includes(requested) ? normalizeLocale(requested) : 'bn';
  persistLocalePreference(req, res, locale);

  const sid = typeof req.query?._sid === 'string' ? req.query._sid : '';
  const target = appendSidIfNeeded(resolveRedirectTarget(req), sid);

  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html'))) {
    return sendSuccess(res, { locale, redirectTo: target });
  }
  return res.redirect(302, target);
});

router.post('/locale', (req, res) => {
  const requested = String(req.body?.lang || req.query?.lang || '').trim().toLowerCase();
  const locale = SUPPORTED_LOCALES.includes(requested) ? normalizeLocale(requested) : 'bn';
  persistLocalePreference(req, res, locale);

  const sid = typeof req.query?._sid === 'string' ? req.query._sid : '';
  const target = appendSidIfNeeded(resolveRedirectTarget(req), sid);

  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html'))) {
    return sendSuccess(res, { locale, redirectTo: target });
  }
  return res.redirect(303, target);
});

module.exports = router;
