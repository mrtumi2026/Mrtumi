'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestVendorWithdrawal, requestResellerWithdrawal } = require('../src/repositories/partnerWithdrawalRepository');
const pii=require('../src/utils/vendorPii');
process.env.VENDOR_PII_KEY=Buffer.alloc(32,9).toString('base64');

function fakePool(balancePaisa, { vendorId = 11, payoutVendorId = 11, resellerId = 11 } = {}) {
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push(['begin']); },
    async commit() { calls.push(['commit']); },
    async rollback() { calls.push(['rollback']); },
    release() {},
    async query(sql, params) {
      calls.push([sql, params]);
      if (sql.includes('FROM vendors')) return [Number(params?.[0]) === vendorId ? [{ id: vendorId, balance_paisa: String(balancePaisa), status:1, lifecycle_status:'active', payout_verified_at:'2026-01-01' }] : [], []];
      if (sql.includes('FROM vendor_payout_accounts')) return Number(params?.[1]) === payoutVendorId ? [[{id:3,vendor_id:payoutVendorId,method:'bkash',details_ciphertext:pii.encryptVendorPii(JSON.stringify({account_number:'01712345678'})),masked_account:'••••5678'}], []] : [[], []];
      if (sql.includes('FROM vendor_wallets')) return [[{available_balance:String(balancePaisa)}], []];
      if (sql.includes('FROM partner_wallets')) return [[{available_balance:String(balancePaisa)}], []];
      if (sql.includes('FROM resellers')) return Number(params?.[0]) === resellerId ? [[{ id: resellerId, balance_paisa: String(balancePaisa) }], []] : [[], []];
      if (sql.startsWith('SELECT')) return [[{ id: 11, balance_paisa: String(balancePaisa) }], []];
      if (sql.startsWith('INSERT INTO vendor_withdrawals') || sql.startsWith('INSERT INTO reseller_transactions')) return [{ insertId: 42, affectedRows: 1 }, []];
      return [{ affectedRows: 1 }, []];
    },
  };
  return { calls, getConnection: async () => conn };
}

test('vendor withdrawal reserves funds without paying or debiting the wallet, and audits without exposing account details', async () => {
  const pool = fakePool(25000);
  const result = await requestVendorWithdrawal(11, { amount: '100.25', payoutAccountId:3 }, { ip: '127.0.0.1' }, { pool });
  assert.equal(result.amount, 100.25);
  assert.ok(pool.calls.find(([sql]) => typeof sql === 'string' && /SELECT id,balance_paisa,status,lifecycle_status,payout_verified_at FROM vendors WHERE id=\? FOR UPDATE/.test(sql)));
  assert.equal(pool.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE vendors')), false);
  assert.equal(pool.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE vendor_wallets')), false);
  const audit = pool.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(JSON.stringify(audit).includes('01712345678'), false);
  assert.ok(pool.calls.some(([sql,args])=>typeof sql==='string'&&sql.startsWith('INSERT INTO vendor_withdrawals')&&args.includes('••••5678')));
  assert.deepEqual(pool.calls.at(-1), ['commit']);
});

test('vendor withdrawal rejects another vendor payout-account ID before inserting or reserving funds', async () => {
  const pool = fakePool(25000, { payoutVendorId: 12 });
  await assert.rejects(requestVendorWithdrawal(11, { amount: '100', payoutAccountId: 3 }, {}, { pool }), { code: 'CONFLICT' });
  const payoutLookup = pool.calls.find(([sql]) => typeof sql === 'string' && sql.includes('FROM vendor_payout_accounts'));
  assert.match(payoutLookup[0], /WHERE id=\? AND vendor_id=\?/);
  assert.deepEqual(payoutLookup[1], [3, 11]);
  assert.equal(pool.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO vendor_withdrawals')), false);
});

test('reseller withdrawal rejects a foreign reseller identity before wallet mutation', async () => {
  const pool = fakePool(25000, { resellerId: 12 });
  await assert.rejects(requestResellerWithdrawal(11, { amount: '100', accountNumber: 'synthetic-account' }, {}, { pool }), { code: 'NOT_FOUND' });
  assert.ok(pool.calls.some(([sql, args]) => typeof sql === 'string' && /FROM resellers WHERE id=\? FOR UPDATE/.test(sql) && args[0] === 11));
  assert.equal(pool.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO reseller_transactions')), false);
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
  await assert.rejects(requestVendorWithdrawal(11, { amount: '100.001', payoutAccountId:3 }, {}, { pool }), TypeError);
  await assert.rejects(requestResellerWithdrawal(11, { amount: '99', accountNumber: 'x' }, {}, { pool }), RangeError);
  await assert.rejects(requestVendorWithdrawal(11, { amount: '100' }, {}, { pool }), TypeError);
});
