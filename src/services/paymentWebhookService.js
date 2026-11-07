'use strict';

/**
 * Payment Webhook & Settlement Processing Service
 * ===============================================
 * Centralized, idempotent, re-entrancy safe webhook and callback handler.
 *
 * Guarantees:
 *  - SHA-256 Idempotency Hash prevents double execution of duplicate/replayed callbacks.
 *  - SERIALIZABLE / row-locked (`SELECT ... FOR UPDATE`) order settlement.
 *  - Atomically marks orders as `paid`, updates `payment_transactions`, and moves
 *    all child `vendor_orders` from 'pending' to 'processing'.
 */

const crypto = require('crypto');
const mysql = require('../db/mysqlPool');
const { updateVendorOrderStatus } = require('./splitOrderService');
const { assertSafePaisa } = require('../utils/money');
const { ConflictError, ValidationError, NotFoundError } = require('../utils/errors');
const { logger } = require('../utils/logger');

/**
 * Computes deterministic SHA-256 hash for idempotency checking.
 */
function computeIdempotencyHash(gatewayCode, eventIdOrPayload) {
  const content = typeof eventIdOrPayload === 'string'
    ? eventIdOrPayload
    : JSON.stringify(eventIdOrPayload);
  return crypto.createHash('sha256').update(`${gatewayCode}:${content}`).digest('hex');
}

/**
 * Verifies webhook HMAC signature (if secret configured).
 */
