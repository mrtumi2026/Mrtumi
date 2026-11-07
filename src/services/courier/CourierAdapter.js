'use strict';

const crypto = require('crypto');
const { ValidationError, ConflictError } = require('../../utils/errors');
const { assertSafePaisa } = require('../../utils/money');
const { normalizeBdPhone, requireString } = require('../../utils/validator');

/**
 * Base Courier Adapter defining standard contract for Bangladesh logistics providers.
 * Enforces:
 * - Duplicate booking locks (idempotency key by orderId / invoice)
 * - Safe PII & token redaction in logs
 * - Integer paisa COD amounts
 * - Strict status mapping to canonical order fulfillment statuses
 */
class CourierAdapter {
  constructor({ code, name, baseUrl, apiKey, secretKey, sandbox = true } = {}) {
    if (!code || !name) throw new ValidationError('Courier adapter requires code and name.');
    this.code = code;
    this.name = name;
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.secretKey = secretKey || '';
    this.sandbox = Boolean(sandbox);
    this._bookingLocks = new Set();
  }

  isConfigured() {
    return Boolean(this.apiKey && (this.secretKey || this.code === 'steadfast'));
  }

  redactSensitive(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;
    const copy = Array.isArray(payload) ? [...payload] : { ...payload };
    for (const key of Object.keys(copy)) {
      if (/password|secret|token|key|auth/i.test(key)) {
        copy[key] = '[REDACTED]';
      } else if (key === 'phone' || key === 'recipient_phone') {
        const p = String(copy[key]);
        copy[key] = p.length > 5 ? p.slice(0, 3) + '****' + p.slice(-4) : '****';
      } else if (typeof copy[key] === 'object' && copy[key] !== null) {
        copy[key] = this.redactSensitive(copy[key]);
      }
    }
    return copy;
  }

  acquireLock(orderId) {
    const key = `courier_lock:${this.code}:${orderId}`;
    if (this._bookingLocks.has(key)) {
      throw new ConflictError(`Active booking already in progress for order ${orderId}.`);
    }
    this._bookingLocks.add(key);
    return () => this._bookingLocks.delete(key);
  }

  /**
   * Normalizes incoming shipment details before dispatch
   */
  normalizeShipmentInput(input = {}) {
    const orderId = requireString(String(input.orderId || input.order_id || ''), 'orderId');
    const invoice = requireString(String(input.invoice || input.orderId || ''), 'invoice');
    const recipientName = requireString(input.recipientName || input.recipient_name, 'recipientName', { min: 2, max: 100 });
    const recipientPhone = normalizeBdPhone(input.recipientPhone || input.recipient_phone, 'recipientPhone');
    const recipientAddress = requireString(input.recipientAddress || input.recipient_address, 'recipientAddress', { min: 5, max: 255 });
    const codAmountPaisa = assertSafePaisa(input.codAmountPaisa ?? input.cod_amount_paisa ?? 0, 'codAmountPaisa');
    const weightGrams = Number.isInteger(input.weightGrams) && input.weightGrams > 0 ? input.weightGrams : 500;
    const note = String(input.note || '').slice(0, 200);

    return {
      orderId,
      invoice,
      recipientName,
      recipientPhone,
      recipientAddress,
      codAmountPaisa,
      codAmountBdt: Math.round(codAmountPaisa / 100),
      weightGrams,
      note,
    };
  }

  async createShipment(input) {
    throw new Error('createShipment must be implemented by provider adapter.');
  }

  async trackShipment(trackingCode) {
    throw new Error('trackShipment must be implemented by provider adapter.');
  }

  async cancelShipment(trackingCode) {
    throw new Error('cancelShipment must be implemented by provider adapter.');
  }

  verifyWebhookSignature(payload, signature) {
    return false;
  }
}

module.exports = { CourierAdapter };
