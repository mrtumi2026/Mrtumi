'use strict';

/**
 * Structured PII-Redacting & Secret-Safe Logger
 * Redacts passwords, secrets, tokens, cookies, and masks Bangladesh phone numbers.
 */

const SENSITIVE_KEY_REGEX =
  /(password|pass|secret|token|otp|pin|recovery_?token|api_?key|authorization|cookie|csrf|bearer|private_?key|trx_secret|trx_?id|transaction_?id|provider_?trx_?id|account_?number|account_?no|bank_?account|payout_?account|sender_?number|destination|e-?mail|address|street|customer_?name|recipient_?name|owner_?name|card_?number|cvv)/i;

const BD_PHONE_IN_TEXT_REGEX = /\b(\+?8801[3-9]\d{2}|01[3-9]\d{2})\d{4}(\d{2})\b/g;
const EMAIL_IN_TEXT_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_AUTH_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const FINANCIAL_LOG_KEY_REGEX = /(amount|balance|paisa|price|payment|subtotal|total|commission|withdrawal|payout|transaction|financial)/i;

function maskPhone(str) {
  return String(str).replace(BD_PHONE_IN_TEXT_REGEX, '$1****$2');
}

function maskSensitiveText(str) {
  return maskPhone(str)
    .replace(EMAIL_IN_TEXT_REGEX, '[REDACTED_EMAIL]')
    .replace(BEARER_AUTH_REGEX, 'Bearer [REDACTED_SECRET]');
}

function redactValue(val, depth = 0, redactFinancial = false) {
  if (depth > 5) return '[MaxDepth]';
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    return maskSensitiveText(val);
  }
  if (typeof val !== 'object') return val;
  if (val instanceof Error) {
    return {
      name: val.name,
      code: val.code || undefined,
      message: redactFinancial ? '[REDACTED]' : maskSensitiveText(val.message || ''),
    };
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactValue(item, depth + 1, redactFinancial));
  }

  const clean = {};
  for (const [k, v] of Object.entries(val)) {
    if (SENSITIVE_KEY_REGEX.test(k) || (redactFinancial && FINANCIAL_LOG_KEY_REGEX.test(k))) {
      clean[k] = '[REDACTED]';
    } else if (/phone|mobile|recipient|sender_number/i.test(k) && typeof v === 'string') {
      clean[k] = maskPhone(v);
    } else {
      clean[k] = redactValue(v, depth + 1, redactFinancial);
    }
  }
  return clean;
}

function emit(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: maskSensitiveText(String(message)),
    ...(meta && Object.keys(meta).length > 0 ? { meta: redactValue(meta, 0, true) } : {}),
  };

  if (process.env.LOG_SILENT === 'true') {
    return entry;
  }

  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
  return entry;
}

const logger = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => {
    if (process.env.LOG_LEVEL === 'debug') {
      return emit('debug', msg, meta);
    }
    return null;
  },
  redactValue,
  redactObject: redactValue,
  maskPhone,
  maskSensitiveText,
};

logger.logger = logger;
module.exports = logger;
