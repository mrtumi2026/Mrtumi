'use strict';

const { env } = require('../config/env');
const settingsRepository = require('../repositories/settingsRepository');
const sqliteDb = require('../db/database');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const { logger } = require('../utils/logger');

const BULKSMS_ENDPOINT = 'https://bulksmsbd.net/api/smsapi';
const BULKSMS_BALANCE_ENDPOINT = 'https://bulksmsbd.net/api/getBalanceApi';
const TIMEOUT_MS = 8000;

function isMysql() {
  return env.db.client === 'mysql';
}

function normalizeBdMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
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

function maskPhone(phone) {
  const str = String(phone || '').trim();
  if (str.length < 8) return str;
  return `${str.slice(0, 4)}***${str.slice(-3)}`;
}

async function getSmsSettings() {
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
 * Log SMS execution to database (supports both MySQL and SQLite)
 */
async function logSms({ recipient, message, gateway = 'BulkSMSBD', status = 'sent', providerMessageId = null, templateKey = 'custom' }) {
  try {
    const preview = String(message || '').slice(0, 255);
    const masked = maskPhone(recipient);
    if (isMysql()) {
      const client = createQueryClient(getPool());
      await client.execute(
        'INSERT INTO `sms_logs` (`recipient_masked`, `template_key`, `message_preview`, `gateway_code`, `provider_message_id`, `delivery_status`) VALUES (?, ?, ?, ?, ?, ?)',
        [masked, templateKey, preview, gateway.toLowerCase(), String(providerMessageId || ''), status]
      );
    } else {
      sqliteDb.run(
        'INSERT INTO sms_logs (recipient, message, gateway, status) VALUES (?, ?, ?, ?)',
        recipient,
        message,
        gateway,
        status
      );
    }
  } catch (err) {
    logger.warn('Failed to log SMS event: ' + err.message);
  }
}

/**
 * Check BulkSMSBD balance and update database
 */
async function checkBalance() {
  const settings = await getSmsSettings();
  const apiKey = String(settings.bulksms_api_key || '').trim();
  if (!apiKey) {
    return { success: false, configured: false, balance: '0.00', message: 'BulkSMSBD API Key is not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `${BULKSMS_BALANCE_ENDPOINT}?api_key=${encodeURIComponent(apiKey)}`;
    const res = await (globalThis.fetch || require('node-fetch'))(url, { signal: controller.signal });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'error'}`);
    const data = await res.json();

    if (data && (data.response_code === 202 || data.response_code === '202' || data.balance !== undefined)) {
      const bal = String(data.balance || '0.00');
      // Save balance to settings
      if (isMysql()) {
        await settingsRepository.setSetting('bulksms_balance', bal);
      } else {
        sqliteDb.setSetting('bulksms_balance', bal);
      }
      return { success: true, configured: true, balance: bal };
    }
    return { success: false, configured: true, balance: settings.bulksms_balance || '0.00', message: data.error_message || 'Invalid API key or balance request failed' };
  } catch (err) {
    return { success: false, configured: true, balance: settings.bulksms_balance || '0.00', message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send SMS via BulkSMSBD API
 */
async function sendSms({ phone, message, templateKey = 'custom' }) {
  const settings = await getSmsSettings();
  const apiKey = String(settings.bulksms_api_key || '').trim();
  const senderId = String(settings.bulksms_sender_id || '').trim();
  const isEnabled = settings.bulksms_enabled !== '0';

  if (!apiKey || !isEnabled) {
    return { success: false, error: 'SMS Gateway is disabled or BulkSMSBD API key is missing in Admin settings.' };
  }

  const rawPhone = String(phone || '').trim();
  if (!rawPhone) {
    return { success: false, error: 'Recipient phone number is required.' };
  }

  const mobile = normalizeBdMobile(rawPhone);
  const text = String(message || '').trim();
  if (!text) {
    return { success: false, error: 'SMS message text cannot be empty.' };
  }

  const bodyParams = new URLSearchParams({
    api_key: apiKey,
    type: 'text',
    number: mobile,
    senderid: senderId || '',
    message: text
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await (globalThis.fetch || require('node-fetch'))(BULKSMS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString(),
      signal: controller.signal
    });

    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'error'}`);
    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); } catch (_) { data = null; }

    const responseCode = Number(data?.response_code ?? data?.code);
    const isSuccess = responseCode === 202 || (!data && /sms submitted successfully|successfully sent/i.test(rawText));

    if (isSuccess) {
      const msgId = data?.message_id || data?.msg_id || null;
      await logSms({ recipient: rawPhone, message: text, status: 'sent', providerMessageId: msgId, templateKey });
      return { success: true, messageId: msgId, raw: rawText };
    }

    const errMsg = data?.error_message || data?.message || rawText || 'Failed to send SMS';
    await logSms({ recipient: rawPhone, message: text, status: 'failed', templateKey });
    return { success: false, error: errMsg };
  } catch (err) {
    logger.warn(`SMS delivery error to ${rawPhone}: ` + err.message);
    await logSms({ recipient: rawPhone, message: text, status: 'failed', templateKey });
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trigger Auto SMS on Order Placement
 * Sends confirmation to Customer and notification to Admin asynchronously
 */
async function sendOrderPlacedSms({ invoiceNo, customerName, phone, totalAmount, deliveryArea = '' }) {
  // Run asynchronously without blocking the checkout HTTP response
  setImmediate(async () => {
    try {
      const settings = await getSmsSettings();
      const apiKey = String(settings.bulksms_api_key || '').trim();
      const isEnabled = settings.bulksms_enabled !== '0';

      if (!apiKey || !isEnabled) {
        return; // SMS not configured or disabled
      }

      const formattedTotal = Number(totalAmount || 0).toLocaleString('en-US');
      const invoice = String(invoiceNo || '');
      const custName = String(customerName || 'গ্রাহক').trim();
      const siteName = String(settings.site_name || 'Mr. Tumi').trim();
      const trackingUrl = `https://mrtumi.com/track-order?invoice=${encodeURIComponent(invoice)}`;

      // 1. Customer Order Confirmation SMS
      const customerSmsEnabled = settings.sms_order_customer_enabled !== '0';
      if (customerSmsEnabled && phone) {
        const defaultCustTemplate = `প্রিয় {customer_name}, {site_name}-এ আপনার অর্ডার #{invoice_no} সফলভাবে গৃহীত হয়েছে। সর্বমোট: ৳{total_amount}। অর্ডার ট্র্যাক করুন: {tracking_url}`;
        const template = String(settings.sms_customer_template || defaultCustTemplate);
        const customerMsg = template
          .replace(/{customer_name}/g, custName)
          .replace(/{invoice_no}/g, invoice)
          .replace(/{total_amount}/g, formattedTotal)
          .replace(/{site_name}/g, siteName)
          .replace(/{tracking_url}/g, trackingUrl);

        await sendSms({
          phone,
          message: customerMsg,
          templateKey: 'order_confirmation'
        });
      }

      // 2. Admin Order Alert SMS
      const adminSmsEnabled = settings.sms_order_admin_enabled !== '0';
      const adminPhone = String(settings.sms_admin_phone || settings.site_phone || '').trim();
      if (adminSmsEnabled && adminPhone) {
        const defaultAdminTemplate = `নতুন অর্ডার! #{invoice_no}, গ্রাহক: {customer_name} ({phone}), মোট: ৳{total_amount}। এরিয়া: {delivery_area} - {site_name}`;
        const template = String(settings.sms_admin_template || defaultAdminTemplate);
        const adminMsg = template
          .replace(/{customer_name}/g, custName)
          .replace(/{phone}/g, phone || '')
          .replace(/{invoice_no}/g, invoice)
          .replace(/{total_amount}/g, formattedTotal)
          .replace(/{delivery_area}/g, deliveryArea || 'Dhaka')
          .replace(/{site_name}/g, siteName);

        await sendSms({
          phone: adminPhone,
          message: adminMsg,
          templateKey: 'admin_order_alert'
        });
      }
    } catch (err) {
      logger.warn('Failed in sendOrderPlacedSms: ' + err.message);
    }
  });
}

module.exports = {
  sendSms,
  checkBalance,
  sendOrderPlacedSms,
  normalizeBdMobile,
  getSmsSettings
};
