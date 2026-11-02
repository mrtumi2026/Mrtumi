'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

 test('manual MFS checkout requires sender and TrxID and persists full payment for verification', () => {
  const repository = read('src/repositories/checkoutRepository.js');
  assert.match(repository, /manualBrand=paymentMethod\.replace\(\/\^manual_\/,''\)/);
  assert.match(repository, /requireString\(input\.trx_id,'Transaction ID'/);
  assert.match(repository, /normalizeBdPhone\(input\.sender_number,'sender mobile number'\)/);
  assert.match(repository, /paymentStatus=isManualPayment\?'pending_verification':'unpaid'/);
  assert.match(repository, /INSERT INTO order_payments[\s\S]*'pending_verification'/);
  assert.match(repository, /const codDue=isManualPayment\?0:total/);
  const routes = read('src/routes/storefront.js');
  assert.match(routes, /router\.get\('\/api\/checkout\/payment-methods'/);
  assert.match(routes, /payment_method:req\.body\.payment_method\|\|'cod'/);
  assert.match(routes, /trx_id:req\.body\.trx_id/);
});

test('checkout and quick-order show localized area labels and configured manual gateway instructions', () => {
  const checkout = read('views/store/checkout.ejs');
  const footer = read('views/store/partials/footer.ejs');
  const script = read('public/frontEnd/js/storefront.js');
  assert.match(checkout, /Choose delivery area/);
  assert.match(checkout, /ডেলিভারি এলাকা নির্বাচন করুন/);
  assert.match(checkout, /Inside Dhaka/);
  assert.match(checkout, /ঢাকার ভিতরে/);
  assert.doesNotMatch(checkout, /join\(' \/ '\)/);
  assert.match(checkout, /name="sender_number" id="ckSenderNumber"/);
  assert.match(checkout, /name="trx_id" id="ckTrxId"/);
  assert.match(footer, /id="qoPaymentMethod"/);
  assert.match(footer, /id="qoSenderNumber"/);
  assert.match(footer, /id="qoTrxId"/);
  assert.match(script, /loadQuickOrderPaymentMethods\(\)/);
  assert.match(script, /location\.division === 'Dhaka' \|\| location\.division === 'All'/);
  assert.match(script, /areaLabel \+ ' \(৳'/);
  assert.match(script, /option\.dataset\.instructions/);
  assert.doesNotMatch(script, /join\(', '\) \+ ' — ৳'/);
});

test('pending action center has CSRF-protected review actions and counts linked review queues', () => {
  const repo = read('src/repositories/adminDashboardRepository.js');
  assert.match(repo, /op\.status='pending_verification'/);
  assert.match(repo, /lifecycle_status='pending'/);
  assert.match(repo, /approval_status='pending'/);
  const actions = read('src/routes/adminOperations.js');
  assert.match(actions, /payment-records\/:id\/approve',requireCsrf/);
  assert.match(actions, /payment-records\/:id\/reject',requireCsrf/);
  const mutation = read('src/repositories/adminManualPaymentRepository.js');
  assert.match(mutation, /UPDATE orders SET payment_status='paid',paid_paisa=\?,cod_due_paisa=0/);
  assert.match(mutation, /status='rejected'/);
  const dashboard = read('views/admin/dashboard.ejs');
  for (const route of ['/admin/vendor-applications?status=pending', '/admin/products/pending', '/admin/order/pending']) assert.ok(dashboard.includes(route));
  assert.match(dashboard, /Approve Payment/);
  assert.match(dashboard, />Reject</);
});
