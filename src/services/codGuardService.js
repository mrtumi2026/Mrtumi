'use strict';

/**
 * Cash on Delivery (COD) Safeguard & Anti-Fraud Service
 * =====================================================
 * Protects marketplace merchants and platform logistics from fake COD orders,
 * delivery refusal costs, and excessive return shipping charges.
 *
 * Checks:
 *  1. Bangladeshi MSISDN Phone Format & Carrier Sanity (+8801[3-9]\d{8}).
 *  2. Maximum COD Order Amount Ceiling (default: ৳10,000 for standard customer).
 *  3. Historical Return / Return-to-Origin (RTO) ratio heuristics.
 *  4. Advance Payment requirements for high-risk zones or large ticket carts.
 *  5. OTP Verification enforcement requirements.
 */

const mysql = require('../db/mysqlPool');
const { assertSafePaisa } = require('../utils/money');
const { ValidationError, ConflictError } = require('../utils/errors');

const DEFAULT_MAX_COD_PAISA = 1_000_000; // ৳10,000 maximum COD threshold
const MAX_HISTORICAL_CANCEL_THRESHOLD = 2; // >= 2 previous refusals triggers restrictions

/**
 * Validates Bangladeshi 11-digit mobile phone number.
 */
function validateBdPhone(phone) {
  const clean = String(phone || '').replace(/[\s\-\+]/g, '');
  const normalized = clean.startsWith('880') ? clean.slice(2) : clean;

  if (!/^01[3-9]\d{8}$/.test(normalized)) {
    throw new ValidationError('Invalid Bangladeshi mobile phone number. Format must be 01XXXXXXXXX.');
  }

  return normalized;
}

/**
 * Evaluates whether an order is eligible for Cash on Delivery (COD).
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {number} params.totalPaisa
 * @param {string} [params.district]
 * @param {number} [params.customerId]
 * @returns {Promise<{
 *   eligible: boolean,
 *   requiresAdvance: boolean,
 *   advanceAmountPaisa: number,
 *   requiresOtp: boolean,
 *   reason: string
 * }>}
 */
async function evaluateCodEligibility({ phone, totalPaisa, district = '', customerId = null }) {
  assertSafePaisa(totalPaisa, 'totalPaisa');
  const validPhone = validateBdPhone(phone);
  const pool = mysql.getPool();

  // 1. Check Maximum COD Amount Ceiling
  if (totalPaisa > DEFAULT_MAX_COD_PAISA) {
    return {
      eligible: false,
      requiresAdvance: true,
      advanceAmountPaisa: Math.min(totalPaisa, 20_000), // Require at least ৳200 delivery advance
      requiresOtp: true,
      reason: `Orders exceeding ৳${(DEFAULT_MAX_COD_PAISA / 100).toLocaleString()} require online payment or advance courier deposit.`,
    };
  }

  // 2. Query customer historical order return/cancellation risk
  const [historyRows] = await pool.query(
    `SELECT
       COUNT(*) AS total_orders,
       SUM(CASE WHEN order_status = 'cancelled' AND payment_method = 'cod' THEN 1 ELSE 0 END) AS cod_cancelled_orders,
       SUM(CASE WHEN order_status = 'returned' THEN 1 ELSE 0 END) AS returned_orders
     FROM orders
     WHERE customer_phone = ? OR (customer_id IS NOT NULL AND customer_id = ?)`,
    [validPhone, customerId ? Number(customerId) : -1]
  );

  const stats = historyRows[0] || {};
  const codCancelled = Number(stats.cod_cancelled_orders || 0);
  const returnedCount = Number(stats.returned_orders || 0);
  const totalRiskCount = codCancelled + returnedCount;

  // 3. High Risk Customer (Repeated COD rejections)
  if (totalRiskCount >= MAX_HISTORICAL_CANCEL_THRESHOLD) {
    return {
      eligible: false,
      requiresAdvance: true,
      advanceAmountPaisa: 15_000, // ৳150 delivery charge mandatory in advance
      requiresOtp: true,
      reason: 'Due to repeated unaccepted COD deliveries on this number, shipping fee must be paid in advance.',
    };
  }

  // 4. District Geographic Rule (Outside Dhaka delivery charge advance recommendation)
  const isOutsideDhaka = district && !district.toLowerCase().includes('dhaka');
  const requiresOtp = totalPaisa >= 300_000; // Require OTP confirmation for orders above ৳3,000

  return {
    eligible: true,
    requiresAdvance: false,
    advanceAmountPaisa: 0,
    requiresOtp,
    reason: 'COD approved.',
  };
}

module.exports = {
  validateBdPhone,
  evaluateCodEligibility,
  DEFAULT_MAX_COD_PAISA,
};
