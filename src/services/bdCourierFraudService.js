'use strict';

const { env } = require('../config/env');
const settingsRepository = require('../repositories/settingsRepository');
const sqliteDb = require('../db/database');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const { logger } = require('../utils/logger');

const BDCOURIER_CHECK_ENDPOINT = 'https://bdcourier.com/api/courier-check';
const TIMEOUT_MS = 8000;

function isMysql() {
  return env.db.client === 'mysql';
}

function cleanPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('01')) return digits;
  if (digits.length === 13 && digits.startsWith('8801')) return digits.slice(2);
  return digits;
}

async function getSettings() {
  try {
    if (isMysql()) return await settingsRepository.getAllSettings();
    return sqliteDb.getSettings();
  } catch (_) {
    return sqliteDb.getSettings();
  }
}

/**
 * Fetch internal store orders and blocked status for a phone
 */
async function getInternalPhoneData(phone) {
  const normalized = cleanPhone(phone);
  let storeOrders = [];
  let isBlocked = false;

  try {
    if (isMysql()) {
      const client = createQueryClient(getPool());
      const rows = await client.queryAll(
        'SELECT `id`, `invoice_no` AS `invoice_id`, `customer_name`, `total_paisa`, `order_status` AS `status`, `created_at` FROM `orders` WHERE `customer_phone` = ? OR `customer_phone` = ? ORDER BY `id` DESC LIMIT 15',
        [normalized, `88${normalized}`]
      );
      storeOrders = rows.map(r => ({
        id: r.id,
        invoice_id: r.invoice_id,
        customer_name: r.customer_name,
        amount: (Number(r.total_paisa || 0) / 100).toFixed(0),
        status: r.status,
        created_at: r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : '—'
      }));

      // Check blocked status
      const blockRow = await client.queryOne(
        'SELECT `id` FROM `ip_blocks` WHERE `ip_or_phone` = ? LIMIT 1',
        [normalized]
      );
      isBlocked = Boolean(blockRow);
    } else {
      const rows = sqliteDb.all(
        'SELECT id, invoice_id, customer_name, amount, status, created_at FROM orders WHERE phone = ? ORDER BY id DESC LIMIT 15',
        normalized
      );
      storeOrders = (rows || []).map(r => ({
        id: r.id,
        invoice_id: r.invoice_id,
        customer_name: r.customer_name,
        amount: r.amount || '0',
        status: r.status,
        created_at: r.created_at || '—'
      }));

      const blockRow = sqliteDb.get(
        'SELECT id FROM ip_blocks WHERE ip_or_phone = ?',
        normalized
      );
      isBlocked = Boolean(blockRow);
    }
  } catch (err) {
    logger.warn('Failed to fetch internal phone data: ' + err.message);
  }

  return { storeOrders, isBlocked };
}

/**
 * Check Phone Fraud via BD Courier API and internal order history
 */
