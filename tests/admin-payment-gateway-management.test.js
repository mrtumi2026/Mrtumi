'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { normalizeUpdate } = require('../src/repositories/adminPaymentGatewayRepository');

test('payment gateway update validates receiving account, instructions, and explicit active status', () => {
  assert.deepEqual(normalizeUpdate({ account_number: '01712345678', instructions: 'Send Money then submit TrxID.', status: '1' }), {
    accountNumber: '01712345678', instructions: 'Send Money then submit TrxID.', status: 1,
  });
  assert.throws(() => normalizeUpdate({ account_number: '<script>', instructions: '', status: '1' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => normalizeUpdate({ account_number: '', instructions: '', status: 'enabled' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => normalizeUpdate({ account_number: '', instructions: 'x'.repeat(4001), status: '0' }), { code: 'VALIDATION_ERROR' });
});

test('payment gateway management routes are CSRF-protected, transactional, audited, and reachable from the sidebar', () => {
  const routes = read('src/routes/adminSettings.js');
  assert.match(routes, /router\.get\('\/admin\/payment-gateways'/);
  assert.match(routes, /router\.post\('\/admin\/payment-gateways\/:id\/update',requireCsrf/);
  assert.match(routes, /adminPaymentGatewayRepository\.updatePaymentGateway/);
  const repository = read('src/repositories/adminPaymentGatewayRepository.js');
  assert.match(repository, /FROM payment_gateways WHERE id=\? FOR UPDATE/);
  assert.match(repository, /recordAuditLog/);
  assert.match(repository, /payment_gateway\.updated/);
  assert.match(repository, /Configure both the receiving account number and customer instructions before activating/);
  const view = read('views/admin/payment-gateways.ejs');
  assert.match(view, /name="account_number"/);
  assert.match(view, /name="instructions"/);
  assert.match(view, /name="status"/);
  assert.match(view, /Save Changes/);
  assert.match(read('views/admin/partials/sidebar.ejs'), /href="\/admin\/payment-gateways"[^\n]*credit-card/);
  assert.match(read('src/middleware/legacyAdminRbac.js'), /has\(path,'\/admin\/payment-gateways'\).*integrations\.manage/);
});
