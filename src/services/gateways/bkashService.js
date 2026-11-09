'use strict';

/**
 * bKash Tokenized Checkout Service
 * =================================
 * Production-ready driver for bKash Tokenized API v1.2.0-beta.
 *
 * Implements:
 *  - Automatic token granting and refresh with thread-safe cached TTL
 *  - Create Payment (`createPayment`)
 *  - Execute Payment (`executePayment`)
 *  - Query Payment Status (`queryPayment`)
 *  - Search Transaction (`searchTransaction`)
 *  - Refund Payment (`refundPayment`)
 *
 * Credentials strictly loaded from process.env.
 */

const https = require('https');
const { URL } = require('url');
const { AppError, ValidationError } = require('../../utils/errors');
const { assertSafePaisa } = require('../../utils/money');
const { logger } = require('../../utils/logger');

// In-memory token cache with expiration timestamp
let cachedToken = {
  idToken: null,
  refreshToken: null,
  expiresAt: 0,
};

function getBkashConfig() {
  const isSandbox = String(process.env.BKASH_IS_SANDBOX || 'true').toLowerCase() === 'true';
  const appKey = process.env.BKASH_APP_KEY;
  const appSecret = process.env.BKASH_APP_SECRET;
  const username = process.env.BKASH_USERNAME;
  const password = process.env.BKASH_PASSWORD;

  if (!appKey || !appSecret || !username || !password) {
    throw new ValidationError('bKash credentials missing: Ensure BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME, and BKASH_PASSWORD are set in .env.');
  }

  const baseUrl = isSandbox
    ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta'
    : 'https://tokenized.pay.bka.sh/v1.2.0-beta';

  return { isSandbox, appKey, appSecret, username, password, baseUrl };
}

