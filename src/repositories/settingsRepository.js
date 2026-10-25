'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');

const DEFAULT_SETTINGS = Object.freeze({
  site_name: 'Mr. Tumi Grocery & Gift',
  site_tagline: 'তাজা গ্রোসারি ও প্রিমিয়াম গিফট শপ',
  phone: '01700-000000',
  whatsapp: '8801700000000',
  email: 'support@mrtumi.com',
  address: 'House 12, Road 5, Dhanmondi, Dhaka-1205',
  inside_dhaka_charge: '60',
  dhaka_sub_charge: '100',
  outside_dhaka_charge: '120',
  free_shipping_min: '1500',
  otp_mode: 'off',
  advance_payment_mode: 'off',
});

function isMysqlMode(config = env) {
  return config.db.client === 'mysql';
}

function getClient(poolOverride = null) {
  return createQueryClient(poolOverride || getPool());
}

async function getAllSettings(poolOverride = null, config = env) {
  if (!isMysqlMode(config) && !poolOverride) {
    return { ...DEFAULT_SETTINGS, ...sqliteDb.getSettings() };
  }

  const client = getClient(poolOverride);
  const rows = await client.queryAll(
    'SELECT `setting_key`, `setting_value` FROM `settings`'
  );
  const map = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    map[row.setting_key] = row.setting_value ?? '';
  }
  return map;
}

async function getSetting(key, defaultValue = '', poolOverride = null, config = env) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return defaultValue;

  if (!isMysqlMode(config) && !poolOverride) {
    const all = sqliteDb.getSettings();
    return Object.prototype.hasOwnProperty.call(all, cleanKey) ? all[cleanKey] : defaultValue;
  }

  const client = getClient(poolOverride);
  const row = await client.queryOne(
    'SELECT `setting_value` FROM `settings` WHERE `setting_key` = ? LIMIT 1',
    [cleanKey]
  );
  if (!row) return defaultValue;
  return row.setting_value ?? defaultValue;
}

async function setSetting(key, value, poolOverride = null, config = env) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) {
    throw new Error('Setting key is required.');
  }
  const strVal = String(value ?? '');

  if (!isMysqlMode(config) && !poolOverride) {
    sqliteDb.setSetting(cleanKey, strVal);
    return { key: cleanKey, value: strVal };
  }

  const client = getClient(poolOverride);
  await client.execute(
    'INSERT INTO `settings` (`setting_key`, `setting_value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `setting_value` = VALUES(`setting_value`)',
    [cleanKey, strVal]
  );
  return { key: cleanKey, value: strVal };
}

module.exports = {
  DEFAULT_SETTINGS,
  getAllSettings,
  getSetting,
  setSetting,
};
