'use strict';

/*
 * Orders need no OTP. Confirming an order takes the account password, signed in or not:
 *  - a signed-in buyer types their own account's password;
 *  - a guest whose delivery mobile number already has an account types that account's password,
 *    and a match places the order on it.
 * New numbers, and accounts that never set a password, have no password to ask for.
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
const SIGNED_IN_MESSAGE = 'Enter your account password to confirm this order.';
const WRONG_MESSAGE = 'The account password does not match. Try again, or use Forgot password.';

const hash = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

async function findPasswordAccount(phone, db = null) {
  const q = db || createQueryClient(getPool());
  const row = await q.queryOne("SELECT id,name,phone,password_hash FROM customers WHERE phone=? AND password_hash<>'' AND status=1 AND is_blocked=0 LIMIT 1", [normalizeBdPhone(phone)]);
  return row || null;
}

async function findSessionAccount(id, db = null) {
  const q = db || createQueryClient(getPool());
  const row = await q.queryOne("SELECT id,name,phone,password_hash FROM customers WHERE id=? AND password_hash<>'' AND status=1 AND is_blocked=0 LIMIT 1", [Number(id)]);
  return row || null;
}

async function limitGuesses(ip, phone, consume) {
  for (const [bucketKey, max] of [[`checkout-password:ip:${hash(ip)}`, MAX_PER_IP], [`checkout-password:pair:${hash(ip)}:${hash(phone)}`, MAX_PER_IP_PHONE]]) {
    const outcome = await consume({ bucketKey, max, windowMs: WINDOW_MS });
    if (!outcome.allowed) throw new RateLimitError('Too many password tries. Wait 15 minutes, or use Forgot password.', outcome.retryAfterSec);
  }
}

/** Tells the checkout form whether a password is needed and whether the typed one matches. */
async function checkAccount({ phone, password = '', sessionCustomer = null, ip = '' }, { db = null, consume = consumeLoginBucket } = {}) {
  const none = { passwordRequired: false, passwordOk: false, accountId: null };
  if (env.db.client !== 'mysql' && !db) return none;
  const signedIn = Boolean(sessionCustomer?.id);
  const clean = signedIn ? '' : normalizeBdPhone(phone);
  const account = signedIn ? await findSessionAccount(sessionCustomer.id, db) : await findPasswordAccount(clean, db);
  if (!account) return none;
  const needed = { passwordRequired: true, passwordOk: false, accountId: null, signedIn };
  const typed = String(password || '');
  if (!typed) return needed;
  await limitGuesses(ip, signedIn ? `id:${account.id}` : clean, consume);
  const ok = typed.length <= 72 && await bcrypt.compare(typed, account.password_hash);
  return ok ? { ...needed, passwordOk: true, accountId: Number(account.id) } : needed;
}

/** Used by every order route before the order is written. Returns the proven account ID, or null. */
async function resolveCheckoutAccount(input, deps) {
  const typed = String(input.password || '');
  // A guest who typed nothing is stopped by the order transaction if the number has an account.
  if (!typed && !input.sessionCustomer?.id) return null;
  const result = await checkAccount(input, deps);
  if (result.passwordRequired && !result.passwordOk) throw new AccountPasswordError(typed ? WRONG_MESSAGE : SIGNED_IN_MESSAGE);
  return result.accountId;
}

module.exports = { findPasswordAccount, checkAccount, resolveCheckoutAccount, REQUIRED_MESSAGE, SIGNED_IN_MESSAGE, WRONG_MESSAGE };
