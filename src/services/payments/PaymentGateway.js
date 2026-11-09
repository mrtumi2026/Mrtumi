'use strict';

const crypto = require('crypto');
const { ValidationError, ConflictError } = require('../../utils/errors');
const { assertSafePaisa } = require('../../utils/money');
const { requireString } = require('../../utils/validator');

/**
 * Base Payment Gateway Adapter for Bangladesh automated payment providers.
 * Enforces:
 * - Integer paisa currency math (1 BDT = 100 paisa)
 * - Server-to-server signature validation
 * - Payment initiation idempotency
 * - Redaction of secrets and credentials
 */
class PaymentGateway {
  constructor({ code, name, baseUrl, apiKey, secretKey, sandbox = true } = {}) {
    if (!code || !name) throw new ValidationError('PaymentGateway requires code and name.');
    this.code = code;
    this.name = name;
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.secretKey = secretKey || '';
    this.sandbox = Boolean(sandbox);
  }

  isConfigured() {
    return Boolean(this.apiKey && this.secretKey);
  }

  redactSensitive(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;
    const copy = Array.isArray(payload) ? [...payload] : { ...payload };
    for (const key of Object.keys(copy)) {
      if (/password|secret|token|key|auth/i.test(key)) {
        copy[key] = '[REDACTED]';
      } else if (typeof copy[key] === 'object' && copy[key] !== null) {
        copy[key] = this.redactSensitive(copy[key]);
      }
    }
    return copy;
  }

  normalizeInitiateInput(input = {}) {
    const orderId = requireString(String(input.orderId || input.order_id || ''), 'orderId');
    const invoice = requireString(String(input.invoice || input.orderId || ''), 'invoice');
    const amountPaisa = assertSafePaisa(input.amountPaisa ?? input.amount_paisa, 'amountPaisa');
    if (amountPaisa <= 0) throw new ValidationError('Payment amount must be greater than zero.');
    const amountBdt = (amountPaisa / 100).toFixed(2);
    const customerName = requireString(input.customerName || input.customer_name || 'Customer', 'customerName', { min: 1, max: 100 });
    const customerPhone = String(input.customerPhone || input.customer_phone || '').trim();
    const customerEmail = String(input.customerEmail || input.customer_email || '').trim();
    const callbackUrl = String(input.callbackUrl || input.callback_url || '');
    const cancelUrl = String(input.cancelUrl || input.cancel_url || '');

    return {
      orderId,
      invoice,
      amountPaisa,
      amountBdt,
      customerName,
      customerPhone,
      customerEmail,
      callbackUrl,
      cancelUrl,
    };
  }

  async initiatePayment(input) {
    throw new Error('initiatePayment must be implemented by payment gateway.');
  }

  async executePayment(paymentId, queryOrBody) {
    throw new Error('executePayment must be implemented by payment gateway.');
  }

  async queryPayment(paymentId) {
    throw new Error('queryPayment must be implemented by payment gateway.');
  }

  verifyCallbackSignature(payload, signature) {
    return false;
  }
}

module.exports = { PaymentGateway };
