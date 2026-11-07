'use strict';

/**
 * Pathao Courier Driver
 * =====================
 * Production driver for Pathao Courier Aladdin API v1.
 * Supports OAuth2 token lifecycle management with automatic caching,
 * consignment creation, price estimation, and city/zone resolution.
 */

const https = require('https');
const { URL } = require('url');
const { AppError, ValidationError } = require('../../utils/errors');
const { assertSafePaisa } = require('../../utils/money');
const { logger } = require('../../utils/logger');

let cachedAuth = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
};

function getPathaoConfig() {
  const clientId = process.env.PATHAO_CLIENT_ID;
  const clientSecret = process.env.PATHAO_CLIENT_SECRET;
  const username = process.env.PATHAO_USERNAME;
  const password = process.env.PATHAO_PASSWORD;
  const storeId = Number(process.env.PATHAO_STORE_ID || 1);
  const baseUrl = (process.env.PATHAO_BASE_URL || 'https://courier-api-hermes.pathao.com').replace(/\/$/, '');

  if (!clientId || !clientSecret || !username || !password) {
    throw new ValidationError('Pathao credentials missing: Set PATHAO_CLIENT_ID, PATHAO_CLIENT_SECRET, PATHAO_USERNAME, and PATHAO_PASSWORD in environment.');
  }

  return { clientId, clientSecret, username, password, storeId, baseUrl };
}

function request(urlStr, method = 'GET', headers = {}, body = null) {
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

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + (parsed.search || ''),
        method,
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
      logger.error({ event: 'pathao_network_error', error: err.message });
      reject(new AppError('PATHAO_NETWORK_ERROR', `Pathao gateway error: ${err.message}`, 502));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new AppError('PATHAO_TIMEOUT', 'Pathao API did not respond within 15 seconds.', 504));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Obtains valid OAuth access token, with automatic caching and refresh.
 */
async function getValidToken() {
  const config = getPathaoConfig();
  const now = Date.now();

  if (cachedAuth.accessToken && cachedAuth.expiresAt > now + 120_000) {
    return cachedAuth.accessToken;
  }

  const payload = {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
    grant_type: 'password',
  };

  const res = await request(`${config.baseUrl}/aladdin/api/v1/issue-token`, 'POST', {}, payload);

  if (res.status !== 200 || !res.body?.access_token) {
    logger.error({ event: 'pathao_auth_failed', response: res.body });
    throw new AppError(
      'PATHAO_AUTH_FAILED',
      `Pathao OAuth failed: ${res.body?.message || 'Invalid credentials'}`,
      502
    );
  }

  cachedAuth = {
    accessToken: res.body.access_token,
    refreshToken: res.body.refresh_token,
    expiresAt: now + (Number(res.body.expires_in || 604800) * 1000),
  };

  return cachedAuth.accessToken;
}

/**
 * Creates parcel delivery order in Pathao Hermes system.
 */
async function createOrder({
  merchantOrderId,
  recipientName,
  recipientPhone,
  recipientAddress,
  recipientCityId = 1, // Default Dhaka
  recipientZoneId = 1,
  recipientAreaId = null,
  amountToCollectPaisa = 0,
  itemQuantity = 1,
  itemWeightKg = 0.5,
  itemDescription = 'Store Goods',
  specialInstruction = '',
}) {
  assertSafePaisa(amountToCollectPaisa, 'amountToCollectPaisa');
  const config = getPathaoConfig();
  const token = await getValidToken();

  const amountBdt = Math.round(amountToCollectPaisa / 100);

  const payload = {
    store_id: config.storeId,
    merchant_order_id: String(merchantOrderId),
    recipient_name: String(recipientName || 'Customer').slice(0, 100),
    recipient_phone: String(recipientPhone).replace(/[^0-9]/g, ''),
    recipient_address: String(recipientAddress || 'Dhaka, Bangladesh').slice(0, 500),
    recipient_city: Number(recipientCityId || 1),
    recipient_zone: Number(recipientZoneId || 1),
    delivery_type: 48, // Standard 48h
    item_type: 1, // Parcel
    special_instruction: String(specialInstruction || '').slice(0, 200),
    item_quantity: Math.max(1, Number(itemQuantity || 1)),
    item_weight: Number(itemWeightKg || 0.5),
    amount_to_collect: amountBdt,
    item_description: String(itemDescription || 'Order items').slice(0, 150),
  };

  if (recipientAreaId) {
    payload.recipient_area = Number(recipientAreaId);
  }

  const res = await request(
    `${config.baseUrl}/aladdin/api/v1/orders`,
    'POST',
    { Authorization: `Bearer ${token}` },
    payload
  );

  if (res.status !== 200 || !res.body?.data?.consignment_id) {
    logger.error({ event: 'pathao_create_order_failed', payload, response: res.body });
    throw new AppError(
      'PATHAO_CREATE_FAILED',
      res.body?.message || JSON.stringify(res.body?.errors || 'Pathao delivery booking failed.'),
      502
    );
  }

  const data = res.body.data;

  return {
    consignmentId: String(data.consignment_id),
    trackingCode: String(data.consignment_id),
    merchantOrderId: data.merchant_order_id,
    orderStatus: data.order_status || 'Pending',
    deliveryFeePaisa: Math.round(Number(data.delivery_fee || 0) * 100),
    amountToCollectPaisa: Math.round(Number(data.amount_to_collect || amountBdt) * 100),
    raw: res.body,
  };
}

/**
 * Fetches available Pathao cities list.
 */
async function getCities() {
  const config = getPathaoConfig();
  const token = await getValidToken();

  const res = await request(
    `${config.baseUrl}/aladdin/api/v1/countries/1/city-list`,
    'GET',
    { Authorization: `Bearer ${token}` }
  );

  return res.body?.data?.data || [];
}

module.exports = {
  createOrder,
  getCities,
  getValidToken,
  getPathaoConfig,
};
