'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pushService = require('../src/services/pushNotificationService');
const sqliteDb = require('../src/db/database');

test.before(() => {
  sqliteDb.initializeDatabase();
});

test('Push Notification System - Device token registration', async () => {
  const token = `fcm_test_token_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const reg = await pushService.registerDeviceToken({
    token,
    appType: 'customer',
    platform: 'android',
    topic: 'customer_offers',
  });

  assert.ok(reg && reg.success, 'Device token registered successfully');

  // Re-registration of same token updates last_seen
  const reReg = await pushService.registerDeviceToken({
    token,
    appType: 'customer',
    platform: 'android',
    topic: 'customer_offers',
  });
  assert.ok(reReg && reReg.success, 'Device token update succeeded');
});

test('Push Notification System - Broadcast offer notification to customer app', async () => {
  // Ensure at least one token exists
  await pushService.registerDeviceToken({
    token: `token_for_broadcast_${Date.now()}`,
    appType: 'customer',
    platform: 'android',
  });

  const broadcast = await pushService.broadcastOfferNotification({
    title: '🔥 মেগা ডিসকাউন্ট অফার!',
    body: 'আজকের স্পেশাল অফারে যেকোনো অর্ডারে পাচ্ছেন ১০% ক্যাশব্যাক!',
    deepLink: '/campaign/mega-sale',
    appType: 'customer',
  });

  assert.ok(broadcast && broadcast.success, 'Broadcast sent successfully');
  assert.ok(broadcast.recipients >= 1, 'Recipients count is at least 1');
  assert.equal(broadcast.title, '🔥 মেগা ডিসকাউন্ট অফার!');
});

test('Push Notification System - Customer order status update formatting', async () => {
  const statusRes = await pushService.notifyCustomerOrderStatus({
    orderId: 1001,
    invoiceNo: 'MT-TESTINV-1',
    status: 'shipped',
  });

  assert.ok(statusRes && statusRes.success, 'Order status push dispatched');
  assert.ok(statusRes.title.includes('MT-TESTINV-1'), 'Title contains invoice number');
  assert.ok(statusRes.body.includes('কুরিয়ারে হস্তান্তর'), 'Body contains localized shipped notice');
});

test('Push Notification System - Partner new order chime notification', async () => {
  const partnerRes = await pushService.notifyPartnerNewOrder({
    orderId: 2002,
    invoiceNo: 'MT-TESTINV-2',
    totalBdt: 1250,
    vendorId: 5,
  });

  assert.ok(partnerRes && partnerRes.success, 'Partner new order push dispatched');
  assert.ok(partnerRes.title.includes('নতুন অর্ডার'), 'Title contains new order alert');
  assert.ok(partnerRes.body.includes('1250'), 'Body includes total order amount');
});
