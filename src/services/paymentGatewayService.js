'use strict';

/**
 * Payment Gateway Service — Phase 2
 * ===================================
 * Production-grade server-side adapters for Bangladesh payment gateways:
 *
 *   • bKash Tokenized Checkout  (Grant Token → Create Payment → Execute → Query)
 *   • UddoktaPay                (Create Payment → Verify IPN)
 *   • ShurjoPay                 (Initiate → Verify)
 *   • Manual Mobile Banking     (TrxID submission + admin verification)
 *   • COD                       (no-op gateway; order records unpaid)
 *
 * Security:
 *   - Credentials loaded from env/DB; never from request body.
 *   - All webhook callbacks verified via HMAC or provider signature before trusting.
 *   - Gateway TrxIDs/tokens stored in payment_transactions; no card data stored.
 *   - Idempotency keys prevent duplicate charges on retry.
 */

const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

const mysql   = require('../db/mysqlPool');
const ledger  = require('./ledgerService');
const { assertSafePaisa } = require('../utils/money');
const { ValidationError, ConflictError, NotFoundError, AppError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const { env }   = require('../config/env');

// ─── Internal HTTP helper (no external dependencies like axios) ──────────────

function httpsPost(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
      timeout: 15_000,
    };

    const proto = parsed.protocol === 'https:' ? https : http;
    const req   = proto.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new AppError('GATEWAY_TIMEOUT', 'Payment gateway did not respond in time.', 504)); });
    req.write(bodyStr);
    req.end();
  });
}

function httpsGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'GET',
      headers,
      timeout:  15_000,
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new AppError('GATEWAY_TIMEOUT', 'Gateway timeout.', 504)); });
    req.end();
  });
}

// ─── Load gateway config from DB ─────────────────────────────────────────────

async function loadGatewayConfig(gatewayCode) {
  const pool = mysql.getPool();
  const [rows] = await pool.query(
    'SELECT * FROM payment_gateways WHERE code = ? AND status = 1 LIMIT 1',
    [gatewayCode]
  );
  const row = rows && rows[0];
  if (!row) throw new ConflictError(`Payment gateway "${gatewayCode}" is not configured or is disabled.`);

  let config = {};
  if (row.config_json) {
    try { config = JSON.parse(row.config_json); } catch { /* ignore corrupt JSON */ }
  }
  return { ...row, config };
}

// ─── Idempotency helper ───────────────────────────────────────────────────────

function makeIdempotencyKey(orderId, gatewayCode, suffix = '') {
  return `pay-${orderId}-${gatewayCode}${suffix ? '-' + suffix : ''}`;
}

// ─── Payment transaction recorder ────────────────────────────────────────────

async function recordTransaction(tx, {
  orderId, gatewayCode, gatewayTrxId = '', amountPaisa, status,
  direction = 'charge', gatewayResponse = null, webhookEvent = '',
  webhookVerified = false, idempotencyKey = null,
}) {
  const result = await tx.execute(
    `INSERT INTO payment_transactions
       (order_id, gateway_code, gateway_trx_id, amount_paisa, status, direction,
        gateway_response, webhook_event, webhook_verified, idempotency_key,
        initiated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       gateway_trx_id = VALUES(gateway_trx_id),
       gateway_response = VALUES(gateway_response),
       webhook_verified = VALUES(webhook_verified),
       updated_at = NOW()`,
    [
      orderId, gatewayCode, String(gatewayTrxId || ''),
      amountPaisa, status, direction,
      gatewayResponse ? JSON.stringify(gatewayResponse) : null,
      webhookEvent, webhookVerified ? 1 : 0,
      idempotencyKey || null,
    ]
  );
  return result;
}

// ─── Mark order as paid ───────────────────────────────────────────────────────

