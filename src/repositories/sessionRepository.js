'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');

let sqliteSessionTableInitialized = false;

function ensureSqliteSessionTable() {
  if (sqliteSessionTableInitialized) return;
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);
  sqliteSessionTableInitialized = true;
}

function toMysqlUtcDatetime(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

function parseMysqlUtcEpochMs(val) {
  if (!val) return null;
  if (val instanceof Date) return val.getTime();
  return new Date(`${String(val).replace(' ', 'T')}Z`).getTime();
}

function isMysqlMode(config = env) {
  return config.db.client === 'mysql';
}

function getClient(poolOverride = null) {
  return createQueryClient(poolOverride || getPool());
}

async function getActiveSession(sid, nowEpochMs = Date.now(), poolOverride = null, config = env) {
  if (!sid) return null;

  if (!isMysqlMode(config) && !poolOverride) {
    ensureSqliteSessionTable();
    const row = sqliteDb.get('SELECT data FROM web_sessions WHERE sid = ?', sid);
    if (!row) return null;
    return {
      sid,
      dataJson: row.data || '{}',
      expiresAtMs: null,
    };
  }

  const client = getClient(poolOverride);
  const nowUtc = toMysqlUtcDatetime(nowEpochMs);
  const row = await client.queryOne(
    'SELECT `sid`, `data_json`, `expires_at` FROM `web_sessions` WHERE `sid` = ? AND (`expires_at` IS NULL OR `expires_at` > ?) LIMIT 1',
    [sid, nowUtc]
  );
  if (!row) return null;
  return {
    sid: row.sid,
    dataJson: row.data_json,
    expiresAtMs: parseMysqlUtcEpochMs(row.expires_at),
  };
}

async function upsertSession(
  { sid, dataJson, expiresAtMs, ipAddress = '', actorType = null, actorId = null },
  poolOverride = null,
  config = env
) {
  if (!sid) return;

  if (!isMysqlMode(config) && !poolOverride) {
    ensureSqliteSessionTable();
    sqliteDb.run(
      `INSERT INTO web_sessions (sid, data, updated_at)
       VALUES (?, ?, datetime('now', 'localtime'))
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      sid,
      String(dataJson)
    );
    return;
  }

  const client = getClient(poolOverride);
  const expiresUtc = toMysqlUtcDatetime(expiresAtMs);
  await client.execute(
    `INSERT INTO \`web_sessions\` (\`sid\`, \`actor_type\`, \`actor_id\`, \`data_json\`, \`ip_address\`, \`expires_at\`)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       \`actor_type\` = VALUES(\`actor_type\`),
       \`actor_id\` = VALUES(\`actor_id\`),
       \`data_json\` = VALUES(\`data_json\`),
       \`ip_address\` = VALUES(\`ip_address\`),
       \`expires_at\` = VALUES(\`expires_at\`)`,
    [
      String(sid).slice(0, 128),
      actorType ? String(actorType).slice(0, 32) : null,
      actorId ?? null,
      String(dataJson),
      String(ipAddress || '').slice(0, 64),
      expiresUtc,
    ]
  );
}

async function deleteSession(sid, poolOverride = null, config = env) {
  if (!sid) return;

  if (!isMysqlMode(config) && !poolOverride) {
    ensureSqliteSessionTable();
    sqliteDb.run('DELETE FROM web_sessions WHERE sid = ?', sid);
    return;
  }

  const client = getClient(poolOverride);
  await client.execute('DELETE FROM `web_sessions` WHERE `sid` = ?', [sid]);
}

async function purgeExpiredSessions(nowEpochMs = Date.now(), poolOverride = null, config = env) {
  if (!isMysqlMode(config) && !poolOverride) {
    return;
  }
  const client = getClient(poolOverride);
  const nowUtc = toMysqlUtcDatetime(nowEpochMs);
  await client.execute(
    'DELETE FROM `web_sessions` WHERE `expires_at` IS NOT NULL AND `expires_at` < ?',
    [nowUtc]
  );
}

module.exports = {
  getActiveSession,
  upsertSession,
  deleteSession,
  purgeExpiredSessions,
  toMysqlUtcDatetime,
};
