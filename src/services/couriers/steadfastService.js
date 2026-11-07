'use strict';

/**
 * Steadfast Courier Driver
 * ========================
 * Production driver for Steadfast Courier (Packzy API v1).
 * Supports automatic consignment creation, parcel tracking, and live balance monitoring.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { AppError, ValidationError } = require('../../utils/errors');
const { assertSafePaisa } = require('../../utils/money');
const { logger } = require('../../utils/logger');

function getSteadfastConfig() {
  const apiKey = process.env.STEADFAST_API_KEY;
  const secretKey = process.env.STEADFAST_SECRET_KEY;
  const baseUrl = (process.env.STEADFAST_BASE_URL || 'https://portal.packzy.com/api/v1').replace(/\/$/, '');

  if (!apiKey || !secretKey) {
    throw new ValidationError('Steadfast Courier credentials missing: Set STEADFAST_API_KEY and STEADFAST_SECRET_KEY in environment.');
  }

  return { apiKey, secretKey, baseUrl };
}

function request(urlStr, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const config = getSteadfastConfig();
    const isHttps = parsed.protocol === 'https:';
    const proto = isHttps ? https : http;

    const headers = {
      'Api-Key': config.apiKey,
      'Secret-Key': config.secretKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = proto.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method,
        headers,
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
      logger.error({ event: 'steadfast_network_error', error: err.message });
      reject(new AppError('STEADFAST_NETWORK_ERROR', `Steadfast connection error: ${err.message}`, 502));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new AppError('STEADFAST_TIMEOUT', 'Steadfast API did not respond within 15 seconds.', 504));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Creates parcel delivery order in Steadfast system.
 *
 * @param {object} params
 * @param {string} params.invoice
 * @param {string} params.recipientName
 * @param {string} params.recipientPhone
 * @param {string} params.recipientAddress
 * @param {number} params.codAmountPaisa
 * @param {string} [params.note]
 */
async function createOrder({ invoice, recipientName, recipientPhone, recipientAddress, codAmountPaisa, note = '' }) {
  assertSafePaisa(codAmountPaisa, 'codAmountPaisa');
  const config = getSteadfastConfig();

  const codBdt = Math.round(codAmountPaisa / 100);

  const payload = {
    invoice: String(invoice).trim(),
    recipient_name: String(recipientName || 'Customer').trim().slice(0, 100),
    recipient_phone: String(recipientPhone).trim().replace(/[^0-9]/g, ''),
    recipient_address: String(recipientAddress || 'Dhaka, Bangladesh').trim().slice(0, 500),
    cod_amount: codBdt,
    note: String(note || '').slice(0, 200),
  };

  const res = await request(`${config.baseUrl}/create_order`, 'POST', payload);

  if (res.status !== 200 || res.body?.status !== 200 || !res.body?.consignment?.consignment_id) {
    logger.error({ event: 'steadfast_create_order_failed', payload, response: res.body });
    throw new AppError(
      'STEADFAST_CREATE_FAILED',
      res.body?.message || 'Failed to create Steadfast shipment booking.',
      502
    );
  }

  const c = res.body.consignment;

  return {
    consignmentId: String(c.consignment_id),
    trackingCode: c.tracking_code || String(c.consignment_id),
    invoice: c.invoice,
    codAmountPaisa: Math.round(Number(c.cod_amount || codBdt) * 100),
    status: c.status || 'in_review',
    raw: res.body,
  };
}

/**
 * Checks parcel status by Steadfast Consignment ID.
 */
async function getStatusByCid(consignmentId) {
  if (!consignmentId) throw new ValidationError('consignmentId is required.');
  const config = getSteadfastConfig();
  const res = await request(`${config.baseUrl}/status_by_cid/${encodeURIComponent(consignmentId)}`, 'GET');

  if (res.status !== 200 || res.body?.status !== 200) {
    throw new AppError('STEADFAST_STATUS_FAILED', 'Could not fetch status from Steadfast.', 502);
  }

  return {
    status: res.body.delivery_status || 'unknown',
    raw: res.body,
  };
}

/**
 * Checks current Steadfast merchant account balance.
 */
async function getBalance() {
  const config = getSteadfastConfig();
  const res = await request(`${config.baseUrl}/get_balance`, 'GET');

  if (res.status !== 200 || res.body?.status !== 200) {
    throw new AppError('STEADFAST_BALANCE_FAILED', 'Could not retrieve Steadfast balance.', 502);
  }

  const balanceBdt = Number(res.body.current_balance || 0);
  return {
    balanceBdt,
    balancePaisa: Math.round(balanceBdt * 100),
  };
}

module.exports = {
  createOrder,
  getStatusByCid,
  getBalance,
  getSteadfastConfig,
};
