'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

async function statusOf(router, method, url) {
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
    return res.status;
  } finally {
    server.close();
  }
}

test('automated gateway and legacy courier endpoints are closed, including case and slash variants', async () => {
  const payments = require('../src/routes/paymentRoutes');
  const logistics = require('../src/routes/logisticsRoutes');
  for (const url of ['/payment/nagad/callback?order_id=1&payment_ref_id=x', '/Payment/Rocket/Callback/', '/payment/bkash/callback']) {
    assert.strictEqual(await statusOf(payments, 'GET', url), 404, url);
  }
  for (const url of ['/webhooks/nagad/ipn', '/webhooks/rocket/ipn', '/payment/initiate/nagad']) {
    assert.strictEqual(await statusOf(payments, 'POST', url), 404, url);
  }
  for (const url of ['/api/courier/book', '/api/courier/webhook/steadfast', '/API/Courier/Webhook/Pathao/']) {
    assert.strictEqual(await statusOf(logistics, 'POST', url), 404, url);
  }
});

test('every checkout manual payment code is reviewable and listed for admins', () => {
  for (const file of ['src/repositories/adminManualPaymentRepository.js', 'src/repositories/adminDashboardRepository.js']) {
    for (const code of ['bkash_manual', 'nagad_manual', 'rocket_manual']) {
      assert.ok(read(file).includes(`'${code}'`), `${file} misses ${code}`);
    }
  }
});
