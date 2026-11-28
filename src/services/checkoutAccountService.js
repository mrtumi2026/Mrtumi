'use strict';

/*
 * Orders need no OTP. When the delivery mobile number already has an account with a password,
 * a buyer who is not signed in types that password; a match places the order on that account.
 * New numbers, and accounts that never set a password, need nothing extra.
 */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const { consumeLoginBucket } = require('../repositories/loginRateLimitRepository');
const { normalizeBdPhone } = require('../utils/validator');
const { AccountPasswordError, RateLimitError } = require('../utils/errors');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP_PHONE = 12;
const MAX_PER_IP = 300;
const REQUIRED_MESSAGE = 'This mobile number already has an account. Enter its password to place the order.';
const WRONG_MESSAGE = 'The account password does not match. Try again, or use Forgot password.';

const hash = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

async function findPasswordAccount(phone, db = null) {
  const q = db || createQueryClient(getPool());
  const row = await q.queryOne("SELECT id,name,phone,password_hash FROM customers WHERE phone=? AND password_hash<>'' AND status=1 AND is_blocked=0 LIMIT 1", [normalizeBdPhone(phone)]);
  return row || null;
}

function signedInAs(sessionCustomer, phone) {
  if (!sessionCustomer?.id) return false;
  try { return normalizeBdPhone(sessionCustomer.phone) === normalizeBdPhone(phone); } catch (_error) { return false; }
}

async function limitGuesses(ip, phone, consume) {
  for (const [bucketKey, max] of [[`checkout-password:ip:${hash(ip)}`, MAX_PER_IP], [`checkout-password:pair:${hash(ip)}:${hash(phone)}`, MAX_PER_IP_PHONE]]) {
    const outcome = await consume({ bucketKey, max, windowMs: WINDOW_MS });
    if (!outcome.allowed) throw new RateLimitError('Too many password tries. Wait 15 minutes, or use Forgot password.', outcome.retryAfterSec);
  }
}

/** Tells the checkout form whether a password is needed and whether the typed one matches. */
async function checkAccount({ phone, password = '', sessionCustomer = null, ip = '' }, { db = null, consume = consumeLoginBucket } = {}) {
  if (env.db.client !== 'mysql' && !db) return { passwordRequired: false, passwordOk: false, accountId: null };
  const clean = normalizeBdPhone(phone);
  // A signed-in buyer ordering to their own number has already proved the password.
  if (signedInAs(sessionCustomer, clean) || sessionCustomer?.id) return { passwordRequired: false, passwordOk: false, accountId: null };
  const account = await findPasswordAccount(clean, db);
  if (!account) return { passwordRequired: false, passwordOk: false, accountId: null };
  const typed = String(password || '');
  if (!typed) return { passwordRequired: true, passwordOk: false, accountId: null };
  await limitGuesses(ip, clean, consume);
  const ok = typed.length <= 72 && await bcrypt.compare(typed, account.password_hash);
  return { passwordRequired: true, passwordOk: ok, accountId: ok ? Number(account.id) : null };
}

/** Used by every order route before the order is written. Returns the proven account ID, or null. */
async function resolveCheckoutAccount(input, deps) {
  if (!String(input.password || '')) return null;
  const result = await checkAccount(input, deps);
  if (result.passwordRequired && !result.passwordOk) throw new AccountPasswordError(WRONG_MESSAGE);
  return result.accountId;
}

module.exports = { findPasswordAccount, checkAccount, resolveCheckoutAccount, REQUIRED_MESSAGE, WRONG_MESSAGE };
