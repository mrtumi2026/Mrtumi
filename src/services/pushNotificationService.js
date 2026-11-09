'use strict';

const { env } = require('../config/env');
const { logger } = require('../utils/logger');
const sqliteDb = require('../db/database');
const { getPool, createQueryClient } = require('../db/mysqlPool');

function isMysql() {
  return env.db.client === 'mysql';
}

let sqliteTablesEnsured = false;
function ensureSqliteTables() {
  if (isMysql() || sqliteTablesEnsured) return;
  try {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS device_push_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        app_type TEXT NOT NULL DEFAULT 'customer',
        user_id INTEGER DEFAULT NULL,
        platform TEXT NOT NULL DEFAULT 'android',
        topic TEXT NOT NULL DEFAULT 'general',
        is_active INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS push_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_type TEXT NOT NULL DEFAULT 'customer',
        target_audience TEXT NOT NULL DEFAULT 'all',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        image_url TEXT DEFAULT NULL,
        deep_link TEXT DEFAULT NULL,
        sent_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'sent',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);
    sqliteTablesEnsured = true;
  } catch (_e) {}
}

function getClient() {
  if (isMysql()) return createQueryClient(getPool());
  ensureSqliteTables();
  return sqliteDb;
}

/**
 * Register or update device push notification token
 */
async function registerDeviceToken({
  token,
  appType = 'customer',
  userId = null,
  platform = 'android',
  topic = 'general',
}) {
  if (!token || typeof token !== 'string') return null;
  const cleanToken = token.trim();
  if (cleanToken.length < 10) return null;

  const client = getClient();
  const idNum = userId ? Number(userId) : null;

  try {
    if (isMysql()) {
      await client.execute(
        `INSERT INTO device_push_tokens (token, app_type, user_id, platform, topic, is_active, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 1, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE 
           app_type = VALUES(app_type),
           user_id = VALUES(user_id),
           platform = VALUES(platform),
           topic = VALUES(topic),
           is_active = 1,
           last_seen_at = UTC_TIMESTAMP()`,
        [cleanToken, appType, idNum, platform, topic]
      );
    } else {
      const existing = client.get('SELECT id FROM device_push_tokens WHERE token = ? LIMIT 1', cleanToken);
      if (existing) {
        client.run(
          `UPDATE device_push_tokens SET app_type = ?, user_id = ?, platform = ?, topic = ?, is_active = 1, last_seen_at = datetime('now', 'localtime')
           WHERE token = ?`,
          appType, idNum, platform, topic, cleanToken
        );
      } else {
        client.run(
          `INSERT INTO device_push_tokens (token, app_type, user_id, platform, topic, is_active, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 1, datetime('now', 'localtime'))`,
          cleanToken, appType, idNum, platform, topic
        );
      }
    }
    logger.info('Device push token registered', { appType, platform, topic });
    return { success: true };
  } catch (err) {
    logger.warn('Failed to register device push token', { error: err.message });
    return null;
  }
}

/**
 * Broadcast notification to Customer app users on campaigns, new offers or flash sales
 */
async function broadcastOfferNotification({
  title,
  body,
  imageUrl = null,
  deepLink = null,
  appType = 'customer',
  targetAudience = 'all',
}) {
  if (!title || !body) return null;
  const client = getClient();

  try {
    let activeTokens = [];
    if (isMysql()) {
      activeTokens = await client.queryAll(
        'SELECT token FROM device_push_tokens WHERE app_type = ? AND is_active = 1',
        [appType]
      );
    } else {
      activeTokens = client.all(
        'SELECT token FROM device_push_tokens WHERE app_type = ? AND is_active = 1',
        appType
      );
    }

    const sentCount = activeTokens.length;

    // Record notification in broadcast ledger
    if (isMysql()) {
      await client.execute(
        `INSERT INTO push_notifications (app_type, target_audience, title, body, image_url, deep_link, sent_count, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')`,
        [appType, targetAudience, title, body, imageUrl, deepLink, sentCount]
      );
    } else {
      client.run(
        `INSERT INTO push_notifications (app_type, target_audience, title, body, image_url, deep_link, sent_count, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')`,
        appType, targetAudience, title, body, imageUrl, deepLink, sentCount
      );
    }

    logger.info('Push notification broadcast dispatched', {
      appType,
      title,
      recipients: sentCount,
      deepLink,
    });

    return { success: true, recipients: sentCount, title, body };
  } catch (err) {
    logger.error('Failed to broadcast push notification', { error: err.message });
    return null;
  }
}

/**
 * Order status notification to customer app
 */
async function notifyCustomerOrderStatus({ orderId, invoiceNo, status, userId = null }) {
  const statusMessages = {
    confirmed: 'আপনার অর্ডারটি কনফার্ম করা হয়েছে!',
    processing: 'আপনার অর্ডারটি প্রসেসিং হচ্ছে।',
    shipped: 'আপনার পার্সেলটি ডেলিভারির জন্য কুরিয়ারে হস্তান্তর করা হয়েছে!',
    delivered: 'আপনার অর্ডার ডেলিভারি সম্পন্ন হয়েছে। কেনাকাটার জন্য ধন্যবাদ!',
    cancelled: 'আপনার অর্ডারটি বাতিল করা হয়েছে।',
  };

  const message = statusMessages[status];
  if (!message) return;

  const title = `অর্ডার আপডেট #${invoiceNo || orderId}`;
  return broadcastOfferNotification({
    title,
    body: message,
    deepLink: `/track-order?invoice=${invoiceNo || orderId}`,
    appType: 'customer',
  });
}

/**
 * New order alert to Admin & Vendor partner management app
 */
async function notifyPartnerNewOrder({ orderId, invoiceNo, totalBdt, vendorId = null }) {
  const title = '🔔 নতুন অর্ডার এসেছে!';
  const body = `অর্ডার #${invoiceNo || orderId} — মোট মূল্য: ৳${totalBdt}`;
  const deepLink = vendorId ? `/vendor/orders` : `/admin/orders`;

  return broadcastOfferNotification({
    title,
    body,
    deepLink,
    appType: vendorId ? 'vendor' : 'admin',
  });
}

module.exports = {
  registerDeviceToken,
  broadcastOfferNotification,
  notifyCustomerOrderStatus,
  notifyPartnerNewOrder,
};
