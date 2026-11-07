'use strict';

/**
 * Vendor Wallet Repository
 * ========================
 * Provides real-time balance queries, double-entry ledger pagination,
 * and payout request handling with zero IDOR exposure.
 */

const mysql = require('../db/mysqlPool');
const { getLedgerHistory } = require('../services/ledgerService');
const { submitPayoutRequest, cancelPayoutRequest } = require('../services/payoutService');

/**
 * Get vendor wallet summary. Auto-initializes if row does not exist yet.
 */
async function getWalletSummary(vendorId) {
  const pool = mysql.getPool();
  const vId = Number(vendorId);

  await pool.query('INSERT IGNORE INTO vendor_wallets (vendor_id) VALUES (?)', [vId]);

  const [rows] = await pool.query(
    `SELECT vendor_id, available_paisa, pending_paisa, locked_paisa,
            lifetime_earned_paisa, lifetime_commission_paisa, updated_at
     FROM vendor_wallets
     WHERE vendor_id = ?`,
    [vId]
  );

  const wallet = rows[0] || {
    vendor_id: vId,
    available_paisa: 0,
    pending_paisa: 0,
    locked_paisa: 0,
    lifetime_earned_paisa: 0,
    lifetime_commission_paisa: 0,
  };

  const [payoutStats] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' THEN approved_paisa ELSE 0 END), 0) AS total_paid_paisa,
       COALESCE(SUM(CASE WHEN status IN ('pending', 'under_review') THEN requested_paisa ELSE 0 END), 0) AS pending_payout_paisa
     FROM vendor_payout_requests
     WHERE vendor_id = ?`,
    [vId]
  );

  return {
    wallet,
    stats: {
      totalPaidPaisa: Number(payoutStats[0]?.total_paid_paisa || 0),
      pendingPayoutPaisa: Number(payoutStats[0]?.pending_payout_paisa || 0),
    },
  };
}

/**
 * List payout requests for a vendor.
 */
async function listPayoutRequests(vendorId, { page = 1, limit = 15 } = {}) {
  const pool = mysql.getPool();
  const vId = Number(vendorId);
  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(limit) || 15));
  const offset = (pageNum - 1) * pageSize;

  const [countRows] = await pool.query(
    'SELECT COUNT(*) AS total FROM vendor_payout_requests WHERE vendor_id = ?',
    [vId]
  );
  const total = Number(countRows[0]?.total || 0);

  const [requests] = await pool.query(
    `SELECT id, requested_paisa, approved_paisa, method, account_number,
            account_name, bank_name, status, admin_note, transaction_ref,
            requested_at, reviewed_at, paid_at
     FROM vendor_payout_requests
     WHERE vendor_id = ?
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [vId, pageSize, offset]
  );

  return {
    requests: requests || [],
    pagination: {
      total,
      page: pageNum,
      limit: pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    },
  };
}

module.exports = {
  getWalletSummary,
  listPayoutRequests,
  getLedgerHistory: async (vendorId, opts) => {
    const client = mysql.createQueryClient(mysql.getPool());
    return getLedgerHistory(client, vendorId, opts);
  },
  submitPayoutRequest,
  cancelPayoutRequest,
};
