'use strict';

/**
 * Payout Service
 * ==============
 * Full lifecycle for vendor payout requests:
 *   submit → review → approve/reject → mark_paid
 *
 * Financial state machine:
 *   pending → under_review → approved → paid
 *                          └→ rejected
 *   pending → cancelled (by vendor, before review)
 *
 * On approval  : locked_paisa  += approved_amount, available_paisa -= approved_amount
 * On rejection : locked_paisa  unchanged, no wallet change
 * On mark_paid : locked_paisa  -= paid_amount  (funds left the platform)
 * On cancel    : no wallet change (request never touched wallet)
 */

const mysql   = require('../db/mysqlPool');
const ledger  = require('./ledgerService');
const { assertSafePaisa } = require('../utils/money');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { logger } = require('../utils/logger');

const PAYOUT_METHODS     = ['bkash', 'nagad', 'rocket', 'bank_transfer', 'cod_adjustment'];
const MIN_PAYOUT_PAISA   = 50_000;   // ৳500 minimum
const MAX_PAYOUT_PAISA   = 50_000_000; // ৳5,00,000 maximum per request

/**
 * Vendor submits a payout request.
 *
 * @param {number} vendorId
 * @param {object} input
 * @param {object} [options]
 */
async function submitPayoutRequest(vendorId, input, { actor = { type: 'vendor', id: null }, pool } = {}) {
  const vid    = Number(vendorId);
  const amount = Number(input.amount_bdt || 0);

  // Validate amount
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Enter a valid withdrawal amount.');
  const amountPaisa = Math.round(amount * 100);
  assertSafePaisa(amountPaisa, 'amountPaisa');
  if (amountPaisa < MIN_PAYOUT_PAISA) throw new ValidationError(`Minimum withdrawal is ৳${MIN_PAYOUT_PAISA / 100}.`);
  if (amountPaisa > MAX_PAYOUT_PAISA) throw new ValidationError(`Maximum single withdrawal is ৳${MAX_PAYOUT_PAISA / 100}.`);

  const method = String(input.method || '').toLowerCase();
  if (!PAYOUT_METHODS.includes(method)) throw new ValidationError(`Invalid payment method. Allowed: ${PAYOUT_METHODS.join(', ')}.`);

  const accountNumber = String(input.account_number || '').trim();
  if (accountNumber.length < 5 || accountNumber.length > 100) throw new ValidationError('Enter a valid account number.');

  const accountName  = String(input.account_name  || '').trim().slice(0, 191);
  const bankName     = String(input.bank_name     || '').trim().slice(0, 191);
  const branchName   = String(input.branch_name   || '').trim().slice(0, 191);
  const routingNum   = String(input.routing_number || '').trim().slice(0, 64);

  return mysql.withTransaction(async (tx) => {
    // Verify vendor exists and is active
    const vendor = await tx.queryOne(
      'SELECT id, lifecycle_status FROM vendors WHERE id = ? FOR UPDATE',
      [vid]
    );
    if (!vendor || vendor.lifecycle_status !== 'active') throw new ConflictError('Your vendor account is not active.');

    // Check no pending request already open
    const existing = await tx.queryOne(
      "SELECT id FROM vendor_payout_requests WHERE vendor_id = ? AND status IN ('pending','under_review') LIMIT 1",
      [vid]
    );
    if (existing) throw new ConflictError('You have an open payout request. Wait for it to be resolved before submitting another.');

    // Check wallet balance
    const wallet = await tx.queryOne(
      'SELECT available_paisa FROM vendor_wallets WHERE vendor_id = ? FOR UPDATE',
      [vid]
    );
    if (!wallet) throw new ConflictError('Vendor wallet not found. Contact support.');
    if (Number(wallet.available_paisa) < amountPaisa) {
      throw new ConflictError(`Insufficient wallet balance. Available: ৳${(Number(wallet.available_paisa)/100).toFixed(2)}`);
    }

    const ins = await tx.execute(
      `INSERT INTO vendor_payout_requests
         (vendor_id, requested_paisa, method, account_number, account_name,
          bank_name, branch_name, routing_number, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [vid, amountPaisa, method, accountNumber, accountName, bankName, branchName, routingNum]
    );

    logger.info({ event: 'payout_request_submitted', vendorId: vid, amountPaisa, method });
    return { payoutRequestId: Number(ins.insertId), amountPaisa };
  }, { pool, isolationLevel: 'SERIALIZABLE' });
}

/**
 * Admin approves a payout request.
 * Locks the requested amount in vendor wallet (available → locked).
 *
 * @param {number} payoutRequestId
 * @param {object} input  - { approved_amount_bdt, admin_note }
 * @param {object} options
 */
async function approvePayoutRequest(payoutRequestId, input, { actor = { type: 'admin', id: null }, pool } = {}) {
  return mysql.withTransaction(async (tx) => {
    const req = await tx.queryOne(
      'SELECT * FROM vendor_payout_requests WHERE id = ? FOR UPDATE',
      [payoutRequestId]
    );
    if (!req) throw new NotFoundError('Payout request not found.');
    if (!['pending', 'under_review'].includes(req.status)) {
      throw new ConflictError(`Cannot approve a request in status: ${req.status}`);
    }

    // Admin may approve a lower amount than requested
    const rawApproved = input.approved_amount_bdt
      ? Math.round(Number(input.approved_amount_bdt) * 100)
      : Number(req.requested_paisa);
    assertSafePaisa(rawApproved, 'approved_paisa');
    if (rawApproved <= 0) throw new ValidationError('Approved amount must be > 0.');
    if (rawApproved > Number(req.requested_paisa)) throw new ValidationError('Approved amount cannot exceed requested amount.');

    const adminNote = String(input.admin_note || '').trim().slice(0, 1000);

    // Lock wallet and move available → locked
    const wallet = await tx.queryOne(
      'SELECT available_paisa, locked_paisa FROM vendor_wallets WHERE vendor_id = ? FOR UPDATE',
      [req.vendor_id]
    );
    if (!wallet) throw new ConflictError('Vendor wallet not found.');
    if (Number(wallet.available_paisa) < rawApproved) {
      throw new ConflictError('Vendor no longer has sufficient available balance.');
    }

    const newAvailable = Number(wallet.available_paisa) - rawApproved;
    const newLocked    = Number(wallet.locked_paisa)    + rawApproved;

    await tx.execute(
      'UPDATE vendor_wallets SET available_paisa = ?, locked_paisa = ?, updated_at = NOW() WHERE vendor_id = ?',
      [newAvailable, newLocked, req.vendor_id]
    );

    await tx.execute(
      `UPDATE vendor_payout_requests
       SET status = 'approved', approved_paisa = ?, admin_note = ?,
           reviewed_by_user_id = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [rawApproved, adminNote, actor.id, payoutRequestId]
    );

    logger.info({ event: 'payout_approved', payoutRequestId, vendorId: req.vendor_id, approvedPaisa: rawApproved, adminId: actor.id });
    return { payoutRequestId, approvedPaisa: rawApproved };
  }, { pool, isolationLevel: 'SERIALIZABLE' });
}

