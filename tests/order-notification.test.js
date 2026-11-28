'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Each test file runs in its own process; no database is contacted here.
Object.assign(process.env, { DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_NAME: 'unused', DB_USER: 'unused', DB_PASSWORD: 'unused' });
const mysql = require('../src/db/mysqlPool');
const smsService = require('../src/services/smsService');
const pushService = require('../src/services/pushNotificationService');
const capiService = require('../src/services/facebookCapiService');
const checkoutRepository = require('../src/repositories/checkoutRepository');

const INPUT = {
  customer_name: 'Notification Test',
  phone: '01712345678',
  address: 'Test address, Dhaka',
  delivery_location_id: 1,
  payment_method: 'cod',
};
const OPTIONS = { requestKey: 'notification-test-key', cart: [{ product_id: 1, qty: 1 }] };

async function placeWith(committed) {
  const saved = {
    tx: mysql.withTransaction,
    sms: smsService.sendOrderPlacedSms,
    push: pushService.notifyPartnerNewOrder,
    capi: capiService.sendOrderPurchaseEvent,
  };
  const sent = { sms: [], push: [], capi: [] };
  mysql.withTransaction = async () => committed;
  smsService.sendOrderPlacedSms = (event) => sent.sms.push(event);
  pushService.notifyPartnerNewOrder = (event) => sent.push.push(event);
  capiService.sendOrderPurchaseEvent = (event) => sent.capi.push(event);
  try {
    return { result: await checkoutRepository.createOrder(INPUT, OPTIONS), sent };
  } finally {
    mysql.withTransaction = saved.tx;
    smsService.sendOrderPlacedSms = saved.sms;
    pushService.notifyPartnerNewOrder = saved.push;
    capiService.sendOrderPurchaseEvent = saved.capi;
  }
}

test('a committed MySQL order triggers the order SMS and the other order notifications once', async () => {
  const order = { id: 7, invoiceNo: 'MT-NOTIFY', replayed: false, totalPaisa: 8000 };
  const { result, sent } = await placeWith(order);
  assert.deepEqual(result, order);
  assert.equal(sent.sms.length, 1);
  assert.equal(sent.sms[0].invoiceNo, 'MT-NOTIFY');
  assert.equal(sent.sms[0].phone, '01712345678');
  assert.equal(sent.sms[0].totalAmount, '80');
  assert.equal(sent.push.length, 1);
  assert.equal(sent.capi.length, 1);
});

test('a replayed checkout request sends nothing again', async () => {
  const { sent } = await placeWith({ id: 7, invoiceNo: 'MT-NOTIFY', replayed: true });
  assert.deepEqual(sent, { sms: [], push: [], capi: [] });
});
