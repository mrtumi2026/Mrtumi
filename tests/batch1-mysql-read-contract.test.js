'use strict';

process.env.LOG_SILENT = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const storefrontRepository = require('../src/repositories/storefrontRepository');
const adminOrderReadRepository = require('../src/repositories/adminOrderReadRepository');

test('campaign storefront lookup uses active canonical MySQL campaign columns and integer paisa projection', async () => {
  const calls = [];
  const pool = { async query(sql, params = []) {
    calls.push({ sql, params });
    return [[{ id: 5, title: 'Campaign', slug: 'campaign', product_id: null, offer_price_paisa: 12345, regular_price_paisa: 16000, benefits_json: '["Benefit"]', publish_state: 'published' }], []];
  } };
  const result = await storefrontRepository.getCampaignBySlug('campaign', 'en', pool, { db: { client: 'mysql' } });
  assert.equal(result.campaign.offer_price, 123.45);
  assert.equal(result.campaign.regular_price, 160);
  assert.equal(result.campaign.benefits, 'Benefit');
  assert.deepEqual(calls[0].params, ['campaign']);
  assert.match(calls[0].sql, /offer_price_paisa/);
  assert.match(calls[0].sql, /publish_state='published'/);
});

test('admin reseller order listing binds to canonical channel/tenant fields and integer paisa', async () => {
  const calls = [];
  const pool = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('SELECT COUNT(*) AS c')) return [[{ c: 0 }], []];
    return [[], []];
  } };
  const result = await adminOrderReadRepository.listAdminResellerOrders(pool);
  assert.deepEqual(result.orders, []);
  const orderQuery = calls.find(({ sql }) => sql.includes('FROM orders o'));
  assert.match(orderQuery.sql, /reseller_id IS NOT NULL/);
  assert.match(orderQuery.sql, /order_channel='reseller'/);
  assert.match(orderQuery.sql, /total_paisa/);
});
