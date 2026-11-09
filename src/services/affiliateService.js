'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const { normalizeBdPhone } = require('../utils/validator');
const { ValidationError, ConflictError } = require('../utils/errors');
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
      CREATE TABLE IF NOT EXISTS affiliates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        affiliate_code TEXT UNIQUE NOT NULL,
        parent_affiliate_id INTEGER DEFAULT NULL,
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        email TEXT DEFAULT NULL,
        password_hash TEXT NOT NULL,
        commission_rate_bps INTEGER NOT NULL DEFAULT 500,
        tier2_commission_rate_bps INTEGER NOT NULL DEFAULT 100,
        balance_paisa INTEGER NOT NULL DEFAULT 0,
        pending_balance_paisa INTEGER NOT NULL DEFAULT 0,
        lifetime_earnings_paisa INTEGER NOT NULL DEFAULT 0,
        payout_method TEXT NOT NULL DEFAULT 'bKash',
        payout_account TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS affiliate_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        affiliate_id INTEGER NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'storefront',
        target_id TEXT DEFAULT NULL,
        target_url TEXT NOT NULL,
        clicks_count INTEGER NOT NULL DEFAULT 0,
        conversions_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS affiliate_commissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        affiliate_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        tier INTEGER NOT NULL DEFAULT 1,
        sale_amount_paisa INTEGER NOT NULL DEFAULT 0,
        rate_bps INTEGER NOT NULL DEFAULT 500,
        commission_paisa INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        approved_at TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS affiliate_withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        affiliate_id INTEGER NOT NULL,
        amount_paisa INTEGER NOT NULL,
        payout_method TEXT NOT NULL,
        payout_account TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        admin_note TEXT NOT NULL DEFAULT '',
        processed_at TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
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

function generateCode() {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `AFF-${rand}`;
}

async function registerAffiliate({
  name,
  phone,
  email = '',
  password,
  payout_method = 'bKash',
  payout_account = '',
  parent_code = '',
}) {
  const client = getClient();
  const cleanPhone = normalizeBdPhone(phone);
  if (!cleanPhone) throw new ValidationError('সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন।');
  if (!name || name.trim().length < 2) throw new ValidationError('আপনার পূর্ণ নাম লিখুন।');
  if (!password || password.length < 6) throw new ValidationError('পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');

  // Check unique phone
  let existing = null;
  if (isMysql()) {
    existing = await client.queryOne('SELECT id FROM affiliates WHERE phone = ? LIMIT 1', [cleanPhone]);
  } else {
    existing = client.get('SELECT id FROM affiliates WHERE phone = ? LIMIT 1', cleanPhone);
  }
  if (existing) throw new ConflictError('এই মোবাইল নম্বর দিয়ে ইতিমধ্যে একটি এফিলিয়েট অ্যাকাউন্ট তৈরি করা আছে।');

  // Check parent affiliate for multi-tier
  let parentAffiliateId = null;
  if (parent_code && typeof parent_code === 'string') {
    const parentCodeClean = parent_code.trim().toUpperCase();
    let parentRow = null;
    if (isMysql()) {
      parentRow = await client.queryOne('SELECT id FROM affiliates WHERE affiliate_code = ? LIMIT 1', [parentCodeClean]);
    } else {
      parentRow = client.get('SELECT id FROM affiliates WHERE affiliate_code = ? LIMIT 1', parentCodeClean);
    }
    if (parentRow) parentAffiliateId = Number(parentRow.id);
  }

  const hash = bcrypt.hashSync(password, 10);
  let code = generateCode();

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (isMysql()) {
        const res = await client.execute(
          `INSERT INTO affiliates 
           (affiliate_code, parent_affiliate_id, name, phone, email, password_hash, commission_rate_bps, tier2_commission_rate_bps, balance_paisa, pending_balance_paisa, lifetime_earnings_paisa, payout_method, payout_account, status)
           VALUES (?, ?, ?, ?, ?, ?, 500, 100, 0, 0, 0, ?, ?, 1)`,
          [code, parentAffiliateId, name.trim(), cleanPhone, email.trim(), hash, payout_method, payout_account || cleanPhone]
        );
        return { id: Number(res.insertId), affiliate_code: code, name: name.trim(), phone: cleanPhone };
      } else {
        const res = client.run(
          `INSERT INTO affiliates 
           (affiliate_code, parent_affiliate_id, name, phone, email, password_hash, commission_rate_bps, tier2_commission_rate_bps, balance_paisa, pending_balance_paisa, lifetime_earnings_paisa, payout_method, payout_account, status)
           VALUES (?, ?, ?, ?, ?, ?, 500, 100, 0, 0, 0, ?, ?, 1)`,
          code, parentAffiliateId, name.trim(), cleanPhone, email.trim(), hash, payout_method, payout_account || cleanPhone
        );
        return { id: Number(res.lastInsertRowid), affiliate_code: code, name: name.trim(), phone: cleanPhone };
      }
    } catch (err) {
      if (err.message && err.message.includes('affiliate_code')) {
        code = `${generateCode()}${crypto.randomInt(10, 99)}`;
      } else {
        throw err;
      }
    }
  }
}

