'use strict';

/**
 * ShurjoPay Gateway Service
 * =========================
 * Production driver for ShurjoPay v2.0 Merchant API.
 * Provides server-side initiation and authoritative server-to-server verification.
 */

const https = require('https');
const { URL } = require('url');
const { AppError, ValidationError } = require('../../utils/errors');
const { assertSafePaisa } = require('../../utils/money');
const { logger } = require('../../utils/logger');

function getShurjoPayConfig() {
  const isSandbox = String(process.env.SHURJOPAY_IS_SANDBOX || 'true').toLowerCase() === 'true';
  const username = process.env.SHURJOPAY_USERNAME;
  const password = process.env.SHURJOPAY_PASSWORD;
  const prefix = process.env.SHURJOPAY_PREFIX || 'SP';

  if (!username || !password) {
    throw new ValidationError('ShurjoPay credentials missing: SHURJOPAY_USERNAME and SHURJOPAY_PASSWORD must be configured.');
  }

  const baseUrl = isSandbox
    ? 'https://sandbox.shurjopayment.com'
    : 'https://engine.shurjopayment.com';

  return { isSandbox, username, password, prefix, baseUrl };
}

function postRequest(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const bodyStr = JSON.stringify(body);
    const reqHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...headers,
    };

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: reqHeaders,
        timeout: 15_000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );

    req.on('error', (err) => {
      logger.error({ event: 'shurjopay_network_error', error: err.message });
      reject(new AppError('SHURJOPAY_NETWORK_ERROR', `ShurjoPay gateway error: ${err.message}`, 502));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new AppError('SHURJOPAY_TIMEOUT', 'ShurjoPay did not respond within 15 seconds.', 504));
    });

    req.write(bodyStr);
    req.end();
  });
}

/**
 * Obtains ShurjoPay session token.
 */
async function authenticate() {
  const config = getShurjoPayConfig();
  const res = await postRequest(`${config.baseUrl}/api/get_token`, {
    username: config.username,
    password: config.password,
  });

  if (res.status !== 200 || !res.body?.token) {
    logger.error({ event: 'shurjopay_auth_failed', response: res.body });
    throw new AppError(
      'SHURJOPAY_AUTH_FAILED',
      `ShurjoPay token request failed: ${res.body?.message || 'Authentication error'}`,
      502
    );
  }

  return {
    token: res.body.token,
    storeId: res.body.store_id,
    executeUrl: res.body.execute_url,
  };
}

/**
 * Initiates payment session with ShurjoPay.
 */
async function initiatePayment({ orderId, invoiceNo, amountPaisa, customer, returnUrl, cancelUrl, clientIp = '127.0.0.1' }) {
  assertSafePaisa(amountPaisa, 'amountPaisa');
  const config = getShurjoPayConfig();
  const { token, storeId } = await authenticate();

  const amountBdt = (amountPaisa / 100).toFixed(2);
  const orderRef = `${config.prefix}${orderId}_${Date.now().toString().slice(-4)}`;

  const payload = {
    prefix: config.prefix,
    token,
    store_id: storeId,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    amount: amountBdt,
    currency: 'BDT',
    order_id: orderRef,
    discsount_amount: 0,
    disc_percent: 0,
    client_ip: clientIp,
    customer_name: String(customer.name || 'Shopper').slice(0, 100),
    customer_phone: String(customer.phone || '').slice(0, 20),
    customer_email: String(customer.email || `order${orderId}@mrtumi.local`).slice(0, 100),
    customer_address: String(customer.address || 'Dhaka, Bangladesh').slice(0, 255),
    customer_city: String(customer.city || 'Dhaka').slice(0, 100),
    customer_state: 'Bangladesh',
    customer_postcode: '1200',
    customer_country: 'BD',
    value1: String(orderId),
    value2: String(invoiceNo || ''),
  };

  const res = await postRequest(`${config.baseUrl}/api/secret-pay`, payload);

  if (res.status !== 200 || !res.body?.checkout_url) {
    logger.error({ event: 'shurjopay_initiate_failed', payload, response: res.body });
    throw new AppError(
      'SHURJOPAY_INITIATE_FAILED',
      `ShurjoPay initiation failed: ${res.body?.message || 'Declined'}`,
      502
    );
  }

  return {
    checkoutUrl: res.body.checkout_url,
    spOrderId: res.body.sp_order_id,
    orderRef,
  };
}

/**
 * Server-to-server payment verification.
 * Does NOT trust the browser redirect alone. Makes a backend verification call.
 */
async function verifyPayment(spOrderId) {
  if (!spOrderId) throw new ValidationError('spOrderId is required for ShurjoPay verification.');
  const config = getShurjoPayConfig();
  const { token } = await authenticate();

  const res = await postRequest(
    `${config.baseUrl}/api/verification`,
    { order_id: spOrderId },
    { Authorization: `Bearer ${token}` }
  );

  if (res.status !== 200 || !Array.isArray(res.body) || !res.body[0]) {
    logger.error({ event: 'shurjopay_verify_failed', spOrderId, response: res.body });
    throw new AppError('SHURJOPAY_VERIFY_FAILED', 'Failed to retrieve transaction from ShurjoPay.', 502);
  }

  const trxData = res.body[0];
  const isSuccess = trxData.sp_code === '1000' || trxData.sp_message === 'Success';
  const amountBdt = Number(trxData.amount || 0);
  const amountPaisa = Math.round(amountBdt * 100);

  return {
    isSuccess,
    orderId: Number(trxData.value1 || 0),
    invoiceNo: trxData.value2 || '',
    spOrderId: trxData.sp_order_id || spOrderId,
    bankTrxId: trxData.bank_trx_id || trxData.sp_order_id,
    method: trxData.method || 'shurjopay',
    amountPaisa,
    currency: trxData.currency || 'BDT',
    spMessage: trxData.sp_message,
    raw: trxData,
  };
}

module.exports = {
  authenticate,
  initiatePayment,
  verifyPayment,
  getShurjoPayConfig,
};
