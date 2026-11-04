'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adminAccess = require('../src/repositories/adminAccessRepository');

function rolePool() {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push(['BEGIN', []]); },
    async commit() { calls.push(['COMMIT', []]); },
    async rollback() { calls.push(['ROLLBACK', []]); },
    release() {},
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (/SELECT id,name,slug,status FROM roles/.test(sql)) return [[{ id: 7, name: 'Role manager', slug: 'role_manager', status: 1 }], []];
      if (/SELECT p\.name FROM role_permissions/.test(sql)) return [[], []];
      if (/SELECT name,id FROM permissions/.test(sql)) return [params.map((name, index) => ({ name, id: index + 1 })), []];
      if (/SELECT id FROM permissions/.test(sql)) return [[{ id: 1 }], []];
      return [{ affectedRows: 1, insertId: 12 }, []];
    },
  };
  return { calls, pool: { async getConnection() { return connection; } } };
}

test('admin role manager cannot grant permissions to their own role', async () => {
  const { calls, pool } = rolePool();
  await assert.rejects(
    adminAccess.setRolePermissions(7, ['staff.manage', 'roles.grants.manage'], { id: 21, roleId: 7 }, { pool }),
    (error) => error.code === 'CONFLICT'
  );
  assert.equal(calls.some(([sql]) => typeof sql === 'string' && /DELETE FROM role_permissions/.test(sql)), false);
  assert.ok(calls.some(([sql]) => typeof sql === 'string' && /FROM roles WHERE id=\? FOR UPDATE/.test(sql)));
});

test('admin role manager may still configure a different non-super-admin role', async () => {
  const { calls, pool } = rolePool();
  const result = await adminAccess.setRolePermissions(7, ['staff.manage'], { id: 21, roleId: 9 }, { pool });
  assert.deepEqual(result, { roleId: 7, permissions: ['staff.manage'] });
  assert.ok(calls.some(([sql]) => typeof sql === 'string' && /INSERT INTO role_permissions/.test(sql)));
  assert.ok(calls.some(([sql]) => sql === 'COMMIT'));
});