async function authenticateAffiliate(identifier, password) {
  if (!identifier || !password) return null;
  const client = getClient();
  const idStr = String(identifier).trim();
  const phoneClean = normalizeBdPhone(idStr);

  let aff = null;
  if (isMysql()) {
    aff = await client.queryOne(
      'SELECT * FROM affiliates WHERE (phone = ? OR email = ? OR affiliate_code = ?) AND status = 1 LIMIT 1',
      [phoneClean || idStr, idStr, idStr.toUpperCase()]
    );
  } else {
    aff = client.get(
      'SELECT * FROM affiliates WHERE (phone = ? OR email = ? OR affiliate_code = ?) AND status = 1 LIMIT 1',
      phoneClean || idStr, idStr, idStr.toUpperCase()
    );
  }

  if (!aff || !aff.password_hash) return null;
  const ok = await bcrypt.compare(password, aff.password_hash);
  if (!ok) return null;

  return {
    id: Number(aff.id),
    affiliate_code: aff.affiliate_code,
    name: aff.name,
    phone: aff.phone,
    email: aff.email,
    commission_rate_bps: Number(aff.commission_rate_bps || 500),
    tier2_commission_rate_bps: Number(aff.tier2_commission_rate_bps || 100),
    balance_paisa: Number(aff.balance_paisa || 0),
    pending_balance_paisa: Number(aff.pending_balance_paisa || 0),
    lifetime_earnings_paisa: Number(aff.lifetime_earnings_paisa || 0),
    payout_method: aff.payout_method,
    payout_account: aff.payout_account,
  };
}

async function getAffiliateById(id) {
  const client = getClient();
  const idNum = Number(id);
  if (!Number.isSafeInteger(idNum) || idNum < 1) return null;

  if (isMysql()) {
    return client.queryOne('SELECT * FROM affiliates WHERE id = ? LIMIT 1', [idNum]);
  }
  return client.get('SELECT * FROM affiliates WHERE id = ? LIMIT 1', idNum);
}

async function createAffiliateLink(affiliateId, { targetUrl, targetType = 'storefront', targetId = null }, baseUrl = 'https://mrtumi.com') {
  const client = getClient();
  const aff = await getAffiliateById(affiliateId);
  if (!aff) throw new ValidationError('Affiliate not found');

  const origin = baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://mrtumi.com';
  let cleanUrl = targetUrl ? targetUrl.trim() : origin;
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = `${origin}${cleanUrl.startsWith('/') ? '' : '/'}${cleanUrl}`;
  }

  const urlObj = new URL(cleanUrl);
  urlObj.searchParams.set('aff', aff.affiliate_code);
  const finalAffUrl = urlObj.toString();

  if (isMysql()) {
    const res = await client.execute(
      'INSERT INTO affiliate_links (affiliate_id, target_type, target_id, target_url, clicks_count, conversions_count) VALUES (?, ?, ?, ?, 0, 0)',
      [Number(affiliateId), targetType, targetId, finalAffUrl]
    );
    return { id: Number(res.insertId), affiliate_code: aff.affiliate_code, target_url: finalAffUrl, clicks_count: 0, conversions_count: 0 };
  } else {
    const res = client.run(
      'INSERT INTO affiliate_links (affiliate_id, target_type, target_id, target_url, clicks_count, conversions_count) VALUES (?, ?, ?, ?, 0, 0)',
      Number(affiliateId), targetType, targetId, finalAffUrl
    );
    return { id: Number(res.lastInsertRowid), affiliate_code: aff.affiliate_code, target_url: finalAffUrl, clicks_count: 0, conversions_count: 0 };
  }
}

function trackClick(rawAffCode) {
  if (!rawAffCode || typeof rawAffCode !== 'string') return;
  const affCode = rawAffCode.trim().toUpperCase();

  setImmediate(async () => {
    try {
      const client = getClient();
      if (isMysql()) {
        await client.execute(
          'UPDATE affiliate_links SET clicks_count = clicks_count + 1 WHERE target_url LIKE ?',
          [`%aff=${affCode}%`]
        );
      } else {
        client.run(
          'UPDATE affiliate_links SET clicks_count = clicks_count + 1 WHERE target_url LIKE ?',
          `%aff=${affCode}%`
        );
      }
    } catch (_e) {}
  });
}

