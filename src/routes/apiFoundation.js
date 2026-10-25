'use strict';

const express = require('express');
const { env } = require('../config/env');
const { pingPool } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');
const { asyncHandler } = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

const router = express.Router();

async function evaluateDatabaseHealth() {
  if (env.db.client === 'mysql') {
    const ping = await pingPool();
    return {
      ...ping,
      client: 'mysql',
    };
  }
  const start = Date.now();
  try {
    const row = sqliteDb.get('SELECT 1 AS ok');
    return {
      ok: Boolean(row && Number(row.ok) === 1),
      client: 'sqlite',
      latencyMs: Date.now() - start,
    };
  } catch (_err) {
    return {
      ok: false,
      client: 'sqlite',
      latencyMs: Date.now() - start,
      code: 'SQLITE_UNAVAILABLE',
      message: 'Local SQLite database check failed.',
    };
  }
}

const healthHandler = asyncHandler(async (_req, res) => {
  const dbHealth = await evaluateDatabaseHealth();
  const statusCode = dbHealth.ok ? 200 : 503;

  return sendSuccess(
    res,
    {
      status: dbHealth.ok ? 'ok' : 'degraded',
      service: env.appName,
      environment: env.nodeEnv,
      timezone: env.timezone,
      defaultLocale: env.defaultLocale,
      currency: env.currencyCode,
      uptimeSec: Math.floor(process.uptime()),
      database: {
        ok: dbHealth.ok,
        client: dbHealth.client || env.db.client,
        latencyMs: dbHealth.latencyMs,
        ...(dbHealth.ok ? {} : { code: dbHealth.code }),
      },
    },
    statusCode
  );
});

router.get('/health', healthHandler);
router.get('/api/v1/health', healthHandler);

router.get('/api/v1/csrf-token', (req, res) => {
  const csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : res.locals.csrfToken || '';
  return sendSuccess(res, { csrfToken });
});

module.exports = router;
