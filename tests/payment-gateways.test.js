'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const {
  getPaymentGateway,
  BkashGateway,
  PaymentGateway,
} = require('../src/services/payments');
const { ValidationError } = require('../src/utils/errors');

describe('Payment Gateways — Bangladesh MFS (bKash, Nagad, Rocket, COD)', () => {
  test('getPaymentGateway resolves registered gateways and rejects unknown', () => {
    const bkash = getPaymentGateway('bkash_auto');
    assert.ok(bkash instanceof BkashGateway);
    assert.equal(bkash.code, 'bkash_auto');

    assert.throws(() => getPaymentGateway('unknown_payment'), ValidationError);
  });

  test('PaymentGateway validates integer paisa and non-zero amount', () => {
    const gw = new BkashGateway();

    const valid = gw.normalizeInitiateInput({
      orderId: 'ORD-PAY-1',
      invoice: 'INV-PAY-1',
      amountPaisa: 50000,
      customerName: 'Nasir Ahmed',
      customerPhone: '01711223344',
      callbackUrl: 'http://localhost:3000/callback',
    });

    assert.equal(valid.orderId, 'ORD-PAY-1');
    assert.equal(valid.amountPaisa, 50000);
    assert.equal(valid.amountBdt, '500.00');

    assert.throws(() => {
      gw.normalizeInitiateInput({
        orderId: 'ORD-PAY-1',
        amountPaisa: 0,
      });
    }, ValidationError);

    assert.throws(() => {
      gw.normalizeInitiateInput({
        orderId: 'ORD-PAY-1',
        amountPaisa: 50.5,
      });
    }, TypeError);
  });

  test('BkashGateway initiates, executes and queries payment in sandbox mock mode', async () => {
    const bkash = new BkashGateway({ sandbox: true });

    const init = await bkash.initiatePayment({
      orderId: 'ORD-BK-01',
      invoice: 'INV-BK-01',
      amountPaisa: 100000,
      customerPhone: '01711223344',
      callbackUrl: 'http://localhost:3000/checkout/payment/callback',
    });

    assert.equal(init.success, true);
    assert.equal(init.provider, 'bkash_auto');
    assert.equal(init.mode, 'sandbox_mock');
    assert.ok(init.paymentId.startsWith('BK-'));
    assert.ok(init.redirectUrl.includes(init.paymentId));

    const exec = await bkash.executePayment(init.paymentId);
    assert.equal(exec.success, true);
    assert.equal(exec.status, 'completed');
    assert.ok(exec.transactionId.startsWith('TRX'));

    const query = await bkash.queryPayment(init.paymentId);
    assert.equal(query.provider, 'bkash_auto');
    assert.equal(query.paymentId, init.paymentId);
    assert.equal(query.status, 'Completed');
  });

  test('PaymentGateway redacts sensitive API keys and secrets', () => {
    const gw = new BkashGateway();
    const sensitive = {
      app_key: 'topsecretkey123',
      app_secret: 'secretsecret',
      auth_token: 'bearer token',
      amount: '500.00',
    };
    const redacted = gw.redactSensitive(sensitive);

    assert.equal(redacted.app_key, '[REDACTED]');
    assert.equal(redacted.app_secret, '[REDACTED]');
    assert.equal(redacted.auth_token, '[REDACTED]');
    assert.equal(redacted.amount, '500.00');
  });
});
