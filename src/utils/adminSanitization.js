'use strict';

/**
 * Admin Serialization Sanitizer for Courier Integration and Provider Records.
 *
 * Implements strict allowlist-based filtering to guarantee that credentials,
 * refresh tokens, passwords, client secrets, and unknown fields are NEVER
 * serialized into HTML templates, JSON responses, or data-* DOM attributes.
 */

const SAFE_COURIER_OPTIONS_ALLOWLIST = new Set([
  'store_id',
  'city_id',
  'zone_id',
  'area_id',
  'pickup_hub_id',
  'default_weight_grams',
  'delivery_type',
  'item_type',
  'webhook_url',
  'enable_live_rates',
  'sender_name',
  'sender_phone',
  'sender_address'
]);

const DANGEROUS_PATTERNS = [
  /token/i,
  /secret/i,
  /key/i,
  /pass/i,
  /auth/i,
  /cred/i,
  /enc:/i,
  /bearer/i
];

function isSafeStringValue(val) {
  if (typeof val !== 'string') return false;
  if (val.length > 500) return false;
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(val)) return false;
  }
  return true;
}

/**
 * Recursively sanitizes service_options using a strict safe allowlist.
 * Drops all unknown, secret-bearing, or nested non-primitive values.
 *
 * @param {object|string} input Raw service_options_json
 * @returns {string} Sanitized JSON string or empty string
 */
function sanitizeCourierOptionsAllowlist(input) {
  if (!input) return '';
  let obj = input;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch (_e) {
      return '';
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return '';
  }

  const clean = {};
  for (const [key, val] of Object.entries(obj)) {
    const k = String(key).trim();
    // 1. Key must be explicitly present in the safe allowlist
    if (!SAFE_COURIER_OPTIONS_ALLOWLIST.has(k)) {
      continue;
    }
    // 2. Key must not match any dangerous pattern
    let hasDangerousKey = false;
    for (const pat of DANGEROUS_PATTERNS) {
      if (pat.test(k)) {
        hasDangerousKey = true;
        break;
      }
    }
    if (hasDangerousKey) continue;

    // 3. Values must be safe primitives only (reject nested objects/arrays to prevent smuggling)
    if (typeof val === 'number' && Number.isFinite(val)) {
      clean[k] = val;
    } else if (typeof val === 'boolean') {
      clean[k] = val;
    } else if (isSafeStringValue(val)) {
      clean[k] = val.trim();
    }
  }

  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : '';
}

/**
 * Sanitizes an admin courier database record for HTML view and data-record serialization.
 * Applies an explicit allowlist on top-level keys and masks all credentials.
 *
 * @param {object} r Raw database row
 * @returns {object} Sanitized record safe for DOM/JSON serialization
 */
function sanitizeAdminCourierRecord(r) {
  if (!r || typeof r !== 'object') return {};

  return {
    id: Number(r.id) || 0,
    name: String(r.name || ''),
    code: String(r.code || ''),
    base_url: String(r.base_url || ''),
    client_id: String(r.client_id || ''),
    supports_live_quotes: Number(r.supports_live_quotes || 0),
    status: Number(r.status || 0),
    sandbox: Number(r.sandbox || 0),
    api_key: r.api_key ? '••••••••' + String(r.api_key).slice(-4) : '',
    secret_key: r.secret_key ? '••••••••' : '',
    service_options_json: sanitizeCourierOptionsAllowlist(r.service_options_json),
    updated_at: r.updated_at ? String(r.updated_at) : ''
  };
}

module.exports = {
  SAFE_COURIER_OPTIONS_ALLOWLIST,
  sanitizeCourierOptionsAllowlist,
  sanitizeAdminCourierRecord
};
