'use strict';

const { ValidationError } = require('./errors');
const { bdtToPaisa, assertSafePaisa } = require('./money');

const BD_LOCAL_PHONE_REGEX = /^01[3-9]\d{8}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Normalizes Bangladesh mobile numbers (+88017..., 88017..., 017-...) to 11-digit `01XXXXXXXXX`.
 */
function normalizeBdPhone(raw, fieldName = 'phone') {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[\s\-()]/g, '')
    .replace(/^\+?88/, '');
  if (!BD_LOCAL_PHONE_REGEX.test(cleaned)) {
    throw new ValidationError(`Invalid Bangladesh mobile number for "${fieldName}".`, {
      field: fieldName,
      expected: '01[3-9]XXXXXXXX',
    });
  }
  return cleaned;
}

function requireEmail(raw, fieldName = 'email') {
  const cleaned = String(raw || '').trim().toLowerCase();
  if (!EMAIL_REGEX.test(cleaned) || cleaned.length > 191) {
    throw new ValidationError(`Invalid email address for "${fieldName}".`, { field: fieldName });
  }
  return cleaned;
}

function requireString(raw, fieldName, { min = 1, max = 255 } = {}) {
  const str = String(raw ?? '').trim();
  if (str.length < min || str.length > max) {
    throw new ValidationError(
      `"${fieldName}" must be between ${min} and ${max} characters.`,
      { field: fieldName, min, max }
    );
  }
  return str;
}

function requirePositiveInt(raw, fieldName, { min = 1, max = 1_000_000_000 } = {}) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ValidationError(
      `"${fieldName}" must be an integer between ${min} and ${max}.`,
      { field: fieldName, min, max }
    );
  }
  return n;
}

function requirePaisaFromBdt(rawBdt, fieldName = 'amount') {
  try {
    return bdtToPaisa(rawBdt);
  } catch (err) {
    throw new ValidationError(`Invalid monetary amount for "${fieldName}": ${err.message}`, {
      field: fieldName,
    });
  }
}

function requirePaisaInt(rawPaisa, fieldName = 'amountPaisa') {
  try {
    return assertSafePaisa(Number(rawPaisa), fieldName);
  } catch (err) {
    throw new ValidationError(err.message, { field: fieldName });
  }
}

function requireEnum(raw, allowedValues, fieldName) {
  const val = String(raw ?? '').trim();
  if (!allowedValues.includes(val)) {
    throw new ValidationError(
      `"${fieldName}" must be one of: ${allowedValues.join(', ')}.`,
      { field: fieldName, allowed: allowedValues }
    );
  }
  return val;
}

module.exports = {
  BD_LOCAL_PHONE_REGEX,
  normalizeBdPhone,
  requireEmail,
  requireString,
  requirePositiveInt,
  requirePaisaFromBdt,
  requirePaisaInt,
  requireEnum,
};
