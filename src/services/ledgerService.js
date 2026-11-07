'use strict';

/**
 * Ledger Service
 * ==============
 * Single point of truth for writing immutable vendor_ledger_entries rows.
 * Callers must pass a transaction client (tx) — this service NEVER opens its own.
 *
 * Immutability is enforced at the application layer:
 *  - postEntry() is the ONLY function that INSERTs into vendor_ledger_entries.
 *  - No UPDATE or DELETE of existing entries is ever performed.
 *  - MySQL row-level locking prevents concurrent double-posts via FOR UPDATE on wallet.
 */

const { assertSafePaisa } = require('../utils/money');
const { ValidationError } = require('../utils/errors');

const VALID_ENTRY_TYPES = new Set([
  'credit_earning',
  'maturity_move',
  'debit_payout',
  'debit_refund',
  'credit_refund_reversal',
  'debit_commission_adj',
  'credit_adjustment',
  'debit_adjustment',
]);

const VALID_DIRECTIONS = new Set(['credit', 'debit']);

/**
 * Post a single immutable ledger entry.
 *
 * @param {object} tx              - Transaction query client (must be inside BEGIN...COMMIT)
 * @param {object} params
 * @param {number}  params.vendorId
 * @param {string}  params.entryType        - See VALID_ENTRY_TYPES
 * @param {string}  params.direction        - 'credit' | 'debit'
 * @param {number}  params.amountPaisa      - Positive integer paisa
 * @param {number}  params.balanceAfter     - Running available_paisa after this entry
 * @param {string}  [params.referenceType]  - e.g. 'vendor_order', 'payout_request'
 * @param {number}  [params.referenceId]
 * @param {string}  [params.note]
 * @param {string}  [params.createdByType]  - 'system' | 'admin' | 'vendor'
 * @param {number}  [params.createdById]
 * @returns {Promise<number>} insertId of the new ledger entry
 */
async function postEntry(tx, {
  vendorId,
  entryType,
  direction,
  amountPaisa,
  balanceAfter,
  referenceType = '',
  referenceId   = null,
  note          = '',
  createdByType = 'system',
  createdById   = null,
}) {
  if (!Number.isSafeInteger(Number(vendorId)) || Number(vendorId) < 1) {
    throw new ValidationError('Ledger entry requires a valid vendorId.');
  }
  if (!VALID_ENTRY_TYPES.has(entryType)) {
    throw new ValidationError(`Invalid ledger entry_type: ${entryType}`);
  }
  if (!VALID_DIRECTIONS.has(direction)) {
    throw new ValidationError(`Invalid ledger direction: ${direction}`);
  }
  assertSafePaisa(Number(amountPaisa), 'amountPaisa');
  if (Number(amountPaisa) <= 0) throw new ValidationError('Ledger amountPaisa must be > 0.');

  const result = await tx.execute(
    `INSERT INTO vendor_ledger_entries
       (vendor_id, entry_type, direction, amount_paisa, balance_after_paisa,
        reference_type, reference_id, note, created_by_type, created_by_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      Number(vendorId),
      entryType,
      direction,
      Number(amountPaisa),
      Number(balanceAfter),
      String(referenceType || ''),
      referenceId ? Number(referenceId) : null,
      String(note || '').slice(0, 500),
      String(createdByType || 'system'),
      createdById ? Number(createdById) : null,
    ]
  );

  return Number(result.insertId);
}

/**
 * Read paginated ledger history for a vendor.
 *
 * @param {object} tx
 * @param {number} vendorId
 * @param {object} [opts]
 * @param {number} [opts.page]
 * @param {number} [opts.limit]
 * @param {string} [opts.entryType]  - Filter by entry_type
 * @returns {Promise<{ entries: object[], total: number }>}
 */
async function getLedgerHistory(tx, vendorId, { page = 1, limit = 30, entryType = null } = {}) {
  const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Number(limit));
  const pageSize = Math.min(100, Number(limit));

  const whereClause = entryType
    ? 'WHERE vendor_id = ? AND entry_type = ?'
    : 'WHERE vendor_id = ?';
  const params = entryType ? [Number(vendorId), entryType] : [Number(vendorId)];

  const [countRow, entries] = await Promise.all([
    tx.queryOne(`SELECT COUNT(*) AS total FROM vendor_ledger_entries ${whereClause}`, params),
    tx.queryAll(
      `SELECT id, entry_type, direction, amount_paisa, balance_after_paisa,
              reference_type, reference_id, note, created_by_type, created_by_id, created_at
       FROM vendor_ledger_entries
       ${whereClause}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    ),
  ]);

  return { entries: entries || [], total: Number(countRow?.total || 0) };
}

module.exports = { postEntry, getLedgerHistory };
