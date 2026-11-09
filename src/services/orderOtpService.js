'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const { normalizeBdPhone } = require('../utils/validator');
const { ValidationError, ConflictError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const smsService = require('./smsService');
const settingsRepository = require('../repositories/settingsRepository');
const sqliteDb = require('../db/database');
const { getPool, createQueryClient } = require('../db/mysqlPool');

function isMysql() {
  return env.db.client === 'mysql';
}

function otpDigest(phone, code, secret = env.sessionSecret) {
  return crypto.createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
}

function makeOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function safeHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function getOtpSettings() {
  try {
    if (isMysql()) {
      const keys = ['otp_mode', 'otp_expiry_seconds', 'otp_max_attempts', 'otp_cooldown_seconds', 'otp_max_per_hour'];
      const db = createQueryClient(getPool());
      const rows = await db.queryAll(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`, keys);
      const map = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
      return {
        enabled: map.otp_mode === 'on',
        expirySeconds: Number(map.otp_expiry_seconds || 300),
        maxAttempts: Number(map.otp_max_attempts || 5),
        cooldownSeconds: Number(map.otp_cooldown_seconds || 60),
        maxPerHour: Number(map.otp_max_per_hour || 5)
      };
    }
    const settings = sqliteDb.getSettings();
    return {
      enabled: settings.otp_mode === 'on',
      expirySeconds: Number(settings.otp_expiry_seconds || 300),
      maxAttempts: Number(settings.otp_max_attempts || 5),
      cooldownSeconds: Number(settings.otp_cooldown_seconds || 60),
      maxPerHour: Number(settings.otp_max_per_hour || 5)
    };
  } catch (_e) {
    return {
      enabled: false,
      expirySeconds: 300,
      maxAttempts: 5,
      cooldownSeconds: 60,
      maxPerHour: 5
    };
  }
}

/**
 * Request an OTP for Checkout
 */
async function requestCheckoutOtp({ phone, sessionSid = '', customerId = null }) {
  const normalizedPhone = normalizeBdPhone(phone);
  if (!/^01[3-9]\d{8}$/.test(normalizedPhone)) {
    throw new ValidationError('১১ সংখ্যার সঠিক বাংলাদেশী মোবাইল নম্বর দিন (যেমন: 017XXXXXXXX)।');
  }

  const policy = await getOtpSettings();
  const sidHash = safeHash(sessionSid || 'anonymous_checkout_session');
  const code = makeOtp();
  const digest = otpDigest(normalizedPhone, code);
  const expirySec = Math.max(60, Math.min(900, policy.expirySeconds));
  const expiresAt = new Date(Date.now() + expirySec * 1000);

  if (isMysql()) {
    const db = createQueryClient(getPool());
    // Bounded rate limits
    const issueKey = `order_otp:issue:${safeHash(normalizedPhone).slice(0, 48)}`;
    const cooldownKey = `order_otp:cool:${safeHash(`${normalizedPhone}|${sidHash}`).slice(0, 48)}`;

    async function incrementBucket(key, seconds) {
      await db.execute(
        'INSERT INTO rate_limits (bucket_key, hit_count, reset_at) VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)) ON DUPLICATE KEY UPDATE hit_count=IF(reset_at<=UTC_TIMESTAMP(), 1, hit_count+1), reset_at=IF(reset_at<=UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), reset_at)',
        [key, seconds, seconds]
      );
      const row = await db.queryOne('SELECT hit_count FROM rate_limits WHERE bucket_key=?', [key]);
      return Number(row?.hit_count || 0);
    }

    const issued = await incrementBucket(issueKey, 3600);
    if (issued > policy.maxPerHour) {
      throw new ConflictError('এক ঘণ্টার মধ্যে ওটিপি অনুরোধের সীমা অতিক্রম করেছে। কিছুক্ষণ পরে চেষ্টা করুন।');
    }
    const cooldown = await incrementBucket(cooldownKey, policy.cooldownSeconds);
    if (cooldown > 1) {
      throw new ConflictError('নতুন ওটিপি কোড চাওয়ার আগে কিছুক্ষণ অপেক্ষা করুন।');
    }

    await db.execute(
      'INSERT INTO order_otps (phone, session_hash, customer_id, otp_hash, attempts, max_attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [normalizedPhone, sidHash, customerId || null, digest, policy.maxAttempts, expiresAt]
    );
  } else {
    // SQLite storage
    try {
      sqliteDb.run(
        'INSERT INTO order_otps (phone, session_hash, customer_id, otp_hash, attempts, max_attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        normalizedPhone,
        sidHash,
        customerId || null,
        digest,
        policy.maxAttempts,
        expiresAt.toISOString()
      );
    } catch (_err) {
      // In case table creation was pending in SQLite
      sqliteDb.run(`CREATE TABLE IF NOT EXISTS order_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        session_hash TEXT DEFAULT '',
        order_id INTEGER,
        customer_id INTEGER,
        otp_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        expires_at TEXT NOT NULL,
        verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      sqliteDb.run(
        'INSERT INTO order_otps (phone, session_hash, customer_id, otp_hash, attempts, max_attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        normalizedPhone,
        sidHash,
        customerId || null,
        digest,
        policy.maxAttempts,
        expiresAt.toISOString()
      );
    }
  }

  // Deliver OTP SMS via BulkSMSBD
  const smsText = `[Mr. Tumi] আপনার অর্ডার ভেরিফিকেশন কোড: ${code}। মেয়াদ ${Math.round(expirySec / 60)} মিনিট। কারো সাথে শেয়ার করবেন না।`;
  const smsResult = await smsService.sendSms({
    phone: normalizedPhone,
    message: smsText,
    templateKey: 'order_otp'
  });

  return {
    success: true,
    message: 'আপনার মোবাইলে ওটিপি কোড পাঠানো হয়েছে।',
    phone: normalizedPhone,
    expiresIn: expirySec,
    smsDelivered: Boolean(smsResult.success),
    // In local dev/test or when SMS gateway is not configured, supply code for seamless verification testing
    devCode: (!smsResult.success || process.env.NODE_ENV === 'test') ? code : undefined
  };
}

/**
 * Verify an entered OTP
 */
async function verifyCheckoutOtp({ phone, code, sessionSid = '', customerId = null }) {
  const normalizedPhone = normalizeBdPhone(phone);
  const candidate = String(code || '').trim();

  if (!/^\d{6}$/.test(candidate)) {
    throw new ValidationError('৬ সংখ্যার সঠিক ওটিপি কোড প্রদান করুন।');
  }

  const sidHash = safeHash(sessionSid || 'anonymous_checkout_session');

  if (isMysql()) {
    const { withTransaction } = require('../db/mysqlPool');
    return withTransaction(async (tx) => {
      const conditions = [
        'phone = ?',
        'verified_at IS NULL',
        'expires_at > UTC_TIMESTAMP()',
        'attempts < max_attempts'
      ];
      const params = [normalizedPhone];

      if (sidHash) {
        conditions.push('(session_hash = ? OR session_hash = \'\')');
        params.push(sidHash);
      }

      const row = await tx.queryOne(
        `SELECT id, otp_hash, attempts, max_attempts FROM order_otps WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        params
      );

      if (!row) {
        throw new ValidationError('ওটিপি কোডটি মেয়াদোত্তীর্ণ বা পূর্বে ব্যবহার করা হয়েছে। অনুগ্রহ করে নতুন কোড নিন।');
      }

      const expected = Buffer.from(String(row.otp_hash), 'hex');
      const actual = Buffer.from(otpDigest(normalizedPhone, candidate), 'hex');
      const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

      if (!valid) {
        await tx.execute('UPDATE order_otps SET attempts = attempts + 1 WHERE id = ?', [row.id]);
        const remaining = Math.max(0, row.max_attempts - (row.attempts + 1));
        throw new ValidationError(`ভুল ওটিপি কোড! আর ${remaining} বার চেষ্টা করতে পারবেন।`);
      }

      await tx.execute('UPDATE order_otps SET verified_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
      if (customerId) {
        await tx.execute('UPDATE customers SET phone_verified_at = UTC_TIMESTAMP() WHERE id = ?', [customerId]);
      }

      return {
        success: true,
        message: 'ওটিপি সফলভাবে যাচাই করা হয়েছে।'
      };
    });
  } else {
    // SQLite mode
    const row = sqliteDb.get(
      "SELECT id, otp_hash, attempts, max_attempts FROM order_otps WHERE phone = ? AND verified_at IS NULL AND datetime(expires_at) > datetime('now') AND attempts < max_attempts ORDER BY id DESC LIMIT 1",
      normalizedPhone
    );

    if (!row) {
      throw new ValidationError('ওটিপি কোডটি মেয়াদোত্তীর্ণ বা পূর্বে ব্যবহার করা হয়েছে। অনুগ্রহ করে নতুন কোড নিন।');
    }

    const expected = Buffer.from(String(row.otp_hash), 'hex');
    const actual = Buffer.from(otpDigest(normalizedPhone, candidate), 'hex');
    const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

    if (!valid) {
      sqliteDb.run('UPDATE order_otps SET attempts = attempts + 1 WHERE id = ?', row.id);
      const remaining = Math.max(0, row.max_attempts - (row.attempts + 1));
      throw new ValidationError(`ভুল ওটিপি কোড! আর ${remaining} বার চেষ্টা করতে পারবেন।`);
    }

    sqliteDb.run("UPDATE order_otps SET verified_at = datetime('now') WHERE id = ?", row.id);
    if (customerId) {
      sqliteDb.run("UPDATE customers SET phone_verified_at = datetime('now') WHERE id = ?", customerId);
    }

    return {
      success: true,
      message: 'ওটিপি সফলভাবে যাচাই করা হয়েছে।'
    };
  }
}

module.exports = {
  requestCheckoutOtp,
  verifyCheckoutOtp,
  getOtpSettings,
  otpDigest,
  makeOtp
};