async function checkPhoneFraud(rawPhone) {
  const phone = cleanPhone(rawPhone);
  if (!phone || phone.length < 10) {
    return {
      phone: rawPhone,
      available: false,
      message: 'অনুগ্রহ করে সঠিক ১১ ডিজিটের মোবাইল নম্বর প্রদান করুন।'
    };
  }

  const settings = await getSettings();
  const apiKey = String(settings.bdcourier_api_key || '').trim();
  const isEnabled = settings.bdcourier_enabled !== '0';
  const { storeOrders, isBlocked } = await getInternalPhoneData(phone);

  // If BD Courier API key is not configured, give informative response with internal store stats
  if (!apiKey || !isEnabled) {
    const totalInternal = storeOrders.length;
    const completedInternal = storeOrders.filter(o => ['completed', 'delivered'].includes(String(o.status).toLowerCase())).length;
    const returnedInternal = storeOrders.filter(o => ['cancelled', 'returned'].includes(String(o.status).toLowerCase())).length;
    const internalSuccessRate = totalInternal > 0 ? Math.round((completedInternal / totalInternal) * 100) : 100;

    return {
      phone,
      available: true,
      successRate: internalSuccessRate,
      riskLevel: internalSuccessRate >= 80 ? 'Low Risk (Store Data)' : (internalSuccessRate >= 50 ? 'Moderate Risk (Store Data)' : 'High Risk (Store Data)'),
      totalParcels: totalInternal,
      totalDelivered: completedInternal,
      totalReturned: returnedInternal,
      couriers: [
        { name: 'Internal Store', total: totalInternal, delivered: completedInternal, returned: returnedInternal },
        { name: 'Steadfast (External)', total: 0, delivered: 0, returned: 0 },
        { name: 'Pathao (External)', total: 0, delivered: 0, returned: 0 },
        { name: 'RedX (External)', total: 0, delivered: 0, returned: 0 }
      ],
      storeOrders,
      isBlocked,
      isLiveApi: false,
      provider: 'internal_store',
      notice: 'External BD Courier API Key is not configured in Admin Settings. Showing internal store order metrics.'
    };
  }

  // Live Query BD Courier API
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await (globalThis.fetch || require('node-fetch'))(BDCOURIER_CHECK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ phone, api_key: apiKey }),
      signal: controller.signal
    });

    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'error'}`);
    const data = await res.json();
    const payload = data?.data || data;

    const totalParcels = Number(payload?.total_parcel ?? payload?.total ?? 0);
    const totalDelivered = Number(payload?.success_parcel ?? payload?.delivered ?? 0);
    const totalReturned = Number(payload?.cancelled_parcel ?? payload?.returned ?? payload?.cancelled ?? 0);
    const successRate = totalParcels > 0
      ? Number(payload?.success_ratio ?? Math.round((totalDelivered / totalParcels) * 100))
      : 100;

    let riskLevel = 'Low Risk (বিশ্বস্ত কাস্টমার)';
    if (totalParcels > 0) {
      if (successRate < 50) riskLevel = 'Critical Risk (উচ্চ ঝুঁকি - ডেলিভারি ফেরত সম্ভাবনা)';
      else if (successRate < 70) riskLevel = 'High Risk (ঝুঁকিপূর্ণ কাস্টমার)';
      else if (successRate < 85) riskLevel = 'Moderate Risk (সাধারণ কাস্টমার)';
    }

    const courierMap = payload?.courier_data || {};
    const couriers = [
      {
        name: 'Steadfast Courier',
        total: Number(courierMap.steadfast?.total_parcel || 0),
        delivered: Number(courierMap.steadfast?.success_parcel || 0),
        returned: Number(courierMap.steadfast?.cancelled_parcel || 0)
      },
      {
        name: 'Pathao Courier',
        total: Number(courierMap.pathao?.total_parcel || 0),
        delivered: Number(courierMap.pathao?.success_parcel || 0),
        returned: Number(courierMap.pathao?.cancelled_parcel || 0)
      },
      {
        name: 'RedX Courier',
        total: Number(courierMap.redx?.total_parcel || 0),
        delivered: Number(courierMap.redx?.success_parcel || 0),
        returned: Number(courierMap.redx?.cancelled_parcel || 0)
      },
      {
        name: 'Paperfly Courier',
        total: Number(courierMap.paperfly?.total_parcel || 0),
        delivered: Number(courierMap.paperfly?.success_parcel || 0),
        returned: Number(courierMap.paperfly?.cancelled_parcel || 0)
      }
    ];

    return {
      phone,
      available: true,
      successRate,
      riskLevel,
      totalParcels,
      totalDelivered,
      totalReturned,
      couriers,
      storeOrders,
      isBlocked,
      isLiveApi: true,
      provider: 'bdcourier_live'
    };
  } catch (err) {
    logger.warn(`BD Courier query error for ${phone}: ` + err.message);
    // Graceful fallback to internal data
    const totalInternal = storeOrders.length;
    const completedInternal = storeOrders.filter(o => ['completed', 'delivered'].includes(String(o.status).toLowerCase())).length;
    const returnedInternal = storeOrders.filter(o => ['cancelled', 'returned'].includes(String(o.status).toLowerCase())).length;
    const internalSuccessRate = totalInternal > 0 ? Math.round((completedInternal / totalInternal) * 100) : 100;

    return {
      phone,
      available: true,
      successRate: internalSuccessRate,
      riskLevel: internalSuccessRate >= 80 ? 'Low Risk (Store Backup)' : 'Moderate Risk (Store Backup)',
      totalParcels: totalInternal,
      totalDelivered: completedInternal,
      totalReturned: returnedInternal,
      couriers: [
        { name: 'Internal Store', total: totalInternal, delivered: completedInternal, returned: returnedInternal },
        { name: 'Steadfast', total: 0, delivered: 0, returned: 0 },
        { name: 'Pathao', total: 0, delivered: 0, returned: 0 },
        { name: 'RedX', total: 0, delivered: 0, returned: 0 }
      ],
      storeOrders,
      isBlocked,
      isLiveApi: false,
      provider: 'internal_store',
      notice: 'External BD Courier API timed out. Displaying local store order history.'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkPlan() {
  const settings = await getSettings();
  const apiKey = String(settings.bdcourier_api_key || '').trim();
  if (!apiKey) {
    return { success: false, configured: false, status: 'unconfigured', message: 'BD Courier API key not yet configured' };
  }
  return {
    success: true,
    configured: true,
    status: 'active',
    data: {
      plan_name: settings.bdcourier_plan || 'Active Plan',
      calls_remaining: settings.bdcourier_calls || 'Unlimited',
      due_date: settings.bdcourier_due_date || 'Active'
    }
  };
}

module.exports = {
  checkPhoneFraud,
  checkPlan,
  cleanPhone
};
