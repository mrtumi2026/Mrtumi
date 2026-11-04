'use strict';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'mysql';
process.env.LOG_SILENT = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const vendorOnboarding = require('../src/repositories/vendorOnboardingRepository');
const resellerPortal = require('../src/repositories/resellerPortalRepository');

function fakePool(passwordHash) {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push(['BEGIN', []]); },
    async commit() { calls.push(['COMMIT', []]); },
    async rollback() { calls.push(['ROLLBACK', []]); },
    release() {},
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (/FROM vendors WHERE id=\? FOR UPDATE/.test(sql)) return [[{ id: 31, email: 'vendor@example.test', password_hash: passwordHash, lifecycle_status: 'active', status: 1 }], []];
      if (/SELECT id FROM vendors WHERE email=/.test(sql)) return [[], []];
      if (/FROM resellers WHERE id=\? AND status=1 FOR UPDATE/.test(sql)) return [[{ id: 41, name: 'Reseller', shop_name: 'Reseller Shop', email: 'reseller@example.test', password_hash: passwordHash }], []];
      if (/SELECT id FROM permissions/.test(sql)) return [[{ id: 1 }], []];
      return [{ affectedRows: 1, insertId: 9 }, []];
    },
  };
  return { calls, pool: { async getConnection() { return connection; } } };
}

const oldPassword = 'Existing-Password-2026';
const newPassword = 'Replacement-Password-2026';

test('Vendor password change requires current password and revokes other DB sessions atomically', async () => {
  const passwordHash = await bcrypt.hash(oldPassword, 4);
  const invalid = fakePool(passwordHash);
  await assert.rejects(vendorOnboarding.updateVendorProfile(31, {
    shop_name: 'Vendor', owner_name: 'Owner', email: 'vendor@example.test', address: 'Dhaka',
    district: 'Comilla', upazila: 'Debidwar', new_password: newPassword,
  }, { sessionId: 'current-session', currentPassword: 'wrong-password' }, { pool: invalid.pool }), { code: 'CONFLICT' });
  assert.equal(invalid.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE vendors SET')), false);

  const valid = fakePool(passwordHash);
  await vendorOnboarding.updateVendorProfile(31, {
    shop_name: 'Vendor', owner_name: 'Owner', email: 'vendor@example.test', address: 'Dhaka',
    district: 'Comilla', upazila: 'Debidwar', new_password: newPassword,
  }, { sessionId: 'current-session', currentPassword: oldPassword }, { pool: valid.pool });
  const revoke = valid.calls.find(([sql]) => typeof sql === 'string' && sql.includes("DELETE FROM web_sessions WHERE actor_type='vendor'"));
  assert.deepEqual(revoke[1], [31, 'current-session']);
  assert.ok(valid.calls.some(([sql]) => sql === 'COMMIT'));
});

test('Reseller password change requires current password and revokes other DB sessions atomically', async () => {
  const passwordHash = await bcrypt.hash(oldPassword, 4);
  const invalid = fakePool(passwordHash);
  await assert.rejects(resellerPortal.updateProfile(41, {
    name: 'Reseller', shop_name: 'Shop', email: 'reseller@example.test', new_password: newPassword,
  }, { sessionId: 'current-session', currentPassword: 'wrong-password', pool: invalid.pool }), { code: 'CONFLICT' });
  assert.equal(invalid.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE resellers SET')), false);

  const valid = fakePool(passwordHash);
  await resellerPortal.updateProfile(41, {
    name: 'Reseller', shop_name: 'Shop', email: 'reseller@example.test', new_password: newPassword,
  }, { sessionId: 'current-session', currentPassword: oldPassword, pool: valid.pool });
  const revoke = valid.calls.find(([sql]) => typeof sql === 'string' && sql.includes("DELETE FROM web_sessions WHERE actor_type='reseller'"));
  assert.deepEqual(revoke[1], [41, 'current-session']);
  assert.ok(valid.calls.some(([sql]) => sql === 'COMMIT'));
});
