'use strict';

/** Admin → Courier API: the credentials typed there are all a courier needs. */
const mysql = require('../db/mysqlPool');
const { encryptProviderToken } = require('../utils/providerTokenSecurity');
const { validateCourierBaseUrl } = require('../utils/ssrfValidator');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const PROVIDERS = ['pathao', 'steadfast', 'redx', 'custom'];
const text = (value, max) => String(value ?? '').trim().slice(0, max);

function parseOptions(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  } catch (_error) {
    return {};
  }
}

async function readForm(body) {
  const name = text(body.name, 100);
  const code = text(body.code, 32).toLowerCase();
  if (!name || !/^[a-z0-9_-]{1,32}$/.test(code)) throw new ValidationError('Courier name and a valid unique code (a-z, 0-9, - _) are required.');
  const baseUrl = text(body.base_url, 255);
  if (baseUrl) await validateCourierBaseUrl(baseUrl);
  const storeId = text(body.store_id, 12);
  if (storeId && !/^[1-9]\d{0,9}$/.test(storeId)) throw new ValidationError('Pathao Store ID must be a number.');
  const provider = text(body.provider_type, 32).toLowerCase();
  return {
    name, code, baseUrl, storeId,
    provider: PROVIDERS.includes(provider) ? provider : 'custom',
    apiKey: text(body.api_key, 4000),
    secretKey: text(body.secret_key, 1000),
    clientId: text(body.client_id, 191),
    username: text(body.pathao_username, 191),
    password: String(body.pathao_password ?? '').slice(0, 200),
    // Anything but an explicit "test" is live: a test-mode courier never creates a real parcel.
    sandbox: String(body.sandbox) === '1' ? 1 : 0
  };
}

function buildOptions(form, current = {}) {
  const options = { ...current };
  if (form.storeId) options.store_id = Number(form.storeId); else delete options.store_id;
  if (form.username) options.username = form.username; else delete options.username;
  if (form.password) { options.password_enc = encryptProviderToken(form.password); delete options.password; }
  return options;
}

async function duplicateGuard(error) {
  if (error && error.code === 'ER_DUP_ENTRY') throw new ConflictError('Another courier already uses this code.');
  throw error;
}

async function listForAdmin() {
  return mysql.queryAll('SELECT id,name,code,provider_type,api_key,secret_key,client_id,base_url,status,sandbox,service_options_json,updated_at FROM courier_apis ORDER BY id ASC');
}

async function create(body) {
  const form = await readForm(body);
  const options = buildOptions(form);
  try {
    await mysql.execute(
      'INSERT INTO courier_apis (name,code,provider_type,base_url,api_key,secret_key,client_id,status,sandbox,service_options_json) VALUES (?,?,?,?,?,?,?,0,?,?)',
      [form.name, form.code, form.provider, form.baseUrl, form.apiKey || null, form.secretKey || null, form.clientId, form.sandbox, JSON.stringify(options)]);
  } catch (error) { await duplicateGuard(error); }
}

async function update(idInput, body) {
  const form = await readForm(body);
  const id = Number(idInput) || 0;
  try {
    await mysql.withTransaction(async (tx) => {
      const row = await tx.queryOne('SELECT client_id,secret_key,sandbox,service_options_json FROM courier_apis WHERE id=? FOR UPDATE', [id]);
      if (!row) throw new NotFoundError('Courier setting not found.');
      const current = parseOptions(row.service_options_json);
      const options = buildOptions(form, current);
      // A stored Pathao login token belongs to the old account or mode, so it is fetched again.
      const loginChanged = Boolean(form.password) || Boolean(form.secretKey && form.secretKey !== row.secret_key)
        || form.clientId !== String(row.client_id || '') || form.username !== String(current.username || '')
        || form.sandbox !== Number(row.sandbox);
      const forgetToken = form.provider === 'pathao' && !form.apiKey && loginChanged && Boolean(options.username && (options.password_enc || options.password));
      if (forgetToken || form.apiKey) { delete options.encrypted_refresh_token; delete options.refresh_token; }
      await tx.execute(
        `UPDATE courier_apis SET name=?,code=?,provider_type=?,base_url=?,
           api_key=CASE WHEN ?<>'' THEN ? WHEN ?=1 THEN NULL ELSE api_key END,
           secret_key=CASE WHEN ?<>'' THEN ? ELSE secret_key END,client_id=?,sandbox=?,service_options_json=? WHERE id=?`,
        [form.name, form.code, form.provider, form.baseUrl, form.apiKey, form.apiKey, forgetToken ? 1 : 0,
          form.secretKey, form.secretKey, form.clientId, form.sandbox, JSON.stringify(options), id]);
    });
  } catch (error) { await duplicateGuard(error); }
}

async function testConnection(idInput) {
  const row = await mysql.queryOne('SELECT * FROM courier_apis WHERE id=?', [Number(idInput) || 0]);
  if (!row) throw new NotFoundError('Courier setting not found.');
  const adapter = require('../services/courier/CourierProviderFactory').createAdapter(row);
  if (adapter.isSandbox) return { name: row.name, ok: false, message: 'This courier is in Test mode, so nothing was sent. Choose Live mode to test the real account.' };
  if (typeof adapter.testConnection !== 'function') return { name: row.name, ok: false, message: 'No connection test for this courier.' };
  return { name: row.name, ...(await adapter.testConnection()) };
}

module.exports = { listForAdmin, create, update, testConnection, parseOptions };
