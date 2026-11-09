'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');
const sqliteDb = require('../db/database');
const { getPool, createQueryClient } = require('../db/mysqlPool');

function isMysql() {
  return env.db.client === 'mysql';
}

let sqliteTablesEnsured = false;
function ensureSqliteTables() {
  if (isMysql() || sqliteTablesEnsured) return;
  try {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS referral_codes (
        code TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL DEFAULT 'customer',
        actor_id INTEGER NOT NULL,
        clicks_count INTEGER NOT NULL DEFAULT 0,
        conversions_count INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS customer_wallets (
        customer_id INTEGER PRIMARY KEY,
        balance_paisa INTEGER NOT NULL DEFAULT 0,
        points_balance INTEGER NOT NULL DEFAULT 0,
        lifetime_earned_paisa INTEGER NOT NULL DEFAULT 0,
        lifetime_points_earned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS customer_wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        tx_type TEXT NOT NULL DEFAULT 'referral_cashback',
        amount_paisa INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        balance_after_paisa INTEGER NOT NULL DEFAULT 0,
        points_after INTEGER NOT NULL DEFAULT 0,
        reference_id TEXT DEFAULT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS referral_rewards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referral_code TEXT NOT NULL,
        referrer_type TEXT NOT NULL DEFAULT 'customer',
        referrer_id INTEGER NOT NULL,
        referee_customer_id INTEGER DEFAULT NULL,
        referee_phone TEXT NOT NULL DEFAULT '',
        order_id INTEGER DEFAULT NULL,
        order_amount_paisa INTEGER NOT NULL DEFAULT 0,
        reward_type TEXT NOT NULL DEFAULT 'cashback',
        reward_paisa INTEGER NOT NULL DEFAULT 0,
        reward_points INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        credited_at TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);
    sqliteTablesEnsured = true;
  } catch (_e) {}
}

function getClient(tx = null) {
  if (tx) return tx;
  if (isMysql()) return createQueryClient(getPool());
  ensureSqliteTables();
  return sqliteDb;
}

/**
 * Generate a random, human-friendly alphanumeric referral code
 * Examples: MT-C7K8M9, MT-V3X2W1, MT-R5N4P2
 */
function generateCode(actorType, actorId) {
  const prefix = actorType === 'vendor' ? 'MT-V' : actorType === 'reseller' ? 'MT-R' : 'MT-C';
  const idPart = Number(actorId).toString(36).toUpperCase();
  const randomPart = crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase();
  return `${prefix}${idPart}-${randomPart}`;
}

/**
 * Get or create unique referral code and share link for Customer, Vendor or Reseller
 */
async function getOrCreateReferralCode(actorType, actorId, baseUrl = '') {
  const client = getClient();
  const idNum = Number(actorId);
  const type = String(actorType || 'customer').toLowerCase();
  const origin = baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://mrtumi.com';

  if (!Number.isSafeInteger(idNum) || idNum < 1) {
    return { code: '', referralLink: '', clicksCount: 0, conversionsCount: 0 };
  }

  try {
    let row = null;
    if (isMysql()) {
      row = await client.queryOne(
        'SELECT code, clicks_count, conversions_count, is_active FROM referral_codes WHERE actor_type = ? AND actor_id = ? LIMIT 1',
        [type, idNum]
      );
    } else {
      row = client.get(
        'SELECT code, clicks_count, conversions_count, is_active FROM referral_codes WHERE actor_type = ? AND actor_id = ? LIMIT 1',
        type,
        idNum
      );
    }

    if (row && row.code) {
      return {
        code: row.code,
        referralLink: `${origin}/?ref=${encodeURIComponent(row.code)}`,
        clicksCount: Number(row.clicks_count || 0),
        conversionsCount: Number(row.conversions_count || 0),
        isActive: Number(row.is_active) === 1,
      };
    }

    // Generate new unique code
    let newCode = generateCode(type, idNum);
    for (let attempts = 0; attempts < 5; attempts++) {
      try {
        if (isMysql()) {
          await client.execute(
            'INSERT INTO referral_codes (code, actor_type, actor_id, clicks_count, conversions_count, is_active) VALUES (?, ?, ?, 0, 0, 1)',
            [newCode, type, idNum]
          );
          if (type === 'customer') {
            await client.execute('UPDATE customers SET referral_code = ? WHERE id = ?', [newCode, idNum]);
          } else if (type === 'vendor') {
            await client.execute('UPDATE vendors SET referral_code = ? WHERE id = ?', [newCode, idNum]);
          }
        } else {
          client.run(
            'INSERT INTO referral_codes (code, actor_type, actor_id, clicks_count, conversions_count, is_active) VALUES (?, ?, ?, 0, 0, 1)',
            newCode,
            type,
            idNum
          );
          try {
            if (type === 'customer') {
              client.run('UPDATE customers SET referral_code = ? WHERE id = ?', newCode, idNum);
            } else if (type === 'vendor') {
              client.run('UPDATE vendors SET referral_code = ? WHERE id = ?', newCode, idNum);
            }
          } catch (_e) {}
        }
        break;
      } catch (insertErr) {
        // Collision retry with fresh random entropy
        newCode = `${generateCode(type, idNum)}${crypto.randomInt(10, 99)}`;
      }
    }

    return {
      code: newCode,
      referralLink: `${origin}/?ref=${encodeURIComponent(newCode)}`,
      clicksCount: 0,
      conversionsCount: 0,
      isActive: true,
    };
  } catch (err) {
    logger.warn('Failed to get/create referral code', { error: err.message, actorType, actorId });
    const fallbackCode = generateCode(type, idNum);
    return {
      code: fallbackCode,
      referralLink: `${origin}/?ref=${fallbackCode}`,
      clicksCount: 0,
      conversionsCount: 0,
      isActive: true,
    };
  }
}

/**
 * Validate a referral code and return owner details
 */
async function validateReferralCode(rawCode) {
  if (!rawCode || typeof rawCode !== 'string') return null;
  const code = rawCode.trim().toUpperCase();
  if (code.length < 4 || code.length > 32) return null;

  try {
    const client = getClient();
    let row = null;
    if (isMysql()) {
      row = await client.queryOne(
        'SELECT code, actor_type, actor_id, clicks_count, conversions_count, is_active FROM referral_codes WHERE code = ? LIMIT 1',
        [code]
      );
    } else {
      row = client.get(
        'SELECT code, actor_type, actor_id, clicks_count, conversions_count, is_active FROM referral_codes WHERE code = ? LIMIT 1',
        code
      );
    }

    if (!row || Number(row.is_active) === 0) return null;
    return {
      code: row.code,
      actorType: row.actor_type,
      actorId: Number(row.actor_id),
      clicksCount: Number(row.clicks_count || 0),
      conversionsCount: Number(row.conversions_count || 0),
    };
  } catch (err) {
    logger.warn('Error validating referral code', { code, error: err.message });
    return null;
  }
}

/**
 * Non-blocking increment of referral link clicks
 */
function trackClick(rawCode) {
  if (!rawCode || typeof rawCode !== 'string') return;
  const code = rawCode.trim().toUpperCase();

  setImmediate(async () => {
    try {
      const client = getClient();
      if (isMysql()) {
        await client.execute('UPDATE referral_codes SET clicks_count = clicks_count + 1 WHERE code = ?', [code]);
      } else {
        client.run('UPDATE referral_codes SET clicks_count = clicks_count + 1 WHERE code = ?', code);
      }
    } catch (_e) {
      // Non-blocking best-effort click count
    }
  });
}

/**
 * Helper to retrieve referral settings or fallbacks
 */
async function getReferralSettings(tx = null) {
  const client = getClient(tx);
  const defaults = {
    enabled: true,
    rewardType: 'cashback', // 'cashback' | 'points'
    rewardValuePaisa: 5000, // ৳50 in paisa
    rewardPoints: 50,
    minOrderPaisa: 30000, // ৳300 in paisa
  };

  try {
    if (isMysql()) {
      const rows = await client.queryAll(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'referral_%'"
      );
      const map = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
      if (map.referral_system_enabled === 'off') defaults.enabled = false;
      if (map.referral_reward_type) defaults.rewardType = map.referral_reward_type;
      if (map.referral_reward_value_paisa) defaults.rewardValuePaisa = Number(map.referral_reward_value_paisa);
      if (map.referral_reward_points) defaults.rewardPoints = Number(map.referral_reward_points);
      if (map.referral_min_order_paisa) defaults.minOrderPaisa = Number(map.referral_min_order_paisa);
    }
  } catch (_e) {
    // Return sensible defaults
  }
  return defaults;
}

/**
 * Record a pending referral reward when an order is placed
 */
async function recordReferralOrderPending({
  orderId,
  orderTotalPaisa,
  referralCode,
  refereePhone = '',
  refereeCustomerId = null,
  tx = null,
}) {
  if (!referralCode || !orderId) return null;
  const validated = await validateReferralCode(referralCode);
  if (!validated) return null;

  // Prevent self-referral
  if (refereeCustomerId && validated.actorType === 'customer' && Number(refereeCustomerId) === validated.actorId) {
    return null;
  }

  const settings = await getReferralSettings(tx);
  if (!settings.enabled) return null;

  const total = Number(orderTotalPaisa || 0);
  const eligible = total >= settings.minOrderPaisa;
  const rewardPaisa = eligible ? settings.rewardValuePaisa : 0;
  const rewardPoints = eligible ? settings.rewardPoints : 0;

  const client = getClient(tx);

  try {
    if (isMysql()) {
      await client.execute(
        `INSERT INTO referral_rewards 
         (referral_code, referrer_type, referrer_id, referee_customer_id, referee_phone, order_id, order_amount_paisa, reward_type, reward_paisa, reward_points, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          validated.code,
          validated.actorType,
          validated.actorId,
          refereeCustomerId ? Number(refereeCustomerId) : null,
          String(refereePhone || '').slice(0, 32),
          Number(orderId),
          total,
          settings.rewardType,
          rewardPaisa,
          rewardPoints,
        ]
      );
      await client.execute(
        'UPDATE orders SET referral_code = ?, referred_by_id = ?, referred_by_type = ? WHERE id = ?',
        [validated.code, validated.actorId, validated.actorType, Number(orderId)]
      );
      await client.execute('UPDATE referral_codes SET conversions_count = conversions_count + 1 WHERE code = ?', [
        validated.code,
      ]);
    } else {
      client.run(
        `INSERT INTO referral_rewards 
         (referral_code, referrer_type, referrer_id, referee_customer_id, referee_phone, order_id, order_amount_paisa, reward_type, reward_paisa, reward_points, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        validated.code,
        validated.actorType,
        validated.actorId,
        refereeCustomerId ? Number(refereeCustomerId) : null,
        String(refereePhone || '').slice(0, 32),
        Number(orderId),
        total,
        settings.rewardType,
        rewardPaisa,
        rewardPoints
      );
      try {
        client.run(
          'UPDATE orders SET referral_code = ?, referred_by_id = ?, referred_by_type = ? WHERE id = ?',
          validated.code,
          validated.actorId,
          validated.actorType,
          Number(orderId)
        );
      } catch (_e) {}
      try {
        client.run('UPDATE referral_codes SET conversions_count = conversions_count + 1 WHERE code = ?', validated.code);
      } catch (_e) {}
    }

    return {
      code: validated.code,
      referrerType: validated.actorType,
      referrerId: validated.actorId,
      rewardPaisa,
      rewardPoints,
      status: 'pending',
    };
  } catch (err) {
    logger.warn('Failed to record referral reward', { orderId, referralCode, error: err.message });
    return null;
  }
}

/**
 * Credit referral reward when order is delivered or completed
 */
async function creditReferralRewardForOrder(orderId, tx = null) {
  const idNum = Number(orderId);
  if (!Number.isSafeInteger(idNum) || idNum < 1) return null;

  const client = getClient(tx);

  try {
    let reward = null;
    if (isMysql()) {
      reward = await client.queryOne(
        "SELECT * FROM referral_rewards WHERE order_id = ? AND status = 'pending' LIMIT 1 FOR UPDATE",
        [idNum]
      );
    } else {
      reward = client.get("SELECT * FROM referral_rewards WHERE order_id = ? AND status = 'pending' LIMIT 1", idNum);
    }

    if (!reward) return null;

    const rewardPaisa = Number(reward.reward_paisa || 0);
    const rewardPoints = Number(reward.reward_points || 0);
    const referrerId = Number(reward.referrer_id);
    const referrerType = String(reward.referrer_type);

    if (referrerType === 'customer') {
      if (isMysql()) {
        await client.execute(
          `INSERT INTO customer_wallets (customer_id, balance_paisa, points_balance, lifetime_earned_paisa, lifetime_points_earned)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             balance_paisa = balance_paisa + VALUES(balance_paisa),
             points_balance = points_balance + VALUES(points_balance),
             lifetime_earned_paisa = lifetime_earned_paisa + VALUES(lifetime_earned_paisa),
             lifetime_points_earned = lifetime_points_earned + VALUES(lifetime_points_earned)`,
          [referrerId, rewardPaisa, rewardPoints, rewardPaisa, rewardPoints]
        );

        const currentWallet = await client.queryOne(
          'SELECT balance_paisa, points_balance FROM customer_wallets WHERE customer_id = ? FOR UPDATE',
          [referrerId]
        );

        await client.execute(
          `INSERT INTO customer_wallet_transactions 
           (customer_id, tx_type, amount_paisa, points, balance_after_paisa, points_after, reference_id, note)
           VALUES (?, 'referral_bonus', ?, ?, ?, ?, ?, ?)`,
          [
            referrerId,
            rewardPaisa,
            rewardPoints,
            Number(currentWallet?.balance_paisa || rewardPaisa),
            Number(currentWallet?.points_balance || rewardPoints),
            `order:${idNum}`,
            `রেফারেল বোনাস (অর্ডার #${idNum})`,
          ]
        );
      } else {
        const existingWallet = client.get('SELECT * FROM customer_wallets WHERE customer_id = ?', referrerId);
        const newBal = (existingWallet ? Number(existingWallet.balance_paisa || 0) : 0) + rewardPaisa;
        const newPts = (existingWallet ? Number(existingWallet.points_balance || 0) : 0) + rewardPoints;
        const lifeEarned = (existingWallet ? Number(existingWallet.lifetime_earned_paisa || 0) : 0) + rewardPaisa;
        const lifePts = (existingWallet ? Number(existingWallet.lifetime_points_earned || 0) : 0) + rewardPoints;

        if (existingWallet) {
          client.run(
            'UPDATE customer_wallets SET balance_paisa = ?, points_balance = ?, lifetime_earned_paisa = ?, lifetime_points_earned = ? WHERE customer_id = ?',
            newBal,
            newPts,
            lifeEarned,
            lifePts,
            referrerId
          );
        } else {
          client.run(
            'INSERT INTO customer_wallets (customer_id, balance_paisa, points_balance, lifetime_earned_paisa, lifetime_points_earned) VALUES (?, ?, ?, ?, ?)',
            referrerId,
            newBal,
            newPts,
            lifeEarned,
            lifePts
          );
        }

        client.run(
          `INSERT INTO customer_wallet_transactions 
           (customer_id, tx_type, amount_paisa, points, balance_after_paisa, points_after, reference_id, note)
           VALUES (?, 'referral_bonus', ?, ?, ?, ?, ?, ?)`,
          referrerId,
          rewardPaisa,
          rewardPoints,
          newBal,
          newPts,
          `order:${idNum}`,
          `রেফারেল বোনাস (অর্ডার #${idNum})`
        );
      }
    } else if (referrerType === 'vendor') {
      if (isMysql()) {
        await client.execute('UPDATE vendors SET balance_paisa = balance_paisa + ? WHERE id = ?', [rewardPaisa, referrerId]);
        try {
          await client.execute(
            'UPDATE vendor_wallets SET available_paisa = available_paisa + ?, lifetime_earned_paisa = lifetime_earned_paisa + ? WHERE vendor_id = ?',
            [rewardPaisa, rewardPaisa, referrerId]
          );
        } catch (_e) {}
      } else {
        client.run('UPDATE vendors SET balance = balance + ? WHERE id = ?', Math.round(rewardPaisa / 100), referrerId);
      }
    } else if (referrerType === 'reseller') {
      if (isMysql()) {
        await client.execute('UPDATE resellers SET balance_paisa = balance_paisa + ? WHERE id = ?', [rewardPaisa, referrerId]);
        try {
          await client.execute(
            'UPDATE partner_wallets SET available_balance = available_balance + ? WHERE reseller_id = ?',
            [rewardPaisa, referrerId]
          );
        } catch (_e) {}
      } else {
        client.run('UPDATE resellers SET balance_paisa = balance_paisa + ? WHERE id = ?', rewardPaisa, referrerId);
      }
    }

    if (isMysql()) {
      await client.execute(
        "UPDATE referral_rewards SET status = 'credited', credited_at = UTC_TIMESTAMP() WHERE id = ?",
        [reward.id]
      );
    } else {
      client.run(
        "UPDATE referral_rewards SET status = 'credited', credited_at = datetime('now', 'localtime') WHERE id = ?",
        reward.id
      );
    }

    logger.info('Referral reward credited successfully', { orderId: idNum, rewardId: reward.id, rewardPaisa, rewardPoints });
    return { success: true, rewardId: reward.id, rewardPaisa, rewardPoints };
  } catch (err) {
    logger.error('Failed to credit referral reward', { orderId: idNum, error: err.message });
    return null;
  }
}

/**
 * Cancel pending referral reward if order is cancelled or refunded
 */
async function cancelReferralRewardForOrder(orderId, tx = null) {
  const idNum = Number(orderId);
  if (!Number.isSafeInteger(idNum) || idNum < 1) return;

  const client = getClient(tx);
  try {
    if (isMysql()) {
      await client.execute(
        "UPDATE referral_rewards SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'",
        [idNum]
      );
    } else {
      client.run(
        "UPDATE referral_rewards SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'",
        idNum
      );
    }
  } catch (err) {
    logger.warn('Failed to cancel referral reward', { orderId: idNum, error: err.message });
  }
}

/**
 * Get customer wallet balance, referral code, link, and activity
 */
async function getCustomerWalletAndReferralStats(customerId, baseUrl = '') {
  const idNum = Number(customerId);
  const client = getClient();
  const origin = baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://mrtumi.com';

  const referralData = await getOrCreateReferralCode('customer', idNum, origin);

  let wallet = { balance_paisa: 0, points_balance: 0, lifetime_earned_paisa: 0, lifetime_points_earned: 0 };
  let transactions = [];
  let rewards = [];

  try {
    if (isMysql()) {
      const wRow = await client.queryOne('SELECT * FROM customer_wallets WHERE customer_id = ? LIMIT 1', [idNum]);
      if (wRow) wallet = wRow;

      transactions = await client.queryAll(
        'SELECT * FROM customer_wallet_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 20',
        [idNum]
      );

      rewards = await client.queryAll(
        'SELECT * FROM referral_rewards WHERE referrer_type = ? AND referrer_id = ? ORDER BY id DESC LIMIT 20',
        ['customer', idNum]
      );
    } else {
      const wRow = client.get('SELECT * FROM customer_wallets WHERE customer_id = ? LIMIT 1', idNum);
      if (wRow) wallet = wRow;

      transactions = client.all(
        'SELECT * FROM customer_wallet_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 20',
        idNum
      );

      rewards = client.all(
        'SELECT * FROM referral_rewards WHERE referrer_type = ? AND referrer_id = ? ORDER BY id DESC LIMIT 20',
        'customer',
        idNum
      );
    }
  } catch (err) {
    logger.warn('Error reading customer wallet data', { customerId: idNum, error: err.message });
  }

  const invitedCount = rewards.length;
  const completedCount = rewards.filter(r => r.status === 'credited').length;
  const pendingCount = rewards.filter(r => r.status === 'pending').length;

  return {
    referralCode: referralData.code,
    referralLink: referralData.referralLink,
    clicksCount: referralData.clicksCount,
    conversionsCount: referralData.conversionsCount,
    balancePaisa: Number(wallet.balance_paisa || 0),
    balanceBdt: Math.round(Number(wallet.balance_paisa || 0) / 100),
    pointsBalance: Number(wallet.points_balance || 0),
    lifetimeEarnedPaisa: Number(wallet.lifetime_earned_paisa || 0),
    lifetimeEarnedBdt: Math.round(Number(wallet.lifetime_earned_paisa || 0) / 100),
    invitedCount,
    completedCount,
    pendingCount,
    transactions,
    rewards,
  };
}

/**
 * Get vendor referral stats and links
 */
async function getVendorReferralStats(vendorId, baseUrl = '') {
  const idNum = Number(vendorId);
  const client = getClient();
  const origin = baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://mrtumi.com';

  const referralData = await getOrCreateReferralCode('vendor', idNum, origin);
  let rewards = [];

  try {
    if (isMysql()) {
      rewards = await client.queryAll(
        'SELECT * FROM referral_rewards WHERE referrer_type = ? AND referrer_id = ? ORDER BY id DESC LIMIT 20',
        ['vendor', idNum]
      );
    } else {
      rewards = client.all(
        'SELECT * FROM referral_rewards WHERE referrer_type = ? AND referrer_id = ? ORDER BY id DESC LIMIT 20',
        'vendor',
        idNum
      );
    }
  } catch (err) {
    logger.warn('Error reading vendor referral data', { vendorId: idNum, error: err.message });
  }

  const invitedCount = rewards.length;
  const completedCount = rewards.filter(r => r.status === 'credited').length;
  const totalEarnedPaisa = rewards.filter(r => r.status === 'credited').reduce((sum, r) => sum + Number(r.reward_paisa || 0), 0);

  return {
    referralCode: referralData.code,
    referralLink: referralData.referralLink,
    clicksCount: referralData.clicksCount,
    conversionsCount: referralData.conversionsCount,
    invitedCount,
    completedCount,
    totalEarnedPaisa,
    totalEarnedBdt: Math.round(totalEarnedPaisa / 100),
    rewards,
  };
}

module.exports = {
  generateCode,
  getOrCreateReferralCode,
  validateReferralCode,
  trackClick,
  getReferralSettings,
  recordReferralOrderPending,
  creditReferralRewardForOrder,
  cancelReferralRewardForOrder,
  getCustomerWalletAndReferralStats,
  getVendorReferralStats,
};