/**
 * Admin rejects a payout request. Wallet unchanged.
 */
async function rejectPayoutRequest(payoutRequestId, input, { actor = { type: 'admin', id: null }, pool } = {}) {
  return mysql.withTransaction(async (tx) => {
    const req = await tx.queryOne(
      'SELECT * FROM vendor_payout_requests WHERE id = ? FOR UPDATE',
      [payoutRequestId]
    );
    if (!req) throw new NotFoundError('Payout request not found.');
    if (!['pending', 'under_review'].includes(req.status)) {
      throw new ConflictError(`Cannot reject a request in status: ${req.status}`);
    }

    const reason = String(input.admin_note || input.reason || '').trim().slice(0, 1000);
    if (!reason) throw new ValidationError('A rejection reason is required.');

    await tx.execute(
      `UPDATE vendor_payout_requests
       SET status = 'rejected', admin_note = ?,
           reviewed_by_user_id = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [reason, actor.id, payoutRequestId]
    );

    logger.info({ event: 'payout_rejected', payoutRequestId, vendorId: req.vendor_id, adminId: actor.id });
    return { payoutRequestId };
  }, { pool, isolationLevel: 'READ COMMITTED' });
}

/**
 * Admin marks a payout as paid (after actual bank/mobile transfer).
 * Releases locked_paisa (funds leave the platform).
 */
async function markPayoutPaid(payoutRequestId, input, { actor = { type: 'admin', id: null }, pool } = {}) {
  return mysql.withTransaction(async (tx) => {
    const req = await tx.queryOne(
      'SELECT * FROM vendor_payout_requests WHERE id = ? FOR UPDATE',
      [payoutRequestId]
    );
    if (!req) throw new NotFoundError('Payout request not found.');
    if (req.status !== 'approved') throw new ConflictError('Only approved requests can be marked as paid.');

    const transactionRef = String(input.transaction_ref || '').trim().slice(0, 255);
    if (!transactionRef) throw new ValidationError('Transaction reference (TrxID/bank ref) is required.');

    const paidAmount = Number(req.approved_paisa);

    // Release from locked_paisa
    const wallet = await tx.queryOne(
      'SELECT locked_paisa, available_paisa FROM vendor_wallets WHERE vendor_id = ? FOR UPDATE',
      [req.vendor_id]
    );
    if (!wallet) throw new ConflictError('Vendor wallet not found.');

    const newLocked = Math.max(0, Number(wallet.locked_paisa) - paidAmount);

    await tx.execute(
      'UPDATE vendor_wallets SET locked_paisa = ?, updated_at = NOW() WHERE vendor_id = ?',
      [newLocked, req.vendor_id]
    );

    // Post immutable ledger debit
    const ledgerEntryId = await ledger.postEntry(tx, {
      vendorId:      req.vendor_id,
      entryType:     'debit_payout',
      direction:     'debit',
      amountPaisa:   paidAmount,
      balanceAfter:  Number(wallet.available_paisa), // available was not changed on approval
      referenceType: 'payout_request',
      referenceId:   payoutRequestId,
      note:          `Payout paid via ${req.method}. Ref: ${transactionRef}`,
      createdByType: actor.type,
      createdById:   actor.id,
    });

    await tx.execute(
      `UPDATE vendor_payout_requests
       SET status = 'paid', transaction_ref = ?, paid_at = NOW(),
           ledger_entry_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [transactionRef, ledgerEntryId, payoutRequestId]
    );

    logger.info({ event: 'payout_paid', payoutRequestId, vendorId: req.vendor_id, paidAmount, transactionRef });
    return { payoutRequestId, paidAmount };
  }, { pool, isolationLevel: 'SERIALIZABLE' });
}

