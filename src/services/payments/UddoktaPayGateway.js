'use strict';

const crypto = require('crypto');
const { PaymentGateway } = require('./PaymentGateway');
const { ValidationError } = require('../../utils/errors');
const { bdtToPaisa } = require('../../utils/money');

class UddoktaPayGateway extends PaymentGateway {
  constructor(options = {}) {
    super({
      code: 'uddoktapay',
      name: 'UddoktaPay Payment Gateway',
      baseUrl: options.baseUrl || 'https://sandbox.uddoktapay.com',
      apiKey: options.apiKey || process.env.UDDOKTAPAY_API_KEY || '',
      secretKey: options.secretKey || process.env.UDDOKTAPAY_API_KEY || '',
      sandbox: options.sandbox ?? (process.env.UDDOKTAPAY_SANDBOX !== 'false'),
    });
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async initiatePayment(rawInput) {
    const input = this.normalizeInitiateInput(rawInput);

    if (this.sandbox || !this.isConfigured()) {
      const mockInvoiceId = `UP-${Date.now()}`;
      const mockPaymentUrl = `${input.callbackUrl || '/payment/callback'}?invoice_id=${mockInvoiceId}&status=COMPLETED`;
      return {
        success: true,
        provider: 'uddoktapay',
        mode: 'sandbox_mock',
        paymentId: mockInvoiceId,
        redirectUrl: mockPaymentUrl,
        invoice: input.invoice,
        amountPaisa: input.amountPaisa,
        rawResponse: {
          status: true,
          message: 'UddoktaPay sandbox mock session initialized',
          payment_url: mockPaymentUrl,
        },
      };
    }

    const payload = {
      full_name: input.customerName,
      email: input.customerEmail || 'customer@example.com',
      amount: input.amountBdt,
      metadata: {
        order_id: input.orderId,
        invoice: input.invoice,
      },
      redirect_url: input.callbackUrl,
      cancel_url: input.cancelUrl,
      webhook_url: input.callbackUrl,
    };

    const res = await fetch(`${this.baseUrl}/api/checkout-v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'RT-UDDOKTAPAY-API-KEY': this.apiKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.status || !data.payment_url) {
      throw new ValidationError(
        `UddoktaPay initiation failed: ${data.message || res.statusText}`,
        this.redactSensitive(data)
      );
    }

    return {
      success: true,
      provider: 'uddoktapay',
      mode: 'live',
      paymentId: input.invoice,
      redirectUrl: data.payment_url,
      invoice: input.invoice,
      amountPaisa: input.amountPaisa,
      rawResponse: this.redactSensitive(data),
    };
  }

  async executePayment(invoiceId) {
    return this.queryPayment(invoiceId);
  }

  async queryPayment(invoiceId) {
    if (!invoiceId) throw new ValidationError('Invoice ID is required for UddoktaPay verification.');

    if (this.sandbox || !this.isConfigured()) {
      return {
        success: true,
        provider: 'uddoktapay',
        mode: 'sandbox_mock',
        paymentId: invoiceId,
        transactionId: `UP-TXN-${Date.now().toString(36).toUpperCase()}`,
        status: 'completed',
        amountPaisa: 50000,
        rawResponse: {
          status: 'COMPLETED',
          invoice_id: invoiceId,
          amount: '500.00',
        },
      };
    }

    const res = await fetch(`${this.baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'RT-UDDOKTAPAY-API-KEY': this.apiKey,
      },
      body: JSON.stringify({ invoice_id: invoiceId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'COMPLETED') {
      throw new ValidationError(`UddoktaPay verification failed or payment not completed.`);
    }

    return {
      success: true,
      provider: 'uddoktapay',
      mode: 'live',
      paymentId: data.invoice_id || invoiceId,
      transactionId: data.transaction_id || data.invoice_id,
      status: 'completed',
      amountPaisa: bdtToPaisa(data.amount),
      rawResponse: this.redactSensitive(data),
    };
  }

  verifyWebhookSignature(apiKeyHeader) {
    if (!this.apiKey || !apiKeyHeader) return false;
    return this.apiKey.trim() === String(apiKeyHeader).trim();
  }
}

module.exports = { UddoktaPayGateway };
