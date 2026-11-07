'use strict';

/**
 * UddoktaPay Gateway Service
 * ==========================
 * Production driver for UddoktaPay Checkout v2.
 * Handles checkout session generation and server-to-server IPN / invoice verification.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { AppError, ValidationError } = require('../../utils/errors');
const { assertSafePaisa } = require('../../utils/money');
const { logger } = require('../../utils/logger');

function getUddoktaConfig() {
  const apiKey = process.env.UDDOKTAPAY_API_KEY;
  const baseUrl = (process.env.UDDOKTAPAY_BASE_URL || 'https://sandbox.uddoktapay.com').replace(/\/$/, '');

  if (!apiKey) {
    throw new ValidationError('UddoktaPay credentials missing: UDDOKTAPAY_API_KEY is not defined in .env.');
  }

  return { apiKey, baseUrl };
}

function postRequest(urlStr, body, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const bodyStr = JSON.stringify(body);
    const isHttps = parsed.protocol === 'https:';
    const proto = isHttps ? https : http;

    const req = proto.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'RT-UDDOKTAPAY-API-KEY': apiKey,
          'Content-Length': Buffer.byteLength(bodyStr),
        },
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
      logger.error({ event: 'uddoktapay_network_error', error: err.message });
      reject(new AppError('UDDOKTAPAY_NETWORK_ERROR', `UddoktaPay gateway error: ${err.message}`, 502));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new AppError('UDDOKTAPAY_TIMEOUT', 'UddoktaPay did not respond within 15 seconds.', 504));
    });

    req.write(bodyStr);
    req.end();
  });
}

/**
 * Creates checkout session.
 */
async function createPayment({ orderId, invoiceNo, amountPaisa, customer, redirectUrl, cancelUrl, webhookUrl }) {
  assertSafePaisa(amountPaisa, 'amountPaisa');
  const config = getUddoktaConfig();
  const amountBdt = (amountPaisa / 100).toFixed(2);

  const payload = {
    full_name: String(customer.name || 'Shopper').slice(0, 100),
    email: String(customer.email || `order${orderId}@mrtumi.local`).slice(0, 100),
    amount: amountBdt,
    metadata: {
      order_id: String(orderId),
      invoice_no: String(invoiceNo || ''),
    },
    redirect_url: redirectUrl,
    cancel_url: cancelUrl,
    webhook_url: webhookUrl,
  };

  const res = await postRequest(`${config.baseUrl}/api/checkout-v2`, payload, config.apiKey);

  if (res.status !== 200 || !res.body?.payment_url) {
    logger.error({ event: 'uddoktapay_create_failed', payload, response: res.body });
    throw new AppError(
      'UDDOKTAPAY_CREATE_FAILED',
      `UddoktaPay session generation failed: ${res.body?.message || 'Invalid API key or payload'}`,
      502
    );
  }

  return {
    paymentUrl: res.body.payment_url,
    invoiceId: res.body.invoice_id || '',
    raw: res.body,
  };
}

/**
 * Verifies payment status directly from UddoktaPay using invoice_id.
 */
async function verifyPayment(invoiceId) {
  if (!invoiceId) throw new ValidationError('invoiceId is required for UddoktaPay verification.');
  const config = getUddoktaConfig();

  const res = await postRequest(
    `${config.baseUrl}/api/verify-payment`,
    { invoice_id: String(invoiceId) },
    config.apiKey
  );

  if (res.status !== 200 || !res.body?.status) {
    logger.error({ event: 'uddoktapay_verify_failed', invoiceId, response: res.body });
    throw new AppError('UDDOKTAPAY_VERIFY_FAILED', 'Failed to verify payment with UddoktaPay.', 502);
  }

  const data = res.body;
  const isCompleted = String(data.status).toUpperCase() === 'COMPLETED';
  const amountBdt = Number(data.amount || 0);
  const amountPaisa = Math.round(amountBdt * 100);

  return {
    isSuccess: isCompleted,
    status: data.status,
    orderId: Number(data.metadata?.order_id || 0),
    invoiceId: data.invoice_id || invoiceId,
    transactionId: data.transaction_id || data.invoice_id,
    paymentMethod: data.payment_method || 'uddoktapay',
    amountPaisa,
    senderNumber: data.sender_number || '',
    raw: data,
  };
}

module.exports = {
  createPayment,
  verifyPayment,
  getUddoktaConfig,
};
