'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const facebookCapiService = require('../src/services/facebookCapiService');
const orderOtpService = require('../src/services/orderOtpService');

test('facebookCapiService normalizes BD phone numbers and computes sha256', () => {
  const norm = facebookCapiService.normalizeBdPhoneForCapi('01712345678');
  assert.equal(norm, '8801712345678');

  const hashed = facebookCapiService.sha256('8801712345678');
  const expectedHash = crypto.createHash('sha256').update('8801712345678').digest('hex');
  assert.equal(hashed, expectedHash);
});

test('facebookCapiService skips cleanly when not configured or disabled', async () => {
  const res = await facebookCapiService.sendCapiEvent({
    eventName: 'Purchase',
    phone: '01712345678',
    customerName: 'Test Customer',
    customData: { value: 1200, currency: 'BDT' }
  });
  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
});

test('header.ejs contains GTM, Facebook Pixel, and TikTok Pixel conditional scripts', () => {
  const header = read('views/store/partials/header.ejs');
  assert.match(header, /gtm_id/);
  assert.match(header, /googletagmanager\.com\/gtm\.js\?id=/);
  assert.match(header, /googletagmanager\.com\/ns\.html\?id=/);

  assert.match(header, /fb_pixel_id/);
  assert.match(header, /connect\.facebook\.net\/en_US\/fbevents\.js/);
  assert.match(header, /fbq\('init'/);
  assert.match(header, /fbq\('track', 'PageView'\)/);

  assert.match(header, /tiktok_pixel_id/);
  assert.match(header, /analytics\.tiktok\.com\/i18n\/pixel\/events\.js/);
  assert.match(header, /ttq\.load\(/);
  assert.match(header, /ttq\.page\(\)/);
});

test('order success views contain Purchase tracking for FB Pixel and TikTok Pixel', () => {
  const orderSuccess = read('views/store/order-success.ejs');
  assert.match(orderSuccess, /fbq\('track', 'Purchase'/);
  assert.match(orderSuccess, /ttq\.track\('CompletePayment'/);

  const orderSuccessMysql = read('views/store/order-success-mysql.ejs');
  assert.match(orderSuccessMysql, /fbq\('track', 'Purchase'/);
  assert.match(orderSuccessMysql, /ttq\.track\('CompletePayment'/);
});

test('checkout.ejs contains OTP modal, inputs, and validation logic', () => {
  const checkout = read('views/store/checkout.ejs');
  assert.match(checkout, /id="orderOtpModal"/);
  assert.match(checkout, /id="orderOtpInput"/);
  assert.match(checkout, /id="btnVerifyOtp"/);
  assert.match(checkout, /id="btnResendOtp"/);
  assert.match(checkout, /\/api\/checkout\/send-otp/);
  assert.match(checkout, /\/api\/checkout\/verify-otp/);
});

test('storefront.js declares order OTP endpoints', () => {
  const storefront = read('src/routes/storefront.js');
  assert.match(storefront, /router\.post\('\/api\/checkout\/send-otp'/);
  assert.match(storefront, /router\.post\('\/api\/checkout\/verify-otp'/);
  assert.match(storefront, /router\.get\('\/api\/checkout\/otp-status'/);
});

test('orderOtpService generates 6 digit code and HMAC digests', () => {
  const code = orderOtpService.makeOtp();
  assert.match(code, /^\d{6}$/);

  const digest = orderOtpService.otpDigest('01712345678', code);
  assert.equal(typeof digest, 'string');
  assert.equal(digest.length, 64);
});

test('orderOtpService request and verify flow works in dev/test environment', async () => {
  const testPhone = '01719876543';
  const reqRes = await orderOtpService.requestCheckoutOtp({
    phone: testPhone,
    sessionSid: 'test_session_id_12345678901234567890123456'
  });

  assert.equal(reqRes.success, true);
  assert.equal(reqRes.phone, testPhone);
  assert.ok(reqRes.devCode);
  assert.match(reqRes.devCode, /^\d{6}$/);

  // Attempt verification with invalid code
  await assert.rejects(
    async () => {
      await orderOtpService.verifyCheckoutOtp({
        phone: testPhone,
        code: '000000',
        sessionSid: 'test_session_id_12345678901234567890123456'
      });
    },
    /ভুল ওটিপি কোড/
  );

  // Attempt verification with correct code
  const verifyRes = await orderOtpService.verifyCheckoutOtp({
    phone: testPhone,
    code: reqRes.devCode,
    sessionSid: 'test_session_id_12345678901234567890123456'
  });
  assert.equal(verifyRes.success, true);
});