function verifyWebhookHmac(rawBody, signature, secret) {
  if (!secret) return true; // Signature check skipped if no secret defined
  if (!signature) return false;

  const expectedHmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(String(signature), 'utf8');
  const expBuf = Buffer.from(expectedHmac, 'utf8');

  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Atomically marks an order as paid and advances vendor sub-orders to processing.
 *
 * @param {object} tx - Active MySQL transaction
 * @param {number} orderId
 * @param {object} paymentDetails
 */
async function settleOrderPayment(tx, orderId, {
  gatewayCode,
  paymentId,
  trxId,
  amountPaisa,
  rawResponse = null,
  actor = { type: 'gateway', id: null },
}) {
  const oId = Number(orderId);
  assertSafePaisa(amountPaisa, 'amountPaisa');

  // 1. Lock the order row to prevent concurrent settlement race conditions
  const order = await tx.queryOne(
    'SELECT id, invoice_no, order_status, payment_status, total_paisa, paid_paisa, cod_due_paisa FROM orders WHERE id = ? FOR UPDATE',
    [oId]
  );

  if (!order) {
    throw new NotFoundError(`Order ${oId} not found for payment settlement.`);
  }

  // 2. If already paid, exit early without duplicating credits
  if (order.payment_status === 'paid') {
    logger.info({ event: 'order_already_paid_noop', orderId: oId, trxId });
    return { orderId: oId, alreadySettled: true };
  }

  // 3. Update payment_transactions row to 'captured'
  const idemKey = `pay-${oId}-${gatewayCode}-${trxId || paymentId || Date.now()}`;
  await tx.execute(
    `INSERT INTO payment_transactions
       (order_id, gateway_code, payment_id, trx_id, amount_paisa, status, direction,
        idempotency_key, raw_response, initiated_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'captured', 'charge', ?, ?, NOW(), NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       status = 'captured',
       trx_id = VALUES(trx_id),
       raw_response = VALUES(raw_response),
       completed_at = NOW(),
       updated_at = NOW()`,
    [
      oId,
      gatewayCode,
      String(paymentId || ''),
      String(trxId || ''),
      amountPaisa,
      idemKey,
      rawResponse ? JSON.stringify(rawResponse) : null,
    ]
  );

  // 4. Update parent order state
  const nextPaid = Number(order.paid_paisa) + amountPaisa;
  const nextCodDue = Math.max(0, Number(order.total_paisa) - nextPaid);
  const nextPaymentStatus = nextCodDue === 0 ? 'paid' : 'partially_paid';

  await tx.execute(
    `UPDATE orders
     SET payment_status = ?,
         payment_method = ?,
         paid_paisa     = ?,
         cod_due_paisa  = ?,
         updated_at     = NOW()
     WHERE id = ?`,
    [nextPaymentStatus, gatewayCode, nextPaid, nextCodDue, oId]
  );

  // 5. Transition all child vendor_orders from 'pending' to 'processing'
  const vendorOrders = await tx.queryAll(
    "SELECT id, status FROM vendor_orders WHERE order_id = ? AND status = 'pending' FOR UPDATE",
    [oId]
  );

  for (const vo of vendorOrders) {
    await tx.execute(
      "UPDATE vendor_orders SET status = 'processing', updated_at = NOW() WHERE id = ?",
      [vo.id]
    );
  }

  logger.info({
    event: 'order_payment_settled',
    orderId: oId,
    gatewayCode,
    trxId,
    amountPaisa,
    subOrdersUpdated: vendorOrders.length,
  });

  return {
    orderId: oId,
    alreadySettled: false,
    paymentStatus: nextPaymentStatus,
    subOrdersUpdated: vendorOrders.length,
  };
}

/**
 * Handles incoming webhook execution with strict idempotency and re-entrancy safety.
 */
async function processWebhookEvent({
  gatewayCode,
  eventType = 'callback',
  uniqueEventId,
  headers = {},
  payload = {},
  clientIp = '',
  handlerFn,
}) {
  const pool = mysql.getPool();
  const startTime = Date.now();
  const idempotencyHash = computeIdempotencyHash(gatewayCode, uniqueEventId || payload);

  // Step 1: Idempotency log claim
  try {
    await pool.query(
      `INSERT INTO payment_webhook_logs
         (gateway_code, event_type, idempotency_hash, headers_json, payload_json, status, client_ip, created_at)
       VALUES (?, ?, ?, ?, ?, 'processing', ?, NOW())`,
      [
        gatewayCode,
        eventType,
        idempotencyHash,
        JSON.stringify(headers),
        JSON.stringify(payload),
        clientIp,
      ]
    );
  } catch (err) {
    // If duplicate entry on unique idempotency_hash, this callback was already recorded/processed
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      logger.info({ event: 'webhook_replay_detected', gatewayCode, idempotencyHash });
      const [existing] = await pool.query(
        'SELECT status, response_code, response_body FROM payment_webhook_logs WHERE idempotency_hash = ?',
        [idempotencyHash]
      );
      return {
        isReplay: true,
        status: existing[0]?.status || 'replayed',
        responseCode: existing[0]?.response_code || 200,
        responseBody: existing[0]?.response_body || 'Duplicate callback replayed.',
      };
    }
    throw err;
  }

  // Step 2: Execute actual business handler within a managed database transaction
  let result;
  let processingError = null;

  try {
    result = await mysql.withTransaction(async (tx) => {
      return handlerFn(tx);
    }, { pool, isolationLevel: 'SERIALIZABLE' });
  } catch (err) {
    processingError = err;
    logger.error({ event: 'webhook_execution_failed', gatewayCode, error: err.message });
  }

  const durationMs = Date.now() - startTime;
  const status = processingError ? 'failed' : 'processed';
  const responseCode = processingError ? (processingError.statusCode || 500) : 200;
  const responseBody = processingError
    ? JSON.stringify({ error: processingError.message })
    : JSON.stringify({ success: true, result });

  // Step 3: Update journal with resolution status
  await pool.query(
    `UPDATE payment_webhook_logs
     SET status = ?,
         response_code = ?,
         response_body = ?,
         error_message = ?,
         processing_time_ms = ?,
         updated_at = NOW()
     WHERE idempotency_hash = ?`,
    [
      status,
      responseCode,
      responseBody,
      processingError ? processingError.message : null,
      durationMs,
      idempotencyHash,
    ]
  );

  if (processingError) {
    throw processingError;
  }

  return { isReplay: false, result, responseCode, responseBody };
}

module.exports = {
  computeIdempotencyHash,
  verifyWebhookHmac,
  settleOrderPayment,
  processWebhookEvent,
};
