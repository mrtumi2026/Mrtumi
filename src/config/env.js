'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * Lightweight zero-dependency .env loader so environments work cleanly
 * across local dev, CI, cPanel Passenger, and SSH CLI scripts.
 * Existing process.env variables always take precedence over .env file entries.
 */
function loadDotEnvFile(envFilePath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envFilePath)) return;
  const content = fs.readFileSync(envFilePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(String(value));
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      url.protocol === 'https:' &&
      Boolean(hostname) &&
      !['localhost', '127.0.0.1', '::1'].includes(hostname) &&
      !hostname.endsWith('.localhost') &&
      !url.username &&
      !url.password &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash
    );
  } catch (_err) {
    return false;
  }
}

function buildConfig(overrides = {}) {
  loadDotEnvFile();
  const raw = { ...process.env, ...overrides };

  const nodeEnv = String(raw.NODE_ENV || 'development').trim().toLowerCase();
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV "${nodeEnv}". Expected development, test, or production.`);
  }

  const timezone = String(raw.TZ || 'Asia/Dhaka').trim();
  process.env.TZ = timezone;

  const supportedLocales = String(raw.SUPPORTED_LOCALES || 'bn,en')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const defaultLocale = String(raw.DEFAULT_LOCALE || 'bn').trim().toLowerCase();
  if (!supportedLocales.includes(defaultLocale)) {
    throw new Error(
      `DEFAULT_LOCALE "${defaultLocale}" must be included in SUPPORTED_LOCALES (${supportedLocales.join(', ')}).`
    );
  }

  let sessionSecret = String(raw.SESSION_SECRET || '').trim();
  const isPlaceholderSecret =
    !sessionSecret ||
    sessionSecret.startsWith('REPLACE_WITH_') ||
    sessionSecret.length < 32;

  if (nodeEnv === 'production' && isPlaceholderSecret) {
    throw new Error(
      'SECURITY ERROR: SESSION_SECRET must be set to a random string of at least 32 characters in production.'
    );
  }
  if (!sessionSecret || sessionSecret.startsWith('REPLACE_WITH_')) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  let csrfSecret = String(raw.CSRF_SECRET || '').trim();
  const hasExplicitCsrf = raw.CSRF_SECRET !== undefined && csrfSecret !== '';
  if (
    nodeEnv === 'production' &&
    hasExplicitCsrf &&
    (csrfSecret.startsWith('REPLACE_WITH_') || csrfSecret.length < 32)
  ) {
    throw new Error(
      'SECURITY ERROR: CSRF_SECRET must be at least 32 random characters in production.'
    );
  }
  if (!csrfSecret || csrfSecret.startsWith('REPLACE_WITH_')) {
    csrfSecret = crypto.createHmac('sha256', sessionSecret).update('mrtumi-csrf-v1').digest('hex');
  }

  const defaultDbClient = nodeEnv === 'production' ? 'mysql' : 'sqlite';
  const dbClient = String(raw.DB_CLIENT || defaultDbClient).trim().toLowerCase();
  if (!['mysql', 'sqlite'].includes(dbClient)) {
    throw new Error(`Invalid DB_CLIENT "${dbClient}". Expected "mysql" or "sqlite".`);
  }
  if (nodeEnv === 'production' && dbClient !== 'mysql') {
    throw new Error(
      'PRODUCTION DATABASE ERROR: SQLite is prohibited in production. Set DB_CLIENT=mysql for BestWebHostBD MySQL.'
    );
  }

  const uploadDir = raw.UPLOAD_DIR
    ? path.resolve(ROOT_DIR, String(raw.UPLOAD_DIR))
    : path.join(ROOT_DIR, 'public', 'uploads');

  if (nodeEnv === 'production') {
    const missing = [];
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      if (raw[key] === undefined || String(raw[key]).trim() === '' || String(raw[key]).trim().startsWith('REPLACE_WITH_')) {
        missing.push(key);
      }
    }
    if (raw.DB_CLIENT === undefined || String(raw.DB_CLIENT).trim().toLowerCase() !== 'mysql') {
      missing.push('DB_CLIENT=mysql');
    }
    if (raw.CSRF_SECRET === undefined || !csrfSecret || csrfSecret.startsWith('REPLACE_WITH_')) {
      missing.push('CSRF_SECRET');
    } else if (csrfSecret === sessionSecret) {
      missing.push('CSRF_SECRET (must differ from SESSION_SECRET)');
    }
    if (raw.TRUST_PROXY === undefined || String(raw.TRUST_PROXY).trim() === '') {
      missing.push('TRUST_PROXY (set to the verified proxy-hop count)');
    } else if (!Number.isSafeInteger(Number(raw.TRUST_PROXY)) || Number(raw.TRUST_PROXY) < 0) {
      missing.push('TRUST_PROXY (must be a non-negative integer)');
    }
    if (!raw.APP_URL || !isHttpsOrigin(raw.APP_URL)) {
      missing.push('APP_URL (must be the approved HTTPS origin)');
    }
    if (!raw.UPLOAD_DIR || !path.isAbsolute(String(raw.UPLOAD_DIR).trim())) {
      missing.push('UPLOAD_DIR (must be an absolute persistent path outside the application root)');
    } else {
      const relativeUploadPath = path.relative(ROOT_DIR, uploadDir);
      if (relativeUploadPath === '' || (!relativeUploadPath.startsWith('..') && !path.isAbsolute(relativeUploadPath))) {
        missing.push('UPLOAD_DIR (must be outside the application root)');
      }
    }
    if (missing.length > 0) {
      throw new Error(`PRODUCTION CONFIGURATION ERROR: configure valid values for ${missing.join(', ')}. Values are intentionally not shown.`);
    }
    if (!Number.isInteger(Number(raw.DB_PORT)) || Number(raw.DB_PORT) < 1 || Number(raw.DB_PORT) > 65535) {
      throw new Error('PRODUCTION CONFIGURATION ERROR: DB_PORT must be an integer from 1 to 65535.');
    }
  }

  const defaultSqliteFile =
    nodeEnv === 'test'
      ? path.join(ROOT_DIR, 'data', 'mrtumi.test.db')
      : path.join(ROOT_DIR, 'data', 'pholbazar.db');

  const sqlitePath = raw.SQLITE_PATH
    ? path.resolve(ROOT_DIR, String(raw.SQLITE_PATH))
    : defaultSqliteFile;

  const seedDemoData =
    nodeEnv === 'production'
      ? String(raw.ALLOW_PRODUCTION_DEMO_SEED || 'false').toLowerCase() === 'true'
      : String(raw.SEED_DEMO_DATA || 'true').toLowerCase() !== 'false';

  return Object.freeze({
    rootDir: ROOT_DIR,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    isDevelopment: nodeEnv === 'development',
    appName: String(raw.APP_NAME || 'Mr. Tumi Grocery & Gift'),
    appUrl: String(raw.APP_URL || 'http://localhost:3000'),
    host: String(raw.HOST || '0.0.0.0'),
    port: Number(raw.PORT || 3000),
    trustProxy: Number(raw.TRUST_PROXY ?? 1),
    timezone,
    defaultLocale,
    supportedLocales: Object.freeze(supportedLocales),
    currencyCode: String(raw.CURRENCY_CODE || 'BDT'),
    currencySymbol: String(raw.CURRENCY_SYMBOL || '৳'),
    sessionSecret,
    csrfSecret,
    uploadDir,
    db: Object.freeze({
      client: dbClient,
      sqlitePath,
      host: String(raw.DB_HOST || '127.0.0.1'),
      port: Number(raw.DB_PORT || 3306),
      name: String(raw.DB_NAME || ''),
      user: String(raw.DB_USER || ''),
      password: String(raw.DB_PASSWORD || ''),
      charset: String(raw.DB_CHARSET || 'utf8mb4'),
      timezone: String(raw.DB_TIMEZONE || '+00:00'),
      connectionLimit: Number(raw.DB_CONNECTION_LIMIT || 10),
    }),
    seedDemoData,
    bootstrapAdminEmail: String(raw.BOOTSTRAP_ADMIN_EMAIL || 'admin@mrtumi.local').trim(),
    bootstrapAdminPassword: String(raw.BOOTSTRAP_ADMIN_PASSWORD || '').trim(),
    analyticsAttributionEnabled: String(raw.ANALYTICS_ATTRIBUTION_ENABLED || '').trim().toLowerCase() === 'true',
  });
}

const env = buildConfig();

module.exports = {
  env,
  buildConfig,
  loadDotEnvFile,
};
