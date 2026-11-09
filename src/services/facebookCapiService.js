'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const settingsRepository = require('../repositories/settingsRepository');
const sqliteDb = require('../db/database');
const { logger } = require('../utils/logger');

const GRAPH_API_VERSION = 'v19.0';
const TIMEOUT_MS = 6000;

function isMysql() {
  return env.db.client === 'mysql';
}

function sha256(val) {
  if (!val) return null;
  return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

function normalizeBdPhoneForCapi(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('01')) {
    return `88${digits}`;
  }
  if (digits.length === 13 && digits.startsWith('8801')) {
    return digits;
  }
  if (digits.length === 10 && digits.startsWith('1')) {
    return `880${digits}`;
  }
  return digits.startsWith('88') ? digits : `88${digits}`;
}

async function getTrackingSettings() {
  try {
    if (isMysql()) {
      return await settingsRepository.getAllSettings();
    }
    return sqliteDb.getSettings();
  } catch (_e) {
    return sqliteDb.getSettings();
  }
}

/**
 * Send server-side event to Meta Conversions API (CAPI)
 */
async function sendCapiEvent({
  eventName = 'Purchase',
  eventId = '',
  eventSourceUrl = 'https://mrtumi.com/checkout',
  phone = '',
  email = '',
  customerName = '',
  clientIp = '',
  userAgent = '',
  fbp = '',
  fbc = '',
  customData = {}
}) {
  try {
    const settings = await getTrackingSettings();
    const pixelId = String(settings.fb_pixel_id || '').trim();
    const accessToken = String(settings.fb_capi_token || '').trim();
    const testCode = String(settings.fb_capi_test_code || '').trim();

    // If CAPI is not configured or disabled, exit quietly
    if (!pixelId || !accessToken || settings.fb_pixel_enabled === '0') {
      return { success: false, skipped: true, reason: 'Meta CAPI not configured or disabled' };
    }

    const userData = {};
    if (phone) {
      const normPhone = normalizeBdPhoneForCapi(phone);
      if (normPhone) userData.ph = [sha256(normPhone)];
    }
    if (email) {
      userData.em = [sha256(email)];
    }
    if (customerName) {
      const parts = String(customerName).trim().split(/\s+/);
      if (parts[0]) userData.fn = [sha256(parts[0])];
      if (parts.length > 1) userData.ln = [sha256(parts.slice(1).join(' '))];
    }
    if (clientIp) {
      userData.client_ip_address = String(clientIp).slice(0, 100);
    }
    if (userAgent) {
      userData.client_user_agent = String(userAgent).slice(0, 500);
    }
    if (fbp) userData.fbp = String(fbp);
    if (fbc) userData.fbc = String(fbc);

    const eventPayload = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || `ev_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      event_source_url: eventSourceUrl,
      action_source: 'website',
      user_data: userData,
      custom_data: customData
    };

    const requestBody = {
      data: [eventPayload]
    };
    if (testCode) {
      requestBody.test_event_code = testCode;
    }

    const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await (globalThis.fetch || require('node-fetch'))(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      const responseText = await res.text();
      let responseJson;
      try {
        responseJson = JSON.parse(responseText);
      } catch (_) {
        responseJson = { raw: responseText };
      }

      if (res.ok && (!responseJson.error || responseJson.events_received > 0)) {
        return { success: true, eventsReceived: responseJson.events_received || 1 };
      }

      logger.warn(`Meta CAPI response warning: HTTP ${res.status} - ${responseText}`);
      return { success: false, error: responseJson.error?.message || responseText };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn('Meta CAPI delivery error: ' + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Trigger CAPI Purchase Event on Order Completion
 */
function sendOrderPurchaseEvent({
  invoiceNo,
  totalAmount,
  currency = 'BDT',
  customerName = '',
  phone = '',
  email = '',
  clientIp = '',
  userAgent = '',
  fbp = '',
  fbc = ''
}) {
  setImmediate(async () => {
    try {
      await sendCapiEvent({
        eventName: 'Purchase',
        eventId: String(invoiceNo || ''),
        eventSourceUrl: 'https://mrtumi.com/order-success/' + encodeURIComponent(invoiceNo || ''),
        phone,
        email,
        customerName,
        clientIp,
        userAgent,
        fbp,
        fbc,
        customData: {
          currency: currency || 'BDT',
          value: Number(totalAmount || 0),
          order_id: String(invoiceNo || '')
        }
      });
    } catch (_err) {
      // Non-blocking catch
    }
  });
}

module.exports = {
  sendCapiEvent,
  sendOrderPurchaseEvent,
  sha256,
  normalizeBdPhoneForCapi
};
