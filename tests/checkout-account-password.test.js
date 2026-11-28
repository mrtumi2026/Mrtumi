'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const ejs = require('ejs');
const service = require('../src/services/checkoutAccountService');
const customers = require('../src/repositories/customerRepository');

const hashed = bcrypt.hashSync('Right-Password-1', 4);
const db = (row) => ({ queryOne: async () => row });
const owner = { id: 7, name: 'Owner', phone: '01711000009', password_hash: hashed };
const allow = async () => ({ allowed: true, retryAfterSec: 1 });
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('a number without a password account orders with nothing extra', async () => {
  const result = await service.checkAccount({ phone: '01711000009' }, { db: db(null), consume: allow });
  assert.deepEqual(result, { passwordRequired: false, passwordOk: false, accountId: null });
});

test('an existing password account asks for it and only the right password proves it', async () => {
  const deps = { db: db(owner), consume: allow };
  assert.equal((await service.checkAccount({ phone: '01711000009' }, deps)).passwordRequired, true);
  assert.equal(await service.resolveCheckoutAccount({ phone: '01711000009', password: '' }, deps), null);
  assert.equal(await service.resolveCheckoutAccount({ phone: '+8801711000009', password: 'Right-Password-1' }, deps), 7);
  await assert.rejects(() => service.resolveCheckoutAccount({ phone: '01711000009', password: 'wrong' }, deps), { code: 'ACCOUNT_PASSWORD_REQUIRED' });
});

test('password tries are rate limited before the password is compared', async () => {
  const deny = async () => ({ allowed: false, retryAfterSec: 900 });
  await assert.rejects(() => service.checkAccount({ phone: '01711000009', password: 'Right-Password-1' }, { db: db(owner), consume: deny }), { code: 'RATE_LIMITED' });
});

test('every order route passes the proven account and the database layer enforces it', () => {
  const routes = read('src/routes/storefront.js');
  assert.equal((routes.match(/checkoutAccount\.resolveCheckoutAccount/g) || []).length, 3);
  assert.match(read('src/repositories/checkoutRepository.js'), /Number\(verifiedAccountId\)!==Number\(owner\.id\)\)throw new AccountPasswordError/);
});

test('the password field and its script are on checkout, quick order and campaign forms', () => {
  const html = ejs.render(read('views/store/partials/account-password.ejs'), { locale: 'bn', fieldId: 'x', columnClass: 'col-12' });
  assert.match(html, /name="account_password"/);
  assert.match(html, /js-account-pw" hidden/);
  assert.match(read('views/store/checkout.ejs'), /data-checkout-account/);
  assert.match(read('views/store/campaign.ejs'), /data-checkout-account/);
  assert.match(read('views/store/partials/footer.ejs'), /checkout-account\.js/);
});

function recoveryPool({ customer, recent = 0 }) {
  const writes = [];
  const connection = {
    async query(sql, params) { return this.execute(sql, params); },
    async execute(sql, params) {
      if (/COUNT\(\*\)/.test(sql)) return [[{ n: recent }]];
      if (/FROM customers/.test(sql)) return [customer ? [customer] : []];
      if (/^\s*SELECT id FROM customer_recovery_tokens/.test(sql)) return [[]];
      writes.push({ sql, params });
      return [{ insertId: 1, affectedRows: 1 }];
    },
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  };
  return { writes, getConnection: async () => connection, execute: (sql, params) => connection.execute(sql, params), query: (sql, params) => connection.execute(sql, params) };
}

test('SMS recovery sends a 6-digit code that expires in 10 minutes and stores only a keyed hash', async () => {
  const pool = recoveryPool({ customer: { id: 7, destination: '01711000009' } });
  let sent = null;
  await customers.issueCustomerRecovery('01711000009', 'phone', async (message) => { sent = message; }, { pool });
  assert.match(sent.token, /^\d{6}$/);
  assert.equal(sent.expiresInSeconds, 600);
  const insert = pool.writes.find((write) => /INSERT INTO customer_recovery_tokens/.test(write.sql));
  assert.match(insert.sql, /INTERVAL 10 MINUTE/);
  assert.equal(insert.params.includes(sent.token), false);
  assert.ok(pool.writes.some((write) => /SET revoked_at/.test(write.sql)), 'older codes are revoked');
});

test('one account gets at most three SMS codes an hour', async () => {
  const pool = recoveryPool({ customer: { id: 7, destination: '01711000009' }, recent: 3 });
  let sends = 0;
  const result = await customers.issueCustomerRecovery('01711000009', 'phone', async () => { sends++; }, { pool });
  assert.deepEqual(result, { accepted: true });
  assert.equal(sends, 0);
});

test('guessing SMS codes is limited per number', async () => {
  let key = '';
  await assert.rejects(
    () => customers.consumeCustomerPhoneOtp('01711000009', '123456', 'A-New-Password-1', { consume: async (options) => { key = options.bucketKey; assert.equal(options.max, 10); return { allowed: false }; } }),
    /Too many wrong codes/,
  );
  assert.match(key, /^customer-recovery-otp:[a-f0-9]{64}$/);
});

test('super admin can switch SMS recovery on from the SMS gateway page', () => {
  assert.match(read('views/admin/settings.ejs'), /name="customer_recovery_sms_enabled"/);
});
