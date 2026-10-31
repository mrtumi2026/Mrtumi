'use strict';

process.env.LOG_SILENT = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/repositories/adminCouponRepository');

function poolFixture({ failAudit = false, duplicate = false } = {}) {
  const calls = [];
  const state = { began: false, committed: false, rolledBack: false };
  const connection = {
    async beginTransaction() { state.began = true; },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() {},
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO coupons')) {
        if (duplicate) { const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error; }
        return [{ insertId: 42, affectedRows: 1 }, []];
      }
      if (sql.includes('INSERT INTO `audit_logs`')) {
        if (failAudit) { const error = new Error('audit failed'); error.code = 'ER_SIGNAL_EXCEPTION'; throw error; }
        return [{ insertId: 8, affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool = {
    calls, state,
    async getConnection() { return connection; },
    async query(sql, params = []) { calls.push({ sql, params }); return [[], []]; },
  };
  return pool;
}

test('coupon list maps canonical paisa and fixed discounts to the legacy management view contract', async () => {
  const pool = poolFixture();
  await repo.listCoupons({ pool });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /discount_type='fixed'.*'flat'/s);
  assert.match(sql, /discount_value\/100/);
  assert.match(sql, /min_purchase_paisa\/100/);
  assert.match(sql, /DATE_FORMAT\(expires_at/);
  assert.match(sql, /ORDER BY id DESC/);
  assert.deepEqual(params, []);
});

test('coupon creation converts legacy percent/flat form values to canonical paisa and audits transactionally', async () => {
  const pool = poolFixture();
  const created = await repo.createCoupon({ code: ' save10 ', type: 'percent', value: '10', min_purchase: '500.25', expiry_date: '2027-12-31' }, { id: 7, ip: '127.0.0.1' }, { pool });
  assert.equal(created.id, 42);
  assert.equal(created.code, 'SAVE10');
  assert.equal(created.discountType, 'percent');
  assert.equal(created.discountValue, 10);
  assert.equal(created.minPurchasePaisa, 50025);
  assert.equal(created.expiresAt, '2027-12-31 23:59:59');
  const insert = pool.calls.find(({ sql }) => sql.includes('INSERT INTO coupons'));
  assert.deepEqual(insert.params, ['SAVE10', 'percent', 10, 50025, '2027-12-31 23:59:59']);
  assert.ok(pool.calls.some(({ sql }) => sql.includes('INSERT INTO `audit_logs`')));
  assert.equal(pool.state.committed, true);
  assert.equal(pool.state.rolledBack, false);

  const flatPool = poolFixture();
  const flat = await repo.createCoupon({ code: 'flat20', type: 'flat', value: '20.50', min_purchase: '0', expiry_date: '2028-02-29' }, {}, { pool: flatPool });
  assert.equal(flat.discountType, 'fixed');
  assert.equal(flat.discountValue, 2050);
  assert.deepEqual(flatPool.calls.find(({ sql }) => sql.includes('INSERT INTO coupons')).params, ['FLAT20', 'fixed', 2050, 0, '2028-02-29 23:59:59']);
});

test('coupon validation rejects malformed inputs before opening a transaction', async () => {
  for (const input of [
    { code: '', type: 'percent', value: 10, expiry_date: '2027-12-31' },
    { code: 'BAD', type: 'fixed', value: 10, expiry_date: '2027-12-31' },
    { code: 'BAD', type: 'percent', value: 101, expiry_date: '2027-12-31' },
    { code: 'BAD', type: 'flat', value: '10.999', expiry_date: '2027-12-31' },
    { code: 'BAD', type: 'percent', value: 10, min_purchase: '-1', expiry_date: '2027-12-31' },
    { code: 'BAD', type: 'percent', value: 10, expiry_date: '2027-02-29' },
  ]) {
    const pool = poolFixture();
    await assert.rejects(repo.createCoupon(input, {}, { pool }), { code: 'VALIDATION_ERROR' });
    assert.equal(pool.state.began, false);
  }
});

test('duplicate coupon codes conflict and failed audit rolls back coupon creation', async () => {
  const duplicate = poolFixture({ duplicate: true });
  await assert.rejects(repo.createCoupon({ code: 'dup', value: 10, expiry_date: '2027-12-31' }, {}, { pool: duplicate }), { code: 'CONFLICT' });
  assert.equal(duplicate.state.rolledBack, true);
  const auditFailure = poolFixture({ failAudit: true });
  await assert.rejects(repo.createCoupon({ code: 'audit-fail', value: 10, expiry_date: '2027-12-31' }, {}, { pool: auditFailure }), { code: 'DB_QUERY_FAILED' });
  assert.equal(auditFailure.state.rolledBack, true);
  assert.equal(auditFailure.state.committed, false);
});
