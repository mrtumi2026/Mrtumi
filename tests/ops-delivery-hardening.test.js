'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');
const { auditSecretPresence } = require('../scripts/diagnose-production');

test('OPS-01 & OPS-02: Universal secret redaction masks OTP, recovery tokens and Bearer auth', () => {
  const payload = {
    recovery_token: 'super-secret-token-12345',
    phone_otp: '654321',
    pin: '9999',
    user_password: 'plainPassword123',
    authorization: 'Bearer secret_access_token_abc',
    phone: '01712345678',
    email: 'customer@example.com',
  };

  const redacted = logger.redactValue(payload);

  assert.equal(redacted.recovery_token, '[REDACTED]', 'recovery_token must be redacted');
  assert.equal(redacted.phone_otp, '[REDACTED]', 'phone_otp must be redacted');
  assert.equal(redacted.pin, '[REDACTED]', 'pin must be redacted');
  assert.equal(redacted.user_password, '[REDACTED]', 'passwords must be redacted');
  assert.equal(redacted.authorization, '[REDACTED]', 'authorization header must be redacted');
  assert.equal(redacted.phone, '01712****78', 'Bangladesh phone numbers must be masked');
  assert.equal(redacted.email, '[REDACTED]', 'email addresses must be redacted');
});

test('OPS-02: maskSensitiveText replaces Bearer headers and email addresses in prose', () => {
  const text = 'User login failed with header Bearer abcdef123456 for test.user@mrtumi.com';
  const clean = logger.maskSensitiveText ? logger.maskSensitiveText(text) : text;
  // Test either via maskSensitiveText or logger.info message
  const entry = logger.info(text);
  assert.ok(entry.msg.includes('Bearer [REDACTED_SECRET]') || !entry.msg.includes('abcdef123456'));
  assert.ok(entry.msg.includes('[REDACTED_EMAIL]') || !entry.msg.includes('test.user@mrtumi.com'));
});

test('OPS-03: Production diagnostic audit reports secret presence without disclosing values', () => {
  const audit = auditSecretPresence();
  assert.ok(typeof audit === 'object');
  assert.ok('SESSION_SECRET' in audit);
  assert.ok('CSRF_SECRET' in audit);
  assert.ok('DB_PASS' in audit);

  // Assert that values are ONLY status strings, never actual secret strings
  for (const [k, status] of Object.entries(audit)) {
    assert.ok(
      status === 'CONFIGURED' || status === 'NOT_CONFIGURED',
      `Audit for ${k} must be CONFIGURED or NOT_CONFIGURED, got ${status}`
    );
  }
});
