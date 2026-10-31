'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
const { recordAuditLog } = require('./auditLogRepository');
const { ConflictError, ValidationError } = require('../utils/errors');

function client(pool = null) {
  if (env.db.client !== 'mysql' && !pool) throw new Error('Admin coupon repository requires MySQL.');
  return createQueryClient(pool || getPool());
}

function parseDate(value) {
  const date = String(value || '2027-12-31').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new ValidationError('Expiry date must be a valid calendar date.');
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)) {
    throw new ValidationError('Expiry date must be a valid calendar date.');
  }
  // The admin form is date-only. Preserve the selected calendar day as eligible through its end.
  return `${date} 23:59:59`;
}

function parsePaisa(value, label, fallback) {
  const raw = value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(String(raw));
  if (!match) throw new ValidationError(`${label} must be a non-negative amount with at most two decimal places.`);
  const paisa = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  if (paisa > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError(`${label} is outside the supported amount range.`);
  return Number(paisa);
}

function normalizeCoupon(input = {}) {
  const code = String(input.code ?? '').trim().toUpperCase();
  if (!code) throw new ValidationError('Coupon code is required.');
  if (code.length > 64) throw new ValidationError('Coupon code must not exceed 64 characters.');

  const legacyType = String(input.type || 'percent').trim();
  if (!['percent', 'flat'].includes(legacyType)) throw new ValidationError('Discount type must be percent or flat amount.');
  const rawValue = input.value === undefined || input.value === null || String(input.value).trim() === '' ? '10' : String(input.value).trim();
  let discountValue;
  if (legacyType === 'percent') {
    if (!/^\d{1,3}$/.test(rawValue) || Number(rawValue) > 100) throw new ValidationError('Percentage must be a whole number from 0 to 100.');
    discountValue = Number(rawValue);
  } else {
    discountValue = parsePaisa(rawValue, 'Flat discount', '10');
  }
  const minPurchasePaisa = parsePaisa(input.min_purchase, 'Minimum purchase', '0');
  const expiresAt = parseDate(input.expiry_date);

  return { code, legacyType, discountType: legacyType === 'flat' ? 'fixed' : 'percent', discountValue, minPurchasePaisa, expiresAt };
}

async function listCoupons({ pool = null } = {}) {
  return client(pool).queryAll(`SELECT id,code,
      CASE WHEN discount_type='fixed' THEN 'flat' ELSE discount_type END AS type,
      CASE WHEN discount_type='fixed' THEN discount_value/100 ELSE discount_value END AS value,
      min_purchase_paisa/100 AS min_purchase,
      DATE_FORMAT(expires_at,'%Y-%m-%d') AS expiry_date,
      used_count,status
    FROM coupons ORDER BY id DESC LIMIT 2000`);
}

async function createCoupon(input = {}, actor = {}, { pool = null } = {}) {
  const coupon = normalizeCoupon(input);
  try {
    return await withTransaction(async tx => {
      const result = await tx.execute(
        'INSERT INTO coupons(code,discount_type,discount_value,min_purchase_paisa,expires_at) VALUES(?,?,?,?,?)',
        [coupon.code,coupon.discountType,coupon.discountValue,coupon.minPurchasePaisa,coupon.expiresAt]
      );
      const created = { id: Number(result.insertId), ...coupon };
      await recordAuditLog({
        actorType: 'admin', actorId: actor.id || null, action: 'coupon.create', entityType: 'coupon', entityId: created.id,
        afterState: { code: created.code, discountType: created.discountType, discountValue: created.discountValue,
          minPurchasePaisa: created.minPurchasePaisa, expiresAt: created.expiresAt },
        ipAddress: actor.ip || '', userAgent: actor.userAgent || '',
      }, tx);
      return created;
    }, { pool: pool || getPool() });
  } catch (error) {
    if (error.code === 'DB_DUPLICATE_ENTRY') throw new ConflictError('A coupon with this code already exists.');
    throw error;
  }
}

module.exports = { listCoupons, createCoupon, normalizeCoupon };
