'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestVendorWithdrawal, requestResellerWithdrawal } = require('../src/repositories/partnerWithdrawalRepository');

function fakePool(balancePaisa) {
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push(['begin']); },
    async commit() { calls.push(['commit']); },
    async rollback() { calls.push(['rollback']); },
    release() {},
    async query(sql, params) {
      calls.push([sql, params]);
      if (sql.startsWith('SELECT')) return [[{ id: 11, balance_paisa: String(balancePaisa) }], []];
      if (sql.startsWith('INSERT INTO vendor_withdrawals') || sql.startsWith('INSERT INTO reseller_transactions')) return [{ insertId: 42, affectedRows: 1 }, []];
      return [{ affectedRows: 1 }, []];
    },
  };
  return { calls, getConnection: async () => conn };
}

test('vendor withdrawal locks balance and atomically deducts, records pending request and audit without exposing account details', async () => {
  const pool = fakePool(25000);
  const result = await requestVendorWithdrawal(11, { amount: '100.25', accountNumber: 'synthetic-account' }, { ip: '127.0.0.1' }, { pool });
  assert.equal(result.amount, 100.25);
  assert.ok(pool.calls.find(([sql]) => typeof sql === 'string' && /SELECT id,balance_paisa FROM vendors WHERE id=\? FOR UPDATE/.test(sql)));
  assert.ok(pool.calls.find(([sql, args]) => typeof sql === 'string' && sql.startsWith('UPDATE vendors') && args[0] === 10025));
  const audit = pool.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(JSON.stringify(audit).includes('synthetic-account'), false);
  assert.deepEqual(pool.calls.at(-1), ['commit']);
});

test('reseller withdrawal uses canonical transaction columns and rolls back insufficient balance', async () => {
  const pool = fakePool(9999);
  await assert.rejects(requestResellerWithdrawal(11, { amount: '100', accountNumber: 'synthetic-account' }, {}, { pool }), { code: 'CONFLICT' });
  assert.ok(pool.calls.some(([sql]) => typeof sql === 'string' && /SELECT id,balance_paisa FROM resellers WHERE id=\? FOR UPDATE/.test(sql)));
  assert.deepEqual(pool.calls.at(-1), ['rollback']);
  assert.equal(pool.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO reseller_transactions')), false);
});

test('withdrawal amount validation rejects sub-paisa precision and missing payout details before connecting', async () => {
  const pool = { getConnection: async () => { throw new Error('must not connect'); } };
  await assert.rejects(requestVendorWithdrawal(11, { amount: '100.001', accountNumber: 'x' }, {}, { pool }), TypeError);
  await assert.rejects(requestResellerWithdrawal(11, { amount: '99', accountNumber: 'x' }, {}, { pool }), RangeError);
  await assert.rejects(requestVendorWithdrawal(11, { amount: '100' }, {}, { pool }), TypeError);
});
