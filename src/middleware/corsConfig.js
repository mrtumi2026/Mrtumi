'use strict';

/**
 * Enterprise CORS & Cross-Origin Defense
 * =====================================
 * Enforces strict Origin whitelist, credentials binding, and pre-flight handling.
 * Safely whitelists inbound webhooks from payment gateways without exposing sessions.
 */

const { env } = require('../config/env');
const { logger } = require('../utils/logger');

function parseAllowedOrigins() {
  const envOrigins = process.env.ALLOWED_ORIGINS || '';
  const parsed = envOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (parsed.length > 0) return parsed;

  if (env.isProduction) {
    return [
      env.appUrl,
      'https://mrtumi.com',
      'https://www.mrtumi.com',
      'https://admin.mrtumi.com',
      'https://vendor.mrtumi.com',
    ].filter(Boolean);
  }

  // Development & Test environments
  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://0.0.0.0:3000',
  ];
}

const ALLOWED_ORIGINS = new Set(parseAllowedOrigins());

// Paths originating from external servers that must bypass browser CORS and CSRF
const WEBHOOK_OR_EXTERNAL_CALLBACK_PATHS = [
  /^\/webhooks\//,
  /^\/payment\/[a-z0-9_-]+\/callback/i,
  /^\/api\/courier\/webhook/i,
];

function isExternalWebhook(path) {
  return WEBHOOK_OR_EXTERNAL_CALLBACK_PATHS.some((regex) => regex.test(path));
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;

  // 1. External webhook bypass: Allow server-to-server calls without browser origin header
  if (isExternalWebhook(req.path)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, RT-UDDOKTAPAY-API-KEY');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  }

  // 2. Browser request with Origin header
  if (origin) {
    if (ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS'
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With, X-CSRF-Token, Accept'
      );
      res.setHeader('Access-Control-Max-Age', '86400'); // 24-hour pre-flight cache
    } else {
      logger.warn({ event: 'cors_blocked_unauthorized_origin', origin, path: req.path });
      if (req.method === 'OPTIONS') {
        return res.status(403).end('CORS Policy: Origin not allowed.');
      }
    }
  }

  // Handle browser pre-flight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
}

module.exports = {
  corsMiddleware,
  isExternalWebhook,
  ALLOWED_ORIGINS,
};
