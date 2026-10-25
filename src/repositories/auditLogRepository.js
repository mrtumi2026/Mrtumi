'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');
const logger = require('../utils/logger');

function isMysqlMode(config = env) {
  return config.db.client === 'mysql';
}

function getClient(poolOverride = null) {
  return createQueryClient(poolOverride || getPool());
}

async function recordAuditLog(
  {
    actorType = 'system',
    actorId = null,
    action,
    entityType = '',
    entityId = null,
    beforeState = null,
    afterState = null,
    metadata = null,
    ipAddress = '',
    userAgent = '',
  },
  poolOverride = null,
  config = env
) {
  if (!isMysqlMode(config) && !poolOverride) {
    return;
  }

  const client = getClient(poolOverride);
  const safeBefore = beforeState ? JSON.stringify(logger.redactValue(beforeState)) : null;
  const effectiveAfter = afterState ?? metadata;
  const safeAfter = effectiveAfter ? JSON.stringify(logger.redactValue(effectiveAfter)) : null;

  await client.execute(
    `INSERT INTO \`audit_logs\`
      (\`actor_type\`, \`actor_id\`, \`action\`, \`entity_type\`, \`entity_id\`, \`before_json\`, \`after_json\`, \`ip_address\`, \`user_agent\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(actorType).slice(0, 32),
      actorId ?? null,
      String(action).slice(0, 120),
      String(entityType || '').slice(0, 80),
      entityId !== null && entityId !== undefined ? String(entityId).slice(0, 64) : null,
      safeBefore,
      safeAfter,
      String(ipAddress || '').slice(0, 64),
      String(userAgent || '').slice(0, 255),
    ]
  );
}

async function recordErrorLog(
  { level = 'ERROR', code = 'INTERNAL_ERROR', message = '', context = '', requestId = '' },
  poolOverride = null,
  config = env
) {
  if (!isMysqlMode(config) && !poolOverride) {
    try {
      sqliteDb.run(
        'INSERT INTO error_logs (level, message, context) VALUES (?, ?, ?)',
        String(level).slice(0, 16),
        String(message).slice(0, 500),
        String(context).slice(0, 120)
      );
    } catch (_e) {
      // Never throw inside error-log persistence
    }
    return;
  }

  const client = getClient(poolOverride);
  const contextJson = JSON.stringify({
    context: String(context || '').slice(0, 120),
    requestId: String(requestId || '').slice(0, 64),
  });

  await client.execute(
    `INSERT INTO \`error_logs\` (\`level\`, \`code\`, \`message\`, \`context_json\`)
     VALUES (?, ?, ?, ?)`,
    [
      String(level || 'ERROR').slice(0, 20),
      String(code || 'INTERNAL_ERROR').slice(0, 64),
      String(message || '').slice(0, 2000),
      contextJson,
    ]
  );
}

module.exports = {
  recordAuditLog,
  recordErrorLog,
};
