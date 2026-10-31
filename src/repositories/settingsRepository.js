'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
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

/** Atomically persists a legacy settings form and an audit event on MySQL. Values are
 * intentionally excluded from audit metadata because settings may contain credentials. */
async function saveSettings(values, actor = {}, poolOverride = null, config = env) {
  if (!isMysqlMode(config) && !poolOverride) {
    for (const [key, value] of Object.entries(values || {})) {
      await setSetting(key, value);
    }
    return { keys: Object.keys(values || {}) };
  }

  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError('Settings must be provided as an object.');
  }
  const entries = Object.entries(values);
  if (!entries.length || entries.length > 100) throw new TypeError('Settings form must contain between 1 and 100 values.');
  let totalBytes = 0;
  const normalized = entries.map(([rawKey, rawValue]) => {
    const key = String(rawKey);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key) || key.startsWith('_')) throw new TypeError('Settings form contains an invalid key.');
    if (rawValue !== null && !['string', 'number', 'boolean'].includes(typeof rawValue)) throw new TypeError('Settings values must be scalar form values.');
    const value = String(rawValue ?? '');
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    return [key, value];
  }).sort(([a], [b]) => a.localeCompare(b));
  if (totalBytes > 262144) throw new TypeError('Settings form exceeds the allowed size.');

  const activePool = poolOverride || getPool();
  await withTransaction(async (tx) => {
    for (const [key, value] of normalized) {
      await tx.execute(
        'INSERT INTO `settings` (`setting_key`, `setting_value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `setting_value` = VALUES(`setting_value`)',
        [key, value]
      );
    }
    await tx.execute(
      `INSERT INTO \`audit_logs\` (\`actor_type\`, \`actor_id\`, \`action\`, \`entity_type\`, \`entity_id\`, \`after_json\`, \`ip_address\`, \`user_agent\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['admin', actor.id || null, 'admin.settings.updated', 'settings', 'legacy_form', JSON.stringify({ keys: normalized.map(([key]) => key) }), actor.ip || '', actor.userAgent || '']
    );
  }, { pool: activePool });
  return { keys: normalized.map(([key]) => key) };
}

module.exports = {
  DEFAULT_SETTINGS,
  getAllSettings,
  getSetting,
  setSetting,
  saveSettings,
};
