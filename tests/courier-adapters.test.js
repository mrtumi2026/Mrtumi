'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { getCourierAdapter, SteadfastAdapter, PathaoAdapter, CourierAdapter } = require('../src/services/courier');
const { ValidationError, ConflictError } = require('../src/utils/errors');

describe('Phase 10 — Courier Adapters (Steadfast & Pathao)', () => {
  test('getCourierAdapter resolves registered adapters and rejects unknown', () => {
    const steadfast = getCourierAdapter('steadfast');
    assert.ok(steadfast instanceof SteadfastAdapter);
    assert.equal(steadfast.code, 'steadfast');

    const pathao = getCourierAdapter('pathao');
    assert.ok(pathao instanceof PathaoAdapter);
    assert.equal(pathao.code, 'pathao');

    assert.throws(() => getCourierAdapter('unknown_courier'), ValidationError);
  });

  test('CourierAdapter normalizes inputs, validates phones and enforces integer paisa', () => {
    const adapter = new SteadfastAdapter();
    const valid = adapter.normalizeShipmentInput({
      orderId: 'ORD-101',
      invoice: 'INV-101',
      recipientName: 'Abdul Karim',
      recipientPhone: '+8801711223344',
      recipientAddress: 'Dhanmondi 27, Dhaka',
      codAmountPaisa: 150000,
      weightGrams: 1000,
    });

    assert.equal(valid.orderId, 'ORD-101');
    assert.equal(valid.recipientPhone, '01711223344');
    assert.equal(valid.codAmountPaisa, 150000);
    assert.equal(valid.codAmountBdt, 1500);

    // Invalid phone rejection
    assert.throws(() => {
      adapter.normalizeShipmentInput({
        orderId: 'ORD-101',
        recipientName: 'Abdul Karim',
        recipientPhone: '12345',
        recipientAddress: 'Dhaka',
      });
    }, ValidationError);

    // Non-integer paisa rejection
    assert.throws(() => {
      adapter.normalizeShipmentInput({
        orderId: 'ORD-101',
        recipientName: 'Abdul Karim',
        recipientPhone: '01711223344',
        recipientAddress: 'Dhaka',
        codAmountPaisa: 150.5,
      });
    }, TypeError);
  });

  test('SteadfastAdapter creates mock shipment and tracks correctly in sandbox mode', async () => {
    const adapter = new SteadfastAdapter({ sandbox: true });
    const res = await adapter.createShipment({
      orderId: 'ORD-STF-01',
      invoice: 'INV-STF-01',
      recipientName: 'Rahim Uddin',
      recipientPhone: '01811223344',
      recipientAddress: 'Mirpur 10, Dhaka',
      codAmountPaisa: 75000,
    });

    assert.equal(res.success, true);
    assert.equal(res.provider, 'steadfast');
    assert.equal(res.mode, 'sandbox_mock');
    assert.ok(res.consignmentId.startsWith('STF-'));
    assert.ok(res.trackingCode.includes('INV-STF-01'));
    assert.equal(res.status, 'in_review');

    // Track mock shipment
    const track = await adapter.trackShipment(res.trackingCode);
    assert.equal(track.provider, 'steadfast');
    assert.equal(track.trackingCode, res.trackingCode);
    assert.ok(track.status);
  });

  test('PathaoAdapter creates mock shipment and tracks correctly in sandbox mode', async () => {
    const adapter = new PathaoAdapter({ sandbox: true });
    const res = await adapter.createShipment({
      orderId: 'ORD-PTH-01',
      invoice: 'INV-PTH-01',
      recipientName: 'Fatema Begum',
      recipientPhone: '01911223344',
      recipientAddress: 'Uttara Sector 3, Dhaka',
      codAmountPaisa: 120000,
    });

    assert.equal(res.success, true);
    assert.equal(res.provider, 'pathao');
    assert.equal(res.mode, 'sandbox_mock');
    assert.ok(res.consignmentId.startsWith('PTH-'));
    assert.equal(res.status, 'pending');

    const track = await adapter.trackShipment(res.consignmentId);
    assert.equal(track.provider, 'pathao');
    assert.equal(track.trackingCode, res.consignmentId);
    assert.ok(track.status);
  });

  test('CourierAdapter prevents duplicate simultaneous bookings with lock', async () => {
    const adapter = new SteadfastAdapter({ sandbox: true });
    const releaseLock = adapter.acquireLock('CONCURRENT-ORD-1');

    assert.throws(() => {
      adapter.acquireLock('CONCURRENT-ORD-1');
    }, ConflictError);

    releaseLock();

    // After release, acquiring lock again succeeds
    const release2 = adapter.acquireLock('CONCURRENT-ORD-1');
    assert.ok(typeof release2 === 'function');
    release2();
  });

  test('CourierAdapter redacts sensitive API keys and full phone numbers in logs', () => {
    const adapter = new SteadfastAdapter();
    const sensitive = {
      api_key: 'topsecretkey123',
      secret_key: 'verysecret456',
      recipient_phone: '01711223344',
      invoice: 'INV-101',
    };
    const redacted = adapter.redactSensitive(sensitive);

    assert.equal(redacted.api_key, '[REDACTED]');
    assert.equal(redacted.secret_key, '[REDACTED]');
    assert.equal(redacted.recipient_phone, '017****3344');
    assert.equal(redacted.invoice, 'INV-101');
  });
});