/**
 * Record pending multi-tier commissions when an order is placed
 */
async function recordOrderAffiliatePending({ orderId, orderTotalPaisa, affiliateCode, tx = null }) {
  if (!affiliateCode || !orderId) return null;
  const code = affiliateCode.trim().toUpperCase();
  const client = getClient(tx);
  const total = Number(orderTotalPaisa || 0);
  if (total <= 0) return null;

  let aff = null;
  if (isMysql()) {
    aff = await client.queryOne('SELECT * FROM affiliates WHERE affiliate_code = ? AND status = 1 LIMIT 1', [code]);
  } else {
    aff = client.get('SELECT * FROM affiliates WHERE affiliate_code = ? AND status = 1 LIMIT 1', code);
  }
  if (!aff) return null;

  // Tier 1 Commission (Direct)
  const tier1RateBps = Number(aff.commission_rate_bps || 500); // 5% default
  const tier1CommPaisa = Math.round((total * tier1RateBps) / 10000);

  // Link affiliate to order
  try {
    if (isMysql()) {
      await client.execute('UPDATE orders SET affiliate_code = ? WHERE id = ?', [code, Number(orderId)]);
      await client.execute(
        `INSERT INTO affiliate_commissions 
         (affiliate_id, order_id, tier, sale_amount_paisa, rate_bps, commission_paisa, status)
         VALUES (?, ?, 1, ?, ?, ?, 'pending')`,
        [aff.id, Number(orderId), total, tier1RateBps, tier1CommPaisa]
      );
      await client.execute(
        'UPDATE affiliates SET pending_balance_paisa = pending_balance_paisa + ? WHERE id = ?',
        [tier1CommPaisa, aff.id]
      );
      await client.execute(
        'UPDATE affiliate_links SET conversions_count = conversions_count + 1 WHERE affiliate_id = ? LIMIT 1',
        [aff.id]
      );
    } else {
      try { client.run('UPDATE orders SET affiliate_code = ? WHERE id = ?', code, Number(orderId)); } catch (_e) {}
      client.run(
        `INSERT INTO affiliate_commissions 
         (affiliate_id, order_id, tier, sale_amount_paisa, rate_bps, commission_paisa, status)
         VALUES (?, ?, 1, ?, ?, ?, 'pending')`,
        aff.id, Number(orderId), total, tier1RateBps, tier1CommPaisa
      );
      client.run(
        'UPDATE affiliates SET pending_balance_paisa = pending_balance_paisa + ? WHERE id = ?',
        tier1CommPaisa, aff.id
      );
      try { client.run('UPDATE affiliate_links SET conversions_count = conversions_count + 1 WHERE affiliate_id = ?', aff.id); } catch (_e) {}
    }
  } catch (err) {
    logger.warn('Failed to record Tier 1 commission', { orderId, error: err.message });
  }

  // Tier 2 Commission (Parent Affiliate Override if registered through sub-affiliate link)
  if (aff.parent_affiliate_id) {
    let parentAff = null;
    if (isMysql()) {
      parentAff = await client.queryOne('SELECT * FROM affiliates WHERE id = ? AND status = 1 LIMIT 1', [aff.parent_affiliate_id]);
    } else {
      parentAff = client.get('SELECT * FROM affiliates WHERE id = ? AND status = 1 LIMIT 1', aff.parent_affiliate_id);
    }

    if (parentAff) {
      const tier2RateBps = Number(parentAff.tier2_commission_rate_bps || 100); // 1% Tier-2 override
      const tier2CommPaisa = Math.round((total * tier2RateBps) / 10000);

      try {
        if (isMysql()) {
          await client.execute(
            `INSERT INTO affiliate_commissions 
             (affiliate_id, order_id, tier, sale_amount_paisa, rate_bps, commission_paisa, status)
             VALUES (?, ?, 2, ?, ?, ?, 'pending')`,
            [parentAff.id, Number(orderId), total, tier2RateBps, tier2CommPaisa]
          );
          await client.execute(
            'UPDATE affiliates SET pending_balance_paisa = pending_balance_paisa + ? WHERE id = ?',
            [tier2CommPaisa, parentAff.id]
          );
        } else {
          client.run(
            `INSERT INTO affiliate_commissions 
             (affiliate_id, order_id, tier, sale_amount_paisa, rate_bps, commission_paisa, status)
             VALUES (?, ?, 2, ?, ?, ?, 'pending')`,
            parentAff.id, Number(orderId), total, tier2RateBps, tier2CommPaisa
          );
          client.run(
            'UPDATE affiliates SET pending_balance_paisa = pending_balance_paisa + ? WHERE id = ?',
            tier2CommPaisa, parentAff.id
          );
        }
      } catch (err) {
        logger.warn('Failed to record Tier 2 commission', { orderId, error: err.message });
      }
    }
  }

  return { success: true, tier1CommissionPaisa: tier1CommPaisa };
}

