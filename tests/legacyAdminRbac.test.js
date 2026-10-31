'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { legacyAdminRbac, policyForAdminRoute } = require('../src/middleware/legacyAdminRbac');

function authorize(method, path, permissions = [], role = 'staff') {
  const req = {
    method,
    path,
    adminUser: { role_name: role, role_slug: role.toLowerCase().replace(/\s+/g, '_'), permissions },
  };
  let error = null;
  legacyAdminRbac(req, {}, (nextError) => { error = nextError || null; });
  return error ? error.message : null;
}

test('D7 return routes are mapped to review permission and grant a super admin access', () => {
  assert.equal(policyForAdminRoute('GET', '/admin/d7/returns').key, 'returns.review');
  assert.equal(policyForAdminRoute('POST', '/admin/d7/returns/17/decision').key, 'returns.review');
  assert.equal(authorize('GET', '/admin/d7/returns', ['returns.review']), null);
  assert.equal(authorize('GET', '/admin/d7/returns', [], 'Super Admin'), null);
  assert.equal(authorize('GET', '/admin/d7/returns', []), 'Insufficient permissions for this admin route.');
});

test('D7 settlement list accepts either prepare or approve, while writes remain separately scoped', () => {
  assert.deepEqual(policyForAdminRoute('GET', '/admin/d7/settlements').anyOf, ['settlements.prepare', 'settlements.approve']);
  assert.equal(policyForAdminRoute('POST', '/admin/d7/settlements/prepare').key, 'settlements.prepare');
  assert.equal(policyForAdminRoute('POST', '/admin/d7/settlements/adjustments/4/decision').key, 'settlements.approve');
  assert.equal(policyForAdminRoute('POST', '/admin/d7/settlements/8/approve').key, 'settlements.approve');
  assert.equal(authorize('GET', '/admin/d7/settlements', ['settlements.prepare']), null);
  assert.equal(authorize('GET', '/admin/d7/settlements', ['settlements.approve']), null);
  assert.equal(authorize('GET', '/admin/d7/settlements'), 'Insufficient permissions for this admin route.');
  assert.equal(authorize('POST', '/admin/d7/settlements/prepare', ['settlements.approve']), 'Insufficient permissions for this admin route.');
  assert.equal(authorize('POST', '/admin/d7/settlements/adjustments/4/decision', ['settlements.prepare']), 'Insufficient permissions for this admin route.');
  assert.equal(authorize('POST', '/admin/d7/settlements/prepare', ['settlements.prepare']), null);
  assert.equal(authorize('POST', '/admin/d7/settlements/adjustments/4/decision', ['settlements.approve']), null);
});
