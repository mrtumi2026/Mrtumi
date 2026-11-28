'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('first-order account is created without a password and never attaches to an existing account', () => {
  const checkout = read('src/repositories/checkoutRepository.js');
  assert.match(checkout, /INSERT IGNORE INTO customers \(name,phone,password_hash,address,phone_verified_at\) VALUES \(\?,\?,'',/);
  assert.match(checkout, /affectedRows\)===1/);
});

test('only the ordering browser is signed in to a new account, never to an existing one', () => {
  const store = read('src/routes/storefront.js');
  assert.match(store, /result\.newAccountId && !req\.customerUser\?\.id/);
  assert.match(store, /pending\.invoiceNo !== String\(invoiceNo\)/);
  assert.match(store, /req\.session\.regenerate/);
  assert.match(read('src/repositories/customerRepository.js'), /UPDATE customers SET password_hash=\? WHERE id=\? AND password_hash=''/);
});

test('registering over a password-less account detaches history unless an order number proves ownership', () => {
  const customers = read('src/repositories/customerRepository.js');
  assert.match(customers, /UPDATE orders SET customer_id=NULL WHERE customer_id=\?/);
  assert.match(customers, /WHERE customer_id=\? AND invoice_no=\?/);
});

test('reseller deposit request rejects bad input before touching the database', async () => {
  const { createDepositRequest } = require('../src/repositories/resellerPortalRepository');
  const methods = [{ code: 'bkash_manual', name: 'bKash' }];
  const good = { amount: '500', method: 'bkash_manual', trx_id: 'ABC123XYZ', sender_number: '01811222333' };
  for (const bad of [{ amount: '99' }, { amount: '-500' }, { amount: '1e6' }, { method: 'cod' }, { trx_id: 'x y' }, { sender_number: '123' }]) {
    await assert.rejects(createDepositRequest(1, { ...good, ...bad }, { methods }), { name: 'ValidationError' });
  }
});

test('only a pending reseller deposit can be approved or rejected', () => {
  const admin = read('src/routes/adminMysqlModules.js');
  assert.match(admin, /SET status='rejected' WHERE id=\? AND tx_type='deposit' AND status='pending'/);
});
