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

  const defaultSqliteFile =
    nodeEnv === 'test'
      ? path.join(ROOT_DIR, 'data', 'mrtumi.test.db')
      : path.join(ROOT_DIR, 'data', 'pholbazar.db');

  const sqlitePath = raw.SQLITE_PATH
    ? path.resolve(ROOT_DIR, String(raw.SQLITE_PATH))
    : defaultSqliteFile;

  const uploadDir = raw.UPLOAD_DIR
    ? path.resolve(ROOT_DIR, String(raw.UPLOAD_DIR))
    : path.join(ROOT_DIR, 'public', 'uploads');

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