/**
 * Approve & credit commissions when order is delivered
 */
async function creditOrderAffiliateCommission(orderId, tx = null) {
  const client = getClient(tx);
  const idNum = Number(orderId);
  if (!idNum) return;

  let commissions = [];
  if (isMysql()) {
    commissions = await client.queryAll(
      "SELECT * FROM affiliate_commissions WHERE order_id = ? AND status = 'pending' FOR UPDATE",
      [idNum]
    );
  } else {
    commissions = client.all(
      "SELECT * FROM affiliate_commissions WHERE order_id = ? AND status = 'pending'",
      idNum
    );
  }

  for (const c of commissions) {
    const amt = Number(c.commission_paisa || 0);
    const affId = Number(c.affiliate_id);

    if (isMysql()) {
      await client.execute(
        `UPDATE affiliates SET 
           balance_paisa = balance_paisa + ?,
           pending_balance_paisa = GREATEST(0, pending_balance_paisa - ?),
           lifetime_earnings_paisa = lifetime_earnings_paisa + ?
         WHERE id = ?`,
        [amt, amt, amt, affId]
      );
      await client.execute(
        "UPDATE affiliate_commissions SET status = 'approved', approved_at = UTC_TIMESTAMP() WHERE id = ?",
        [c.id]
      );
    } else {
      client.run(
        `UPDATE affiliates SET 
           balance_paisa = balance_paisa + ?,
           pending_balance_paisa = MAX(0, pending_balance_paisa - ?),
           lifetime_earnings_paisa = lifetime_earnings_paisa + ?
         WHERE id = ?`,
        amt, amt, amt, affId
      );
      client.run(
        "UPDATE affiliate_commissions SET status = 'approved', approved_at = datetime('now', 'localtime') WHERE id = ?",
        c.id
      );
    }
  }

  logger.info('Affiliate commissions credited', { orderId: idNum, count: commissions.length });
}

/**
 * Reject commissions when order is cancelled or returned
 */
async function cancelOrderAffiliateCommission(orderId, tx = null) {
  const client = getClient(tx);
  const idNum = Number(orderId);
  if (!idNum) return;

  let commissions = [];
  if (isMysql()) {
    commissions = await client.queryAll(
      "SELECT * FROM affiliate_commissions WHERE order_id = ? AND status = 'pending'",
      [idNum]
    );
  } else {
    commissions = client.all(
      "SELECT * FROM affiliate_commissions WHERE order_id = ? AND status = 'pending'",
      idNum
    );
  }

  for (const c of commissions) {
    const amt = Number(c.commission_paisa || 0);
    const affId = Number(c.affiliate_id);

    if (isMysql()) {
      await client.execute(
        'UPDATE affiliates SET pending_balance_paisa = GREATEST(0, pending_balance_paisa - ?) WHERE id = ?',
        [amt, affId]
      );
      await client.execute("UPDATE affiliate_commissions SET status = 'rejected' WHERE id = ?", [c.id]);
    } else {
      client.run(
        'UPDATE affiliates SET pending_balance_paisa = MAX(0, pending_balance_paisa - ?) WHERE id = ?',
        amt, affId
      );
      client.run("UPDATE affiliate_commissions SET status = 'rejected' WHERE id = ?", c.id);
    }
  }
}

/**
 * Submit withdrawal request
 */
