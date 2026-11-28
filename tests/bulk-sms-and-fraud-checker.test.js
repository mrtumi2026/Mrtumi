'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqliteDb = require('../src/db/database');

test.before(() => {
  try {
    sqliteDb.initializeDatabase();
  } catch (_) {}
});

const smsService = require('../src/services/smsService');
const bdCourierFraudService = require('../src/services/bdCourierFraudService');

test('smsService normalizes BD mobile numbers reliably', () => {
  assert.equal(smsService.normalizeBdMobile('01711223344'), '8801711223344');
  assert.equal(smsService.normalizeBdMobile('+8801811223344'), '8801811223344');
  assert.equal(smsService.normalizeBdMobile('8801911223344'), '8801911223344');
  assert.equal(smsService.normalizeBdMobile('1711223344'), '8801711223344');
});

test('smsService fails gracefully when BulkSMSBD is not configured', async () => {
  const result = await smsService.sendSms({ phone: '01711000000', message: 'Test message' });
  assert.equal(result.success, false);
  assert.ok(result.error);
});

test('smsService balance check fails gracefully when API key is missing', async () => {
  const result = await smsService.checkBalance();
  assert.equal(result.configured, false);
  assert.equal(result.success, false);
});

test('bdCourierFraudService cleans phone numbers reliably', () => {
  assert.equal(bdCourierFraudService.cleanPhone('01711223344'), '01711223344');
  assert.equal(bdCourierFraudService.cleanPhone('+8801811223344'), '01811223344');
  assert.equal(bdCourierFraudService.cleanPhone('8801911223344'), '01911223344');
});

test('bdCourierFraudService returns store data and informative notice when API key is not yet set', async () => {
  const result = await bdCourierFraudService.checkPhoneFraud('01711223344');
  assert.equal(result.phone, '01711223344');
  assert.equal(result.available, true);
  assert.ok(Array.isArray(result.couriers));
  assert.ok(Array.isArray(result.storeOrders));
  assert.ok(typeof result.successRate === 'number');
  assert.ok(typeof result.isBlocked === 'boolean');
});

test('bdCourierFraudService checkPlan returns unconfigured when API key is missing', async () => {
  const plan = await bdCourierFraudService.checkPlan();
  assert.equal(plan.configured, false);
  assert.equal(plan.status, 'unconfigured');
});

test('smsService reads the BulkSMSBD balance and never echoes the API key in an error', async () => {
  const sqliteDb = require('../src/db/database');
  const settingsRepository = require('../src/repositories/settingsRepository');
  const saved = { fetch: globalThis.fetch, getAll: settingsRepository.getAllSettings, set: settingsRepository.setSetting, sget: sqliteDb.getSettings, sset: sqliteDb.setSetting };
  const stored = [];
  const settings = async () => ({ bulksms_api_key: 'qa-secret-key-123' });
  settingsRepository.getAllSettings = settings;
  settingsRepository.setSetting = async (k, v) => stored.push([k, v]);
  sqliteDb.getSettings = () => ({ bulksms_api_key: 'qa-secret-key-123' });
  sqliteDb.setSetting = (k, v) => stored.push([k, v]);
  const reply = (body) => async () => ({ ok: true, json: async () => body });
  try {
    globalThis.fetch = reply({ response_code: 202, balance: 41.5 });
    assert.deepEqual(await smsService.checkBalance(), { success: true, configured: true, balance: '41.5' });
    assert.deepEqual(stored, [['bulksms_balance', '41.5']]);

    // A reply without a balance must not overwrite the stored figure with zero.
    globalThis.fetch = reply({ response_code: 1032, error_message: 'IP not whitelisted for qa-secret-key-123' });
    const rejected = await smsService.checkBalance();
    assert.equal(rejected.success, false);
    assert.doesNotMatch(rejected.message, /qa-secret-key-123/);

    globalThis.fetch = async (url) => { throw new Error(`request to ${url} failed`); };
    const offline = await smsService.checkBalance();
    assert.equal(offline.success, false);
    assert.doesNotMatch(offline.message, /qa-secret-key-123/);
    assert.equal(stored.length, 1);
  } finally {
    globalThis.fetch = saved.fetch;
    settingsRepository.getAllSettings = saved.getAll;
    settingsRepository.setSetting = saved.set;
    sqliteDb.getSettings = saved.sget;
    sqliteDb.setSetting = saved.sset;
  }
});
