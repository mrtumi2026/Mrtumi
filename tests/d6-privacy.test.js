'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const privacy = require('../src/repositories/privacyRepository');
const { policyForAdminRoute } = require('../src/middleware/legacyAdminRbac');
const { loadMigrationPairs } = require('../src/db/migrator');

test('D6 privacy request and consent validators fail closed before database access', async () => {
  assert.deepEqual([...privacy.CONSENT_KEYS].sort(), ['analytics', 'marketing']);
  assert.deepEqual([...privacy.REQUEST_TYPES].sort(), ['access', 'consent_withdrawal', 'correction', 'deletion']);
  await assert.rejects(() => privacy.setConsent(1, 'essential_orders', 'withdraw'), (err) => err.message === 'Privacy workflows require MySQL.');
  assert.throws(() => privacy.validateCorrection({ name: '  ' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => privacy.validateCorrection({ phone: '123' }), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(privacy.validateCorrection({ email: '' }), { email: null });
});

test('D6 customer/admin request reads bind to customer ownership and admin mutations use privacy-specific permissions', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/repositories/privacyRepository'), 'utf8');
  assert.match(source, /WHERE id=\? AND customer_id=\?/);
  assert.match(source, /WHERE customer_id=\? ORDER BY id DESC/);
  assert.equal(policyForAdminRoute('GET', '/admin/privacy/policies').key, 'privacy.manage');
  assert.equal(policyForAdminRoute('POST', '/admin/privacy/requests/12/anonymize').key, 'privacy.review');
  assert.equal(policyForAdminRoute('POST', '/admin/privacy/policies/3/publish').key, 'privacy.manage');
  for (const pair of loadMigrationPairs().filter((row) => Number(row.version) >= 12)) {
    assert.match(pair.upSql, /customer_recovery_tokens/);
    assert.match(pair.downSql, /customer_recovery_tokens/);
    assert.match(pair.upSql, /privacy_policy_publication_history/);
  }
});

test('D6 privacy forms and admin mutations include CSRF guards', () => {
  const customerRoutes = require('node:fs').readFileSync(require.resolve('../src/routes/customerAccount'), 'utf8');
  const adminRoutes = require('node:fs').readFileSync(require.resolve('../src/routes/adminPrivacy'), 'utf8');
  assert.match(customerRoutes, /router\.post\('\/customer\/account\/privacy-requests', requireCustomer, requireCsrf/);
  assert.match(customerRoutes, /router\.post\('\/customer\/account\/privacy\/consents', requireCustomer, requireCsrf/);
  assert.match(adminRoutes, /router\.post\('\/admin\/privacy\/requests\/:id\/anonymize', requirePermission\('privacy\.review'\), requireCsrf/);
  assert.match(adminRoutes, /router\.post\('\/admin\/privacy\/policies\/:id\/publish', requirePermission\('privacy\.manage'\), requireCsrf/);
  for (const path of ['../views/customer/privacy-requests.ejs','../views/admin/privacy/policies.ejs','../views/admin/privacy/request-detail.ejs']) {
    const view=require('node:fs').readFileSync(require('node:path').join(__dirname,path),'utf8');
    assert.match(view,/name="_csrf"/);
  }
});

test('D6 storefront receipt lookup is session-bound and anonymous invoice/phone lookup no longer returns order data', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/routes/storefront'), 'utf8');
  assert.match(source, /checkoutLastInvoice \|\| ''\) !== String\(req\.params\.invoiceId/);
  assert.match(source, /Order details are available only in the authenticated, ownership-scoped customer account/);
  assert.doesNotMatch(source, /SELECT \* FROM orders WHERE invoice_id = \? OR phone = \?/);
  assert.doesNotMatch(source, /Courier Tracking: '\\n• Courier Tracking/);
  const vendorRepository=require('node:fs').readFileSync(require.resolve('../src/repositories/vendorPortalRepository'),'utf8');
  assert.doesNotMatch(vendorRepository,/o\.customer_name|customer_phone|shipping_address/);
  const legacyVendor=require('node:fs').readFileSync(require.resolve('../src/routes/vendorPanel'),'utf8');
  assert.doesNotMatch(legacyVendor,/o\.customer_name, o\.phone, o\.address/);
});
