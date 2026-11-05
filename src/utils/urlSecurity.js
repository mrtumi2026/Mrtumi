'use strict';

/**
 * URL Security Utilities
 * Prevents open redirect and header injection attacks across public and customer forms.
 */

/**
 * Validates and extracts a safe local relative redirect path from a Referer header or returnTo parameter.
 * Strictly blocks external origins, scheme-relative URLs ('//evil.com'), control characters, and backslashes.
 * Rejects same-host absolute URLs whose extracted pathname begins with '//' or contains protocol-relative evasion.
 *
 * @param {import('express').Request} req - Express request object
 * @param {string} fallback - Safe fallback relative path (e.g. '/contact' or '/')
 * @returns {string} Safe relative path
 */
function safeReferrer(req, fallback = '/') {
  const safeFallback = (typeof fallback === 'string' && fallback.startsWith('/') && !fallback.startsWith('//'))
    ? fallback
    : '/';

  const rawReferer = req.get('Referrer') || req.get('Referer') || req.body?.return_to || req.query?.return_to;
  if (!rawReferer || typeof rawReferer !== 'string') {
    return safeFallback;
  }

  const trimmed = rawReferer.trim();

  // Reject CR/LF, backslashes, or control characters that could induce header injection
  if (/[\r\n\x00-\x1f\\]/.test(trimmed)) {
    return safeFallback;
  }

  // Reject protocol-relative URLs (e.g. '//evil.com' or '///evil.com')
  if (trimmed.startsWith('//')) {
    return safeFallback;
  }

  // Case 1: Already a relative path starting with a single '/'
  if (trimmed.startsWith('/')) {
    try {
      const dummyOrigin = 'http://mrtumi.internal';
      const parsed = new URL(trimmed, dummyOrigin);
      // Ensure the URL did not parse to a different origin
      if (parsed.origin !== dummyOrigin) {
        return safeFallback;
      }
      const extractedPath = parsed.pathname;
      if (!extractedPath || !extractedPath.startsWith('/') || extractedPath.startsWith('//')) {
        return safeFallback;
      }
      return `${extractedPath}${parsed.search}`;
    } catch (_err) {
      return safeFallback;
    }
  }

  // Case 2: Absolute URL — only allow if hostname exactly matches the current request's Host header
  try {
    const parsed = new URL(trimmed);
    const host = String(req.get('host') || '').toLowerCase().trim();
    if (!host) {
      return safeFallback;
    }

    const parsedHost = parsed.host.toLowerCase().trim();
    if (parsedHost === host) {
      const extractedPath = parsed.pathname;
      // CRITICAL: Reject if extracted path begins with '//' (e.g. 'https://mrtumi.com//evil.com')
      // as Express res.redirect('//evil.com') treats it as a protocol-relative external redirect.
      if (
        !extractedPath ||
        !extractedPath.startsWith('/') ||
        extractedPath.startsWith('//') ||
        /[\r\n\x00-\x1f\\]/.test(extractedPath)
      ) {
        return safeFallback;
      }
      return `${extractedPath}${parsed.search}`;
    }
  } catch (_err) {
    return safeFallback;
  }

  // Any external or unparseable origin falls back safely
  return safeFallback;
}

module.exports = {
  safeReferrer,
};
