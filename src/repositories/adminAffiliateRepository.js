'use strict';

const mysql = require('../db/mysqlPool');
const { recordAuditLog } = require('./auditLogRepository');
const { requirePositiveInt } = require('../utils/validator');
const { bdtToPaisa } = require('../utils/money');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const audit = (tx, actor, action, entityType, entityId, beforeState, afterState) => recordAuditLog({
  actorType: 'admin', actorId: actor.id || null, action, entityType, entityId, beforeState, afterState,
  ipAddress: actor.ip || '', userAgent: actor.userAgent || '',
}, tx);

function percentToBps(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || Number(text) > 100) throw new ValidationError(`${label} must be between 0 and 100 percent.`);
  return Math.round(Number(text) * 100);
}

function takaToPaisa(value, label) {
  try {
    const paisa = bdtToPaisa(String(value ?? '').trim());
    if (Number.isSafeInteger(paisa) && paisa >= 0) return paisa;
  } catch (_error) { /* reported below */ }
  throw new ValidationError(`${label} must be a valid amount in taka.`);
}

async function getOverview() {
  const [affiliates, withdrawals, commissions, rewards] = await Promise.all([
    mysql.queryAll(`SELECT id,affiliate_code,name,phone,email,commission_rate_bps,tier2_commission_rate_bps,balance_paisa,
      pending_balance_paisa,lifetime_earnings_paisa,status,created_at FROM affiliates ORDER BY id DESC LIMIT 300`),
    mysql.queryAll(`SELECT w.id,w.affiliate_id,w.amount_paisa,w.payout_method,w.payout_account,w.status,w.admin_note,w.processed_at,w.created_at,
      a.name,a.affiliate_code FROM affiliate_withdrawals w JOIN affiliates a ON a.id=w.affiliate_id
      ORDER BY (w.status='pending') DESC,w.id DESC LIMIT 200`),
    mysql.queryAll(`SELECT c.id,c.order_id,c.tier,c.commission_paisa,c.status,c.created_at,a.affiliate_code,o.invoice_no
      FROM affiliate_commissions c JOIN affiliates a ON a.id=c.affiliate_id LEFT JOIN orders o ON o.id=c.order_id ORDER BY c.id DESC LIMIT 100`),
    mysql.queryAll(`SELECT r.id,r.order_id,r.referral_code,r.referrer_type,r.referrer_id,r.reward_paisa,r.reward_points,r.status,r.created_at,o.invoice_no
      FROM referral_rewards r LEFT JOIN orders o ON o.id=r.order_id ORDER BY r.id DESC LIMIT 100`),
  ]);
  const referral = await require('../services/referralService').getReferralSettings();
  const walletMaxPercent = await require('../services/customerWalletService').getMaxPercent();
  return { affiliates, withdrawals, commissions, rewards, referral, walletMaxPercent };
}

async function saveReferralSettings(input, actor = {}) {
  const type = String(input.referral_reward_type || '');
  if (!['cashback', 'points'].includes(type)) throw new ValidationError('Choose cashback or points.');
  const points = Number(input.referral_reward_points);
  if (!Number.isSafeInteger(points) || points < 0 || points > 1000000) throw new ValidationError('Reward points must be a whole number.');
  const values = {
    referral_system_enabled: input.referral_system_enabled === 'on' ? 'on' : 'off',
    referral_reward_type: type,
    referral_reward_value_paisa: String(takaToPaisa(input.referral_reward_taka, 'Reward amount')),
    referral_reward_points: String(points),
    referral_min_order_paisa: String(takaToPaisa(input.referral_min_order_taka, 'Minimum order')),
  };
  // A stored "0" is meaningful here; the reader treats an empty value as "use default".
  return mysql.withTransaction(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      await tx.execute('INSERT INTO settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)', [key, value]);
    }
    await audit(tx, actor, 'referral.settings.updated', 'settings', 'referral', {}, values);
    return values;
  });
}

async function saveWalletSettings(input, actor = {}) {
  const walletService = require('../services/customerWalletService');
  const text = String(input.wallet_max_percent ?? '').trim();
  if (!/^\d{1,2}$/.test(text) || Number(text) > walletService.HIGHEST_ALLOWED_PERCENT) {
    throw new ValidationError(`Wallet limit must be a whole number from 0 to ${walletService.HIGHEST_ALLOWED_PERCENT}.`);
  }
  return mysql.withTransaction(async (tx) => {
    const before = await walletService.getMaxPercent(tx);
    await tx.execute('INSERT INTO settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)', [walletService.SETTING_KEY, String(Number(text))]);
    await audit(tx, actor, 'wallet.settings.updated', 'settings', walletService.SETTING_KEY, { maxPercent: before }, { maxPercent: Number(text) });
    return { maxPercent: Number(text) };
  });
}

async function updateAffiliate(affiliateId, input, actor = {}) {
  const id = requirePositiveInt(affiliateId, 'affiliate ID');
  const tier1 = percentToBps(input.commission_percent, 'Commission');
  const tier2 = percentToBps(input.tier2_percent, 'Tier-2 commission');
  const status = String(input.status) === '1' ? 1 : 0;
  return mysql.withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT status,commission_rate_bps,tier2_commission_rate_bps FROM affiliates WHERE id=? FOR UPDATE', [id]);
    if (!before) throw new NotFoundError('Affiliate not found.');
    await tx.execute('UPDATE affiliates SET commission_rate_bps=?,tier2_commission_rate_bps=?,status=? WHERE id=?', [tier1, tier2, status, id]);
    await audit(tx, actor, 'affiliate.updated', 'affiliate', id, before, { status, commission_rate_bps: tier1, tier2_commission_rate_bps: tier2 });
  });
}

// "approve" records that the admin has already sent the money; "reject" returns it to the affiliate balance.
async function decideWithdrawal(withdrawalId, decision, note, actor = {}) {
  const id = requirePositiveInt(withdrawalId, 'withdrawal ID');
  if (!['approve', 'reject'].includes(decision)) throw new ValidationError('Unsupported decision.');
  const text = String(note || '').trim();
  if (text.length < 3 || text.length > 255) throw new ValidationError(decision === 'approve' ? 'Enter the payment transaction ID or reference.' : 'Enter the rejection reason.');
  return mysql.withTransaction(async (tx) => {
    const row = await tx.queryOne('SELECT id,affiliate_id,amount_paisa,status FROM affiliate_withdrawals WHERE id=? FOR UPDATE', [id]);
    if (!row) throw new NotFoundError('Withdrawal request not found.');
    if (row.status !== 'pending') throw new ConflictError('This withdrawal request has already been processed.');
    const status = decision === 'approve' ? 'paid' : 'rejected';
    if (status === 'rejected') await tx.execute('UPDATE affiliates SET balance_paisa=balance_paisa+? WHERE id=?', [row.amount_paisa, row.affiliate_id]);
    await tx.execute('UPDATE affiliate_withdrawals SET status=?,admin_note=?,processed_at=UTC_TIMESTAMP() WHERE id=?', [status, text, id]);
    await audit(tx, actor, `affiliate.withdrawal.${decision}`, 'affiliate_withdrawal', id, { status: 'pending', amountPaisa: Number(row.amount_paisa) }, { status, note: text });
    return { id, status };
  });
}

module.exports = { getOverview, saveWalletSettings, saveReferralSettings, updateAffiliate, decideWithdrawal };