function request(urlStr, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    };
    if (bodyStr) {
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: reqHeaders,
      timeout: 15_000,
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsedRes = JSON.parse(raw);
          resolve({ status: res.statusCode, body: parsedRes });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });

    req.on('error', (err) => {
      logger.error({ event: 'bkash_network_error', error: err.message, url: urlStr });
      reject(new AppError('BKASH_NETWORK_ERROR', `bKash communication error: ${err.message}`, 502));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new AppError('BKASH_TIMEOUT', 'bKash gateway did not respond within 15 seconds.', 504));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Obtains or refreshes the bKash idToken, ensuring validity.
 */
async function getValidToken() {
  const config = getBkashConfig();
  const now = Date.now();

  // If token is valid for at least another 2 minutes, return cached
  if (cachedToken.idToken && cachedToken.expiresAt > now + 120_000) {
    return cachedToken.idToken;
  }

  // Refresh if we have a refresh token and haven't fully expired
  if (cachedToken.refreshToken && cachedToken.expiresAt > now - 300_000) {
    try {
      const refreshRes = await request(
        `${config.baseUrl}/tokenized/checkout/token/refresh`,
        'POST',
        {
          username: config.username,
          password: config.password,
        },
        {
          app_key: config.appKey,
          app_secret: config.appSecret,
          refresh_token: cachedToken.refreshToken,
        }
      );

      if (refreshRes.status === 200 && refreshRes.body?.id_token) {
        cachedToken = {
          idToken: refreshRes.body.id_token,
          refreshToken: refreshRes.body.refresh_token || cachedToken.refreshToken,
          expiresAt: now + (Number(refreshRes.body.expires_in || 3600) * 1000),
        };
        return cachedToken.idToken;
      }
    } catch (err) {
      logger.warn({ event: 'bkash_refresh_failed_fallback_grant', error: err.message });
    }
  }

  // Otherwise, issue full Grant Token request
  const grantRes = await request(
    `${config.baseUrl}/tokenized/checkout/token/grant`,
    'POST',
    {
      username: config.username,
      password: config.password,
    },
    {
      app_key: config.appKey,
      app_secret: config.appSecret,
    }
  );

  if (grantRes.status !== 200 || !grantRes.body?.id_token) {
    logger.error({ event: 'bkash_grant_failed', response: grantRes.body });
    throw new AppError(
      'BKASH_AUTH_ERROR',
      `bKash grant token failed: ${grantRes.body?.statusMessage || 'Invalid credentials'}`,
      502
    );
  }

  cachedToken = {
    idToken: grantRes.body.id_token,
    refreshToken: grantRes.body.refresh_token,
    expiresAt: now + (Number(grantRes.body.expires_in || 3600) * 1000),
  };

  return cachedToken.idToken;
}

/**
 * 1. Create Payment Session
 *
 * @param {object} params
 * @param {string|number} params.orderId
 * @param {string} params.invoiceNo
 * @param {number} params.amountPaisa
 * @param {string} params.callbackUrl
 * @returns {Promise<{ paymentID: string, bkashURL: string, statusMessage: string }>}
 */
async function createPayment({ orderId, invoiceNo, amountPaisa, callbackUrl }) {
  assertSafePaisa(amountPaisa, 'amountPaisa');
  const config = getBkashConfig();
  const token = await getValidToken();

  const amountBdt = (amountPaisa / 100).toFixed(2);

  const payload = {
    mode: '0011',
    payerReference: String(orderId),
    callbackURL: callbackUrl,
    amount: amountBdt,
    currency: 'BDT',
    intent: 'sale',
    merchantInvoiceNumber: String(invoiceNo || `ORD-${orderId}`),
  };

  const res = await request(
    `${config.baseUrl}/tokenized/checkout/create`,
    'POST',
    {
      Authorization: token,
      'X-APP-Key': config.appKey,
    },
    payload
  );

  if (res.status !== 200 || !res.body?.paymentID) {
    logger.error({ event: 'bkash_create_payment_failed', payload, response: res.body });
    throw new AppError(
      'BKASH_CREATE_FAILED',
      `bKash create payment failed: ${res.body?.statusMessage || 'Invalid response'}`,
      502
    );
  }

  return {
    paymentID: res.body.paymentID,
    bkashURL: res.body.bkashURL,
    statusMessage: res.body.statusMessage,
    raw: res.body,
  };
}

/**
 * 2. Execute Payment Session
 *
 * @param {string} paymentID
 * @returns {Promise<{ trxID: string, paymentID: string, amountPaisa: number, customerMsisdn: string, raw: object }>}
 */
async function executePayment(paymentID) {
  if (!paymentID) throw new ValidationError('paymentID is required to execute bKash payment.');
  const config = getBkashConfig();
  const token = await getValidToken();

  const res = await request(
    `${config.baseUrl}/tokenized/checkout/execute`,
    'POST',
    {
      Authorization: token,
      'X-APP-Key': config.appKey,
    },
    { paymentID }
  );

  const isSuccess = res.status === 200 && res.body?.statusCode === '0000';
  if (!isSuccess) {
    logger.error({ event: 'bkash_execute_failed', paymentID, response: res.body });
    throw new AppError(
      'BKASH_EXECUTE_FAILED',
      res.body?.statusMessage || 'Payment could not be completed with bKash.',
      400
    );
  }

  const amountBdt = Number(res.body.amount || 0);
  const amountPaisa = Math.round(amountBdt * 100);

  return {
    trxID: res.body.trxID,
    paymentID: res.body.paymentID,
    amountPaisa,
    customerMsisdn: res.body.customerMsisdn || '',
    paymentExecuteTime: res.body.paymentExecuteTime || new Date().toISOString(),
    raw: res.body,
  };
}

/**
 * 3. Query Payment Status
 *
 * @param {string} paymentID
 */
async function queryPayment(paymentID) {
  if (!paymentID) throw new ValidationError('paymentID is required.');
  const config = getBkashConfig();
  const token = await getValidToken();

  const res = await request(
    `${config.baseUrl}/tokenized/checkout/payment/status`,
    'POST',
    {
      Authorization: token,
      'X-APP-Key': config.appKey,
    },
    { paymentID }
  );

  return res.body;
}

/**
 * 4. Search Transaction by TrxID
 *
 * @param {string} trxID
 */
async function searchTransaction(trxID) {
  if (!trxID) throw new ValidationError('trxID is required.');
  const config = getBkashConfig();
  const token = await getValidToken();

  const res = await request(
    `${config.baseUrl}/tokenized/checkout/general/searchTran?trxID=${encodeURIComponent(trxID)}`,
    'GET',
    {
      Authorization: token,
      'X-APP-Key': config.appKey,
    }
  );

  return res.body;
}

/**
 * 5. Refund Transaction
 *
 * @param {object} params
 * @param {string} params.paymentID
 * @param {string} params.trxID
 * @param {number} params.amountPaisa
 * @param {string} [params.reason]
 * @param {string} [params.sku]
 */
async function refundPayment({ paymentID, trxID, amountPaisa, reason = 'Customer refund', sku = 'general' }) {
  assertSafePaisa(amountPaisa, 'amountPaisa');
  const config = getBkashConfig();
  const token = await getValidToken();

  const amountBdt = (amountPaisa / 100).toFixed(2);

  const payload = {
    paymentID,
    trxID,
    amount: amountBdt,
    reason: String(reason).slice(0, 255),
    sku: String(sku).slice(0, 50),
  };

  const res = await request(
    `${config.baseUrl}/tokenized/checkout/payment/refund`,
    'POST',
    {
      Authorization: token,
      'X-APP-Key': config.appKey,
    },
    payload
  );

  if (res.status !== 200 || res.body?.statusCode !== '0000') {
    logger.error({ event: 'bkash_refund_failed', payload, response: res.body });
    throw new AppError(
      'BKASH_REFUND_FAILED',
      `bKash refund failed: ${res.body?.statusMessage || 'Declined'}`,
      502
    );
  }

  return {
    refundTrxID: res.body.refundTrxID,
    originalTrxID: res.body.trxID,
    amountPaisa,
    raw: res.body,
  };
}

module.exports = {
  createPayment,
  executePayment,
  queryPayment,
  searchTransaction,
  refundPayment,
  getBkashConfig,
};