async function requestWithdrawal(affiliateId, { amountPaisa, payoutMethod, payoutAccount }) {
  const client = getClient();
  const idNum = Number(affiliateId);
  const amt = Number(amountPaisa);

  if (amt < 50000) {
    throw new ValidationError('উত্তোলনের সর্বনিম্ন পরিমাণ ৫০০ টাকা।');
  }

  const aff = await getAffiliateById(idNum);
  if (!aff || Number(aff.balance_paisa) < amt) {
    throw new ValidationError('আপনার ওয়ালেটে পর্যাপ্ত পরিমাণ ব্যালেন্স নেই।');
  }

  const method = payoutMethod || aff.payout_method || 'bKash';
  const account = payoutAccount || aff.payout_account || aff.phone;

  if (isMysql()) {
    await client.execute(
      'UPDATE affiliates SET balance_paisa = balance_paisa - ? WHERE id = ?',
      [amt, idNum]
    );
    const res = await client.execute(
      'INSERT INTO affiliate_withdrawals (affiliate_id, amount_paisa, payout_method, payout_account, status) VALUES (?, ?, ?, ?, "pending")',
      [idNum, amt, method, account]
    );
    return { id: Number(res.insertId), amountPaisa: amt, status: 'pending' };
  } else {
    client.run(
      'UPDATE affiliates SET balance_paisa = balance_paisa - ? WHERE id = ?',
      amt, idNum
    );
    const res = client.run(
      'INSERT INTO affiliate_withdrawals (affiliate_id, amount_paisa, payout_method, payout_account, status) VALUES (?, ?, ?, ?, "pending")',
      idNum, amt, method, account
    );
    return { id: Number(res.lastInsertRowid), amountPaisa: amt, status: 'pending' };
  }
}

/**
 * Complete affiliate dashboard analytics
 */
async function getAffiliateDashboardData(affiliateId, baseUrl = '') {
  const client = getClient();
  const idNum = Number(affiliateId);
  const origin = baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://mrtumi.com';

  const aff = await getAffiliateById(idNum);
  if (!aff) return null;

  let links = [];
  let commissions = [];
  let withdrawals = [];
  let subAffiliatesCount = 0;

  if (isMysql()) {
    links = await client.queryAll('SELECT * FROM affiliate_links WHERE affiliate_id = ? ORDER BY id DESC LIMIT 10', [idNum]);
    commissions = await client.queryAll('SELECT * FROM affiliate_commissions WHERE affiliate_id = ? ORDER BY id DESC LIMIT 15', [idNum]);
    withdrawals = await client.queryAll('SELECT * FROM affiliate_withdrawals WHERE affiliate_id = ? ORDER BY id DESC LIMIT 10', [idNum]);
    const subRow = await client.queryOne('SELECT COUNT(*) AS c FROM affiliates WHERE parent_affiliate_id = ?', [idNum]);
    subAffiliatesCount = Number(subRow?.c || 0);
  } else {
    links = client.all('SELECT * FROM affiliate_links WHERE affiliate_id = ? ORDER BY id DESC LIMIT 10', idNum);
    commissions = client.all('SELECT * FROM affiliate_commissions WHERE affiliate_id = ? ORDER BY id DESC LIMIT 15', idNum);
    withdrawals = client.all('SELECT * FROM affiliate_withdrawals WHERE affiliate_id = ? ORDER BY id DESC LIMIT 10', idNum);
    const subRow = client.get('SELECT COUNT(*) AS c FROM affiliates WHERE parent_affiliate_id = ?', idNum);
    subAffiliatesCount = Number(subRow?.c || 0);
  }

  // Ensure default link exists
  if (links.length === 0) {
    const defaultLink = await createAffiliateLink(idNum, { targetUrl: origin, targetType: 'storefront' }, origin);
    links = [defaultLink];
  }

  const totalClicks = links.reduce((s, l) => s + Number(l.clicks_count || 0), 0);
  const totalConversions = commissions.length;
  const balanceBdt = Math.round(Number(aff.balance_paisa || 0) / 100);
  const pendingBdt = Math.round(Number(aff.pending_balance_paisa || 0) / 100);
  const lifetimeBdt = Math.round(Number(aff.lifetime_earnings_paisa || 0) / 100);

  const subInviteLink = `${origin}/affiliate/register?sub_of=${encodeURIComponent(aff.affiliate_code)}`;

  return {
    affiliate: aff,
    affiliateCode: aff.affiliate_code,
    balanceBdt,
    pendingBdt,
    lifetimeBdt,
    commissionRatePercent: (Number(aff.commission_rate_bps || 500) / 100).toFixed(1),
    tier2RatePercent: (Number(aff.tier2_commission_rate_bps || 100) / 100).toFixed(1),
    totalClicks,
    totalConversions,
    subAffiliatesCount,
    subInviteLink,
    links,
    commissions,
    withdrawals,
  };
}

module.exports = {
  registerAffiliate,
  authenticateAffiliate,
  getAffiliateById,
  createAffiliateLink,
  trackClick,
  recordOrderAffiliatePending,
  creditOrderAffiliateCommission,
  cancelOrderAffiliateCommission,
  requestWithdrawal,
  getAffiliateDashboardData,
};
