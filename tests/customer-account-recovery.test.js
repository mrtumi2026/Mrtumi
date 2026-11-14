'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const customerRecoveryService = require('../src/services/customerRecoveryService');
const customerRepository = require('../src/repositories/customerRepository');

test('Customer Recovery: Service audits provider readiness and remains safely disabled by default', async () => {
  const status = await customerRecoveryService.getRecoveryProviderStatus();
  assert.equal(typeof status.enabled, 'boolean');
  assert.ok(Array.isArray(status.availableChannels));
  assert.ok(status.sms);
  assert.ok(status.email);
  assert.equal(status.sms.gateway, 'BulkSMSBD');
  assert.equal(status.email.gateway, 'SMTP');
  assert.ok(Array.isArray(status.sms.missing));
  assert.ok(Array.isArray(status.email.missing));

  if (status.sms.missing.length > 0 && status.email.missing.length > 0) {
    assert.equal(status.enabled, false, 'Recovery must be disabled when providers are unconfigured');
  }
});

test('Customer Recovery: Delivery adapter throws safely when provider is disabled or unconfigured', async () => {
  await assert.rejects(
    () => customerRecoveryService.deliverRecoveryMessage({
      channel: 'phone',
      destination: '01711223344',
      token: 'test-token',
    }),
    /disabled|missing/i,
    'Unconfigured phone delivery must throw rather than faking delivery'
  );

  await assert.rejects(
    () => customerRecoveryService.deliverRecoveryMessage({
      channel: 'email',
      destination: 'user@example.test',
      token: 'test-token',
    }),
    /disabled|missing|pending/i,
    'Unconfigured email delivery must throw rather than faking delivery'
  );

  await assert.rejects(
    () => customerRecoveryService.deliverRecoveryMessage({
      channel: 'unsupported',
      destination: 'user',
      token: 'test-token',
    }),
    /Invalid recovery channel/,
    'Invalid channel must be rejected'
  );
});

test('Customer Recovery: Account form includes direct link to /customer/recovery', () => {
  const formPath = path.join(__dirname, '..', 'views', 'customer', 'account-form.ejs');
  const template = fs.readFileSync(formPath, 'utf8');

  assert.match(
    template,
    /\/customer\/recovery/,
    'account-form.ejs must include link to /customer/recovery'
  );

  assert.ok(template.includes('পাসওয়ার্ড ভুলে গেছেন?'), 'Template must include Bangla forgot password link');
  assert.ok(template.includes('Forgot password?'), 'Template must include English forgot password link');

  // Verify template compiles without syntax errors
  assert.doesNotThrow(
    () => ejs.compile(template, { filename: formPath }),
    'account-form.ejs must compile cleanly'
  );
});

test('Customer Recovery: recovery.ejs and recovery-reset.ejs compile cleanly without exposing tokens', () => {
  const recoveryPath = path.join(__dirname, '..', 'views', 'customer', 'recovery.ejs');
  const resetPath = path.join(__dirname, '..', 'views', 'customer', 'recovery-reset.ejs');

  const recoveryTpl = fs.readFileSync(recoveryPath, 'utf8');
  const resetTpl = fs.readFileSync(resetPath, 'utf8');

  assert.match(recoveryTpl, /name="_csrf"/);
  assert.match(resetTpl, /name="_csrf"/);

  assert.doesNotMatch(recoveryTpl, /ফল\s*বাজার/);
  assert.doesNotMatch(resetTpl, /ফল\s*বাজার/);

  assert.doesNotThrow(() => ejs.compile(recoveryTpl, { filename: recoveryPath }));
  assert.doesNotThrow(() => ejs.compile(resetTpl, { filename: resetPath }));
});