/**
 * Vendor cancels their own pending request (before admin review).
 */
async function cancelPayoutRequest(payoutRequestId, vendorId, { actor = { type: 'vendor', id: null }, pool } = {}) {
  return mysql.withTransaction(async (tx) => {
    const req = await tx.queryOne(
      'SELECT * FROM vendor_payout_requests WHERE id = ? AND vendor_id = ? FOR UPDATE',
      [payoutRequestId, vendorId]
    );
    if (!req) throw new NotFoundError('Payout request not found.');
    if (req.status !== 'pending') throw new ConflictError('Only pending requests can be cancelled.');

    await tx.execute(
      "UPDATE vendor_payout_requests SET status = 'cancelled', updated_at = NOW() WHERE id = ?",
      [payoutRequestId]
    );

    logger.info({ event: 'payout_cancelled', payoutRequestId, vendorId });
    return { payoutRequestId };
  }, { pool, isolationLevel: 'READ COMMITTED' });
}

/**
 * Process a refund: reverse platform commission and deduct from vendor wallet.
 *
 * Called when a customer return is fully approved.
 *
 * @param {number} vendorOrderId   - The affected vendor sub-order
 * @param {number} refundPaisa     - Amount to refund to customer
 * @param {object} options
 */
async function processRefund(vendorOrderId, refundPaisa, { actor = { type: 'admin', id: null }, pool } = {}) {
  assertSafePaisa(Number(refundPaisa), 'refundPaisa');
  if (Number(refundPaisa) <= 0) throw new ValidationError('refundPaisa must be > 0.');

  return mysql.withTransaction(async (tx) => {
    const vo = await tx.queryOne(
      'SELECT * FROM vendor_orders WHERE id = ? FOR UPDATE',
      [vendorOrderId]
    );
    if (!vo) throw new NotFoundError(`Vendor order ${vendorOrderId} not found.`);

    // The commission was already charged — we proportionally reverse it
    const totalSub     = Number(vo.subtotal_paisa);
    const totalComm    = Number(vo.commission_paisa);
    const earn         = Number(vo.vendor_earning_paisa);
    const refundRatio  = totalSub > 0 ? Math.min(1, Number(refundPaisa) / totalSub) : 0;
    const commReverse  = Math.round(totalComm * refundRatio);
    const vendorDebit  = Math.round(earn * refundRatio);

    const wallet = await tx.queryOne(
      'SELECT available_paisa, pending_paisa FROM vendor_wallets WHERE vendor_id = ? FOR UPDATE',
      [vo.vendor_id]
    );
    if (!wallet) throw new ConflictError('Vendor wallet not found.');

    // Deduct from available first, then from pending if available is insufficient
    let remainingDebit  = vendorDebit;
    let newAvailable    = Number(wallet.available_paisa);
    let newPending      = Number(wallet.pending_paisa);

    if (newAvailable >= remainingDebit) {
      newAvailable -= remainingDebit;
      remainingDebit = 0;
    } else {
      remainingDebit -= newAvailable;
      newAvailable = 0;
      newPending = Math.max(0, newPending - remainingDebit);
    }

    await tx.execute(
      'UPDATE vendor_wallets SET available_paisa = ?, pending_paisa = ?, updated_at = NOW() WHERE vendor_id = ?',
      [newAvailable, newPending, vo.vendor_id]
    );

    // Post commission reversal entry
    if (commReverse > 0) {
      await ledger.postEntry(tx, {
        vendorId:      vo.vendor_id,
        entryType:     'credit_refund_reversal',
        direction:     'credit',
        amountPaisa:   commReverse,
        balanceAfter:  newAvailable,
        referenceType: 'vendor_order',
        referenceId:   vendorOrderId,
        note:          `Refund approved — commission reversed ৳${(commReverse/100).toFixed(2)} (${(refundRatio*100).toFixed(1)}% of order)`,
        createdByType: actor.type,
        createdById:   actor.id,
      });
    }

    // Post earning debit entry
    if (vendorDebit > 0) {
      await ledger.postEntry(tx, {
        vendorId:      vo.vendor_id,
        entryType:     'debit_refund',
        direction:     'debit',
        amountPaisa:   vendorDebit,
        balanceAfter:  newAvailable,
        referenceType: 'vendor_order',
        referenceId:   vendorOrderId,
        note:          `Refund approved — ৳${(vendorDebit/100).toFixed(2)} debited from wallet`,
        createdByType: actor.type,
        createdById:   actor.id,
      });
    }

    logger.info({ event: 'refund_processed', vendorOrderId, refundPaisa, vendorDebit, commReverse });
    return { vendorOrderId, refundPaisa, vendorDebit, commReverse };
  }, { pool, isolationLevel: 'SERIALIZABLE' });
}

module.exports = {
  submitPayoutRequest,
  approvePayoutRequest,
  rejectPayoutRequest,
  markPayoutPaid,
  cancelPayoutRequest,
  processRefund,
};