async function markOrderPaid(tx, orderId, { gatewayCode, gatewayTrxId, amountPaisa }) {
  await tx.execute(
    `UPDATE orders
     SET payment_status = 'paid',
         paid_paisa     = paid_paisa + ?,
         cod_due_paisa  = GREATEST(0, cod_due_paisa - ?),
         payment_method = ?,
         updated_at     = NOW()
     WHERE id = ?`,
    [amountPaisa, amountPaisa, gatewayCode, orderId]
  );
  logger.info({ event: 'order_marked_paid', orderId, gatewayCode, gatewayTrxId, amountPaisa });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BKASH TOKENIZED CHECKOUT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Step 1: Obtain a grant token from bKash.
 * Token is short-lived (60 min). Cache it in env or DB for reuse.
 */
async function bkashGrantToken(config) {
  const baseUrl = config.sandbox
    ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
    : 'https://tokenized.pay.bka.sh/v1.2.0-beta';

  const resp = await httpsPost(
    `${baseUrl}/tokenized/checkout/token/grant`,
    { app_key: config.config.app_key, app_secret: config.config.app_secret },
    {
      username:  config.config.app_key,
      password:  config.config.app_secret,
    }
  );

  if (resp.status !== 200 || !resp.body.id_token) {
    throw new AppError('BKASH_TOKEN_ERROR', `bKash token grant failed: ${JSON.stringify(resp.body)}`, 502);
  }
  return { idToken: resp.body.id_token, refreshToken: resp.body.refresh_token };
}

/**
 * Step 2: Create a bKash payment session. Returns paymentID + bkashURL.
 *
 * @param {number} orderId
 * @param {number} amountPaisa
 * @param {object} callbackUrls  - { successUrl, failUrl, cancelUrl }
 * @param {object} [options]
 * @returns {{ paymentID: string, bkashURL: string }}
 */
async function bkashCreatePayment(orderId, amountPaisa, callbackUrls, { pool } = {}) {
  assertSafePaisa(Number(amountPaisa), 'amountPaisa');
  const cfg     = await loadGatewayConfig('bkash_auto');
  const baseUrl = cfg.sandbox
    ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
    : 'https://tokenized.pay.bka.sh/v1.2.0-beta';

  const { idToken } = await bkashGrantToken(cfg);
  const idem        = makeIdempotencyKey(orderId, 'bkash', 'create');
  const amountBdt   = (Number(amountPaisa) / 100).toFixed(2);

  const resp = await httpsPost(
    `${baseUrl}/tokenized/checkout/create`,
    {
      mode:            '0011',  // Tokenized
      payerReference:  String(orderId),
      callbackURL:     callbackUrls.successUrl,
      amount:          amountBdt,
      currency:        'BDT',
      intent:          'sale',
      merchantInvoiceNumber: `ORD-${orderId}`,
    },
    {
      Authorization:    idToken,
      'X-APP-Key':      cfg.config.app_key,
    }
  );

  if (resp.status !== 200 || !resp.body.paymentID) {
    throw new AppError('BKASH_CREATE_ERROR', `bKash create payment failed: ${JSON.stringify(resp.body)}`, 502);
  }

  // Record initiated transaction
  const p = mysql.getPool();
  await p.query(
    `INSERT INTO payment_transactions
       (order_id, gateway_code, gateway_trx_id, amount_paisa, status, idempotency_key, initiated_at, created_at)
     VALUES (?, 'bkash_auto', ?, ?, 'initiated', ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE status = 'initiated', gateway_trx_id = VALUES(gateway_trx_id), updated_at = NOW()`,
    [orderId, resp.body.paymentID, amountPaisa, idem]
  );

  return { paymentID: resp.body.paymentID, bkashURL: resp.body.bkashURL };
}

/**
 * Step 3: Execute a bKash payment after customer completes on bKash UI.
 * Called from the callback URL handler.
 *
 * @param {string} paymentID   - Returned by bKash in callback query params
 * @param {number} orderId     - Extracted from payerReference
 * @returns {{ transactionID: string, amountPaisa: number }}
 */
async function bkashExecutePayment(paymentID, orderId, { pool } = {}) {
  const cfg     = await loadGatewayConfig('bkash_auto');
  const baseUrl = cfg.sandbox
    ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
    : 'https://tokenized.pay.bka.sh/v1.2.0-beta';

  const { idToken } = await bkashGrantToken(cfg);

  const resp = await httpsPost(
    `${baseUrl}/tokenized/checkout/execute`,
    { paymentID },
    { Authorization: idToken, 'X-APP-Key': cfg.config.app_key }
  );

  if (resp.status !== 200 || resp.body.statusCode !== '0000') {
    throw new AppError('BKASH_EXECUTE_ERROR', `bKash execute failed: ${resp.body.statusMessage || JSON.stringify(resp.body)}`, 502);
  }

  const transactionID = resp.body.trxID;
  const amountBdt     = Number(resp.body.amount || 0);
  const amountPaisa   = Math.round(amountBdt * 100);

  return mysql.withTransaction(async (tx) => {
    await recordTransaction(tx, {
      orderId, gatewayCode: 'bkash_auto', gatewayTrxId: transactionID,
      amountPaisa, status: 'completed', gatewayResponse: resp.body, webhookVerified: false,
    });
    await markOrderPaid(tx, orderId, { gatewayCode: 'bkash_auto', gatewayTrxId: transactionID, amountPaisa });
    return { transactionID, amountPaisa };
  }, { pool });
}

/**
 * Step 4: Query a bKash payment status (for reconciliation / cron jobs).
 */
async function bkashQueryPayment(paymentID) {
  const cfg     = await loadGatewayConfig('bkash_auto');
  const baseUrl = cfg.sandbox
    ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
    : 'https://tokenized.pay.bka.sh/v1.2.0-beta';

  const { idToken } = await bkashGrantToken(cfg);

  const resp = await httpsGet(
    `${baseUrl}/tokenized/checkout/payment/status?paymentID=${encodeURIComponent(paymentID)}`,
    { Authorization: idToken, 'X-APP-Key': cfg.config.app_key }
  );

  return resp.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UDDOKTAPAY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a UddoktaPay payment.
 * Returns the payment_url to redirect the customer.
 *
 * @param {number} orderId
 * @param {number} amountPaisa
 * @param {object} customer   - { name, email, phone }
 * @param {object} [options]
 * @returns {{ payment_url: string, full_name: string, invoice_id: string }}
 */
async function uddoktaPayCreatePayment(orderId, amountPaisa, customer, { pool } = {}) {
  assertSafePaisa(Number(amountPaisa), 'amountPaisa');
  const cfg     = await loadGatewayConfig('uddoktapay');
  const baseUrl = String(cfg.config.base_url || 'https://uddoktapay.com').replace(/\/$/, '');
  const apiKey  = String(cfg.config.api_key || '');
  const redirectUrl = `${env.appUrl}/payment/uddoktapay/callback`;
  const cancelUrl   = `${env.appUrl}/payment/uddoktapay/cancel?order_id=${orderId}`;
  const idem        = makeIdempotencyKey(orderId, 'uddoktapay');

  const resp = await httpsPost(
    `${baseUrl}/api/checkout-v2`,
    {
      full_name:    String(customer.name  || 'Customer').slice(0, 100),
      email:        String(customer.email || `order${orderId}@mrtumi.local`),
      amount:       (Number(amountPaisa) / 100).toFixed(2),
      metadata:     { order_id: String(orderId), invoice: `ORD-${orderId}` },
      redirect_url: redirectUrl,
      cancel_url:   cancelUrl,
      webhook_url:  `${env.appUrl}/webhooks/uddoktapay`,
    },
    {
      'RT-UDDOKTAPAY-API-KEY': apiKey,
      'Content-Type':          'application/json',
    }
  );

  if (resp.status !== 200 || !resp.body.payment_url) {
    throw new AppError('UDDOKTA_CREATE_ERROR', `UddoktaPay payment creation failed: ${JSON.stringify(resp.body)}`, 502);
  }

  const p = mysql.getPool();
  await p.query(
    `INSERT INTO payment_transactions
       (order_id, gateway_code, gateway_trx_id, amount_paisa, status, idempotency_key, initiated_at, created_at)
     VALUES (?, 'uddoktapay', ?, ?, 'initiated', ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE status='initiated', updated_at=NOW()`,
    [orderId, resp.body.invoice_id || '', amountPaisa, idem]
  );

  return { payment_url: resp.body.payment_url, invoice_id: resp.body.invoice_id };
}

/**
 * Verify UddoktaPay IPN callback.
 * UddoktaPay sends a POST with { invoice_id, status, metadata, ... }.
 * Verify by re-fetching the invoice from the API.
 *
 * @param {object} body    - Raw IPN POST body
 * @returns {{ verified: boolean, orderId: number, amountPaisa: number, status: string }}
 */
async function uddoktaPayVerifyIpn(body) {
  const invoiceId = String(body.invoice_id || body.metadata?.invoice_id || '');
  if (!invoiceId) throw new ValidationError('IPN missing invoice_id.');

  const cfg     = await loadGatewayConfig('uddoktapay');
  const baseUrl = String(cfg.config.base_url || 'https://uddoktapay.com').replace(/\/$/, '');
  const apiKey  = String(cfg.config.api_key || '');

  // Re-fetch from provider to verify (don't trust the IPN body alone)
  const resp = await httpsPost(
    `${baseUrl}/api/verify-payment`,
    { invoice_id: invoiceId },
    { 'RT-UDDOKTAPAY-API-KEY': apiKey, 'Content-Type': 'application/json' }
  );

  if (resp.status !== 200) throw new AppError('UDDOKTA_VERIFY_ERROR', 'UddoktaPay verification request failed.', 502);

  const data   = resp.body;
  const paid   = data.status === 'COMPLETED';
  const amount = Number(data.amount || 0);
  const orderId = Number(data.metadata?.order_id || 0);

  if (!orderId) throw new ValidationError('UddoktaPay IPN missing order_id in metadata.');

  return {
    verified:    paid,
    orderId,
    amountPaisa: Math.round(amount * 100),
    status:      data.status,
    invoiceId,
    rawResponse: data,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHURJOPAY
// ═══════════════════════════════════════════════════════════════════════════════

async function shurjopayGetToken(cfg) {
  const baseUrl = cfg.sandbox
    ? 'https://sandbox.shurjopayment.com'
    : 'https://engine.shurjopayment.com';

  const resp = await httpsPost(
    `${baseUrl}/api/get_token`,
    {
      username: cfg.config.username,
      password: cfg.config.password,
    },
    { 'Content-Type': 'application/json' }
  );

  if (resp.status !== 200 || !resp.body.token) {
    throw new AppError('SHURJO_TOKEN_ERROR', `ShurjoPay token failed: ${JSON.stringify(resp.body)}`, 502);
  }
  return { token: resp.body.token, storeId: resp.body.store_id, executeUrl: resp.body.execute_url };
}

/**
 * Initiate ShurjoPay payment.
 */
async function shurjopayInitiate(orderId, amountPaisa, customer, { pool } = {}) {
  assertSafePaisa(Number(amountPaisa), 'amountPaisa');
  const cfg     = await loadGatewayConfig('shurjopay');
  const baseUrl = cfg.sandbox
    ? 'https://sandbox.shurjopayment.com'
    : 'https://engine.shurjopayment.com';

  const { token, storeId } = await shurjopayGetToken(cfg);
  const prefix = `SP-${Date.now()}-${orderId}`;

  const resp = await httpsPost(
    `${baseUrl}/api/secret-pay`,
    {
      prefix,
      token,
      store_id:         storeId,
      return_url:       `${env.appUrl}/payment/shurjopay/callback`,
      cancel_url:       `${env.appUrl}/payment/shurjopay/cancel?order_id=${orderId}`,
      amount:           (Number(amountPaisa) / 100).toFixed(2),
      currency:         'BDT',
      order_id:         `ORD-${orderId}`,
      discsount_amount: 0,
      disc_percent:     0,
      client_ip:        '127.0.0.1',
      customer_name:    String(customer.name  || 'Customer').slice(0, 100),
      customer_phone:   String(customer.phone || ''),
      customer_email:   String(customer.email || `order${orderId}@mrtumi.local`),
      customer_address: String(customer.address || ''),
      customer_city:    String(customer.city   || ''),
      customer_state:   '',
      customer_postcode:'',
      customer_country: 'Bangladesh',
      value1: String(orderId),
    },
    { 'Content-Type': 'application/json' }
  );

  if (resp.status !== 200 || !resp.body.checkout_url) {
    throw new AppError('SHURJO_INITIATE_ERROR', `ShurjoPay initiate failed: ${JSON.stringify(resp.body)}`, 502);
  }

  const p = mysql.getPool();
  await p.query(
    `INSERT INTO payment_transactions
       (order_id, gateway_code, gateway_trx_id, amount_paisa, status, idempotency_key, initiated_at, created_at)
     VALUES (?, 'shurjopay', ?, ?, 'initiated', ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE status='initiated', updated_at=NOW()`,
    [orderId, resp.body.sp_order_id || prefix, amountPaisa, makeIdempotencyKey(orderId, 'shurjopay')]
  );

  return { checkout_url: resp.body.checkout_url, sp_order_id: resp.body.sp_order_id };
}

/**
 * Verify ShurjoPay payment after callback.
 * SP sends `order_id` (their internal ref) in callback. We re-verify server-side.
 */
async function shurjopayVerify(spOrderId, orderId, { pool } = {}) {
  const cfg     = await loadGatewayConfig('shurjopay');
  const baseUrl = cfg.sandbox
    ? 'https://sandbox.shurjopayment.com'
    : 'https://engine.shurjopayment.com';

  const { token } = await shurjopayGetToken(cfg);

  const resp = await httpsPost(
    `${baseUrl}/api/verification`,
    { order_id: spOrderId },
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  );

  if (resp.status !== 200 || !Array.isArray(resp.body) || !resp.body[0]) {
    throw new AppError('SHURJO_VERIFY_ERROR', `ShurjoPay verify failed: ${JSON.stringify(resp.body)}`, 502);
  }

  const data     = resp.body[0];
  const paid     = data.sp_message === 'Success';
  const spTrxId  = data.bank_trx_id || data.id || spOrderId;
  const paid_amt = Number(data.amount || 0);

  if (paid) {
    return mysql.withTransaction(async (tx) => {
      const amountPaisa = Math.round(paid_amt * 100);
      await recordTransaction(tx, {
        orderId, gatewayCode: 'shurjopay', gatewayTrxId: spTrxId,
        amountPaisa, status: 'completed', gatewayResponse: data, webhookVerified: true,
      });
      await markOrderPaid(tx, orderId, { gatewayCode: 'shurjopay', gatewayTrxId: spTrxId, amountPaisa });
      return { verified: true, transactionID: spTrxId, amountPaisa };
    }, { pool });
  }

  return { verified: false, status: data.sp_message, raw: data };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL MOBILE BANKING (bKash/Nagad/Rocket — TrxID submission)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Customer submits TrxID after manual mobile banking transfer.
 * No external API call — record is pending admin verification.
 */
async function manualBankingSubmit(orderId, { gatewayCode, trxId, senderPhone, amountPaisa }, { pool } = {}) {
  const MANUAL_CODES = ['manual_bkash', 'manual_nagad', 'manual_rocket'];
  if (!MANUAL_CODES.includes(gatewayCode)) throw new ValidationError('Invalid manual gateway code.');
  const cleanTrxId = String(trxId || '').trim();
  if (cleanTrxId.length < 4 || cleanTrxId.length > 100) throw new ValidationError('Enter a valid Transaction ID (TrxID).');
  assertSafePaisa(Number(amountPaisa), 'amountPaisa');

  const p = mysql.getPool();
  const idem = makeIdempotencyKey(orderId, gatewayCode);

  await p.query(
    `INSERT INTO payment_transactions
       (order_id, gateway_code, gateway_trx_id, amount_paisa, status, gateway_response, idempotency_key, initiated_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       gateway_trx_id = VALUES(gateway_trx_id),
       status = 'pending',
       gateway_response = VALUES(gateway_response),
       updated_at = NOW()`,
    [
      orderId, gatewayCode, cleanTrxId, amountPaisa,
      JSON.stringify({ trxId: cleanTrxId, senderPhone: String(senderPhone || ''), submittedAt: new Date().toISOString() }),
      idem,
    ]
  );

  logger.info({ event: 'manual_banking_submitted', orderId, gatewayCode, trxId: cleanTrxId });
  return { orderId, gatewayCode, trxId: cleanTrxId, status: 'pending_verification' };
}

/**
 * Admin verifies a manual TrxID and marks the order as paid.
 */
async function manualBankingVerify(orderId, { gatewayCode, approve, adminNote }, { actor = { type: 'admin', id: null }, pool } = {}) {
  return mysql.withTransaction(async (tx) => {
    const trx = await tx.queryOne(
      "SELECT * FROM payment_transactions WHERE order_id = ? AND gateway_code = ? AND status = 'pending' FOR UPDATE",
      [orderId, gatewayCode]
    );
    if (!trx) throw new NotFoundError('No pending manual payment found for this order and gateway.');

    if (approve) {
      await tx.execute(
        "UPDATE payment_transactions SET status = 'completed', webhook_verified = 1, completed_at = NOW(), updated_at = NOW() WHERE id = ?",
        [trx.id]
      );
      await markOrderPaid(tx, orderId, { gatewayCode, gatewayTrxId: trx.gateway_trx_id, amountPaisa: Number(trx.amount_paisa) });
    } else {
      await tx.execute(
        "UPDATE payment_transactions SET status = 'failed', gateway_response = JSON_SET(COALESCE(gateway_response, '{}'), '$.admin_rejection_note', ?), updated_at = NOW() WHERE id = ?",
        [String(adminNote || ''), trx.id]
      );
    }

    return { orderId, approved: Boolean(approve) };
  }, { pool });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verifies and dispatches inbound webhook payloads to the correct handler.
 * Called from the webhook route after the raw body is captured.
 *
 * @param {string} gatewayCode  - From URL path (e.g. 'uddoktapay', 'bkash_auto')
 * @param {Buffer} rawBody      - Raw request body bytes for HMAC verification
 * @param {string} signature    - Signature header value
 * @param {object} parsedBody   - JSON-parsed body object
 * @returns {Promise<{ processed: boolean, orderId: number }>}
 */
async function handleWebhook(gatewayCode, rawBody, signature, parsedBody) {
  const cfg = await loadGatewayConfig(gatewayCode);

  // ── Signature verification ──
  if (cfg.webhook_secret) {
    const expected = crypto
      .createHmac('sha256', cfg.webhook_secret)
      .update(rawBody)
      .digest('hex');

    // Constant-time comparison
    const sigBuf  = Buffer.from(String(signature || ''), 'utf8');
    const expBuf  = Buffer.from(expected, 'utf8');
    const valid   = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
      logger.warn({ event: 'webhook_signature_invalid', gatewayCode });
      throw new AppError('WEBHOOK_INVALID_SIGNATURE', 'Webhook signature verification failed.', 401);
    }
  }

  // ── Route to gateway handler ──
  if (gatewayCode === 'uddoktapay') {
    const result = await uddoktaPayVerifyIpn(parsedBody);
    if (result.verified) {
      const pool = mysql.getPool();
      return mysql.withTransaction(async (tx) => {
        await recordTransaction(tx, {
          orderId:         result.orderId,
          gatewayCode:     'uddoktapay',
          gatewayTrxId:    result.invoiceId,
          amountPaisa:     result.amountPaisa,
          status:          'completed',
          gatewayResponse: result.rawResponse,
          webhookEvent:    'ipn',
          webhookVerified: true,
        });
        await markOrderPaid(tx, result.orderId, {
          gatewayCode:  'uddoktapay',
          gatewayTrxId: result.invoiceId,
          amountPaisa:  result.amountPaisa,
        });
        return { processed: true, orderId: result.orderId };
      }, { pool });
    }
    return { processed: false, reason: 'Payment not completed' };
  }

  logger.warn({ event: 'unhandled_webhook', gatewayCode });
  return { processed: false, reason: `No webhook handler for ${gatewayCode}` };
}

module.exports = {
  // bKash
  bkashGrantToken,
  bkashCreatePayment,
  bkashExecutePayment,
  bkashQueryPayment,
  // UddoktaPay
  uddoktaPayCreatePayment,
  uddoktaPayVerifyIpn,
  // ShurjoPay
  shurjopayInitiate,
  shurjopayVerify,
  // Manual banking
  manualBankingSubmit,
  manualBankingVerify,
  // Webhook dispatcher
  handleWebhook,
  // Helpers
  recordTransaction,
  markOrderPaid,
};