test('Customer Recovery: Anti-enumeration returns accepted: true for unverified, missing, or malformed accounts', async () => {
  let deliveredMessage = null;
  const mockDeliver = async (msg) => {
    deliveredMessage = msg;
  };

  // 1. Completely invalid/malformed phone number
  const resInvalid = await customerRepository.issueCustomerRecovery('not-a-phone', 'phone', mockDeliver);
  assert.deepEqual(resInvalid, { accepted: true }, 'Invalid phone must return accepted: true without throwing');
  assert.equal(deliveredMessage, null, 'No message should be delivered for invalid phone');

  // 2. Invalid email format
  const resInvalidEmail = await customerRepository.issueCustomerRecovery('invalid-email', 'email', mockDeliver);
  assert.deepEqual(resInvalidEmail, { accepted: true }, 'Invalid email must return accepted: true');
  assert.equal(deliveredMessage, null, 'No message should be delivered for invalid email');

  // 3. Mock pool for non-existent or unverified accounts
  const mockPool = {
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: async () => [[]],
    }),
  };

  const resMissing = await customerRepository.issueCustomerRecovery('01799999999', 'phone', mockDeliver, { pool: mockPool });
  assert.deepEqual(resMissing, { accepted: true }, 'Missing account must return accepted: true');
  assert.equal(deliveredMessage, null, 'No message should be delivered for non-existent account');
});

test('Customer Recovery: Token logging redaction protects recovery tokens in sms_logs', async () => {
  const smsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'smsService.js'), 'utf8');
  assert.match(
    smsSource,
    /templateKey\s*===\s*'customer_recovery'/,
    'smsService must detect customer_recovery template'
  );
  assert.match(
    smsSource,
    /REDACTED_SECRET/,
    'smsService must redact recovery token secrets from message previews'
  );
});

test('Customer Recovery: URL query stripping redirect preserves clean browser address bar', () => {
  const customerRoutesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'customerAccount.js'), 'utf8');

  assert.match(
    customerRoutesSource,
    /if\s*\(req\.query\.token\)\s*\{[\s\S]*?req\.session\.pendingRecoveryToken\s*=[\s\S]*?return res\.redirect\('\/customer\/recovery\/reset'\);/,
    'GET /customer/recovery/reset must sanitize query token into session and redirect to clean URL'
  );

  assert.match(customerRoutesSource, /router\.post\('\/customer\/recovery',\s*recoveryLimiter/);
  assert.match(customerRoutesSource, /router\.post\('\/customer\/recovery\/reset',\s*resetLimiter/);
});

test('Customer Recovery: GET routes render safely without TypeError on req.flash', async () => {
  const express = require('express');
  const app = express();
  const repoRoot = path.join(__dirname, '..');
  app.set('views', path.join(repoRoot, 'views'));
  app.set('view engine', 'ejs');

  app.use((req, res, next) => {
    req.session = { cart: [] };
    req.locale = 'en';
    res.locals.locale = 'en';
    res.locals.currentPath = req.path;
    res.locals.currentUrl = req.originalUrl;
    res.locals.t = (k) => k;
    res.locals.siteSettings = {};
    res.locals.navCategories = [];
    res.locals.footerPages = [];
    res.locals.storeFeatures = [];
    res.locals.socialLinks = [];
    res.locals.cart = [];
    res.locals.cartCount = 0;
    res.locals.cartSubtotal = 0;
    res.locals.flash = null;
    res.locals.customerUser = null;
    res.locals.brand = {};
    res.locals.sessionToken = 'token';
    res.locals.mysqlCheckoutEnabled = true;

    // Middleware flash implementation matching src/middleware/auth.js
    req.flash = (type, message) => {
      if (typeof message === 'undefined') {
        return (res.locals.flash && res.locals.flash.type === type) ? [res.locals.flash.message] : [];
      }
      req.session.flash = { type, message };
    };
    next();
  });

  const customerAccountRoutes = require('../src/routes/customerAccount');
  app.use(customerAccountRoutes);

  let capturedError = null;
  app.use((err, req, res, next) => {
    capturedError = err;
    res.status(500).send('Error');
  });

  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/customer/recovery`);
    assert.equal(capturedError, null, 'GET /customer/recovery must not throw errors');
    assert.equal(res.status, 200, 'GET /customer/recovery must return 200 OK');
    const body = await res.text();
    assert.ok(body.includes('Account Recovery') || body.includes('Account recovery'));

    const resReset = await fetch(`http://127.0.0.1:${port}/customer/recovery/reset`);
    assert.equal(capturedError, null, 'GET /customer/recovery/reset must not throw errors');
    assert.equal(resReset.status, 200, 'GET /customer/recovery/reset must return 200 OK');
  } finally {
    server.close();
  }
});
