'use strict';

const { PaymentGateway } = require('./PaymentGateway');
const { ValidationError } = require('../../utils/errors');
const { bdtToPaisa } = require('../../utils/money');

class ShurjoPayGateway extends PaymentGateway {
  constructor(options = {}) {
    super({
      code: 'shurjopay',
      name: 'ShurjoPay Payment Gateway',
      baseUrl: options.baseUrl || 'https://sandbox.shurjopayment.com',
      apiKey: options.apiKey || process.env.SHURJOPAY_USERNAME || '',
      secretKey: options.secretKey || process.env.SHURJOPAY_PASSWORD || '',
      sandbox: options.sandbox ?? (process.env.SHURJOPAY_SANDBOX !== 'false'),
    });
    this.prefix = options.prefix || process.env.SHURJOPAY_PREFIX || 'NOK';
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.secretKey);
  }

  async getToken() {
    if (this._token && Date.now() < this._tokenExpiresAt) {
      return this._token;
    }
    if (this.sandbox || !this.isConfigured()) {
      this._token = 'mock_shurjopay_token';
      this._tokenExpiresAt = Date.now() + 3600000;
      return this._token;
    }

    const res = await fetch(`${this.baseUrl}/api/get_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.apiKey,
        password: this.secretKey,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      throw new ValidationError(`ShurjoPay token request failed: ${data.message || res.statusText}`);
    }

    this._token = data.token;
    this._tokenExpiresAt = Date.now() + 3600000 - 120000;
    return this._token;
  }

  async initiatePayment(rawInput) {
    const input = this.normalizeInitiateInput(rawInput);

    if (this.sandbox || !this.isConfigured()) {
      const mockSpOrder = `SP-${this.prefix}-${Date.now()}`;
      const mockCheckoutUrl = `${input.callbackUrl || '/payment/callback'}?order_id=${mockSpOrder}&status=success`;
      return {
        success: true,
        provider: 'shurjopay',
        mode: 'sandbox_mock',
        paymentId: mockSpOrder,
        redirectUrl: mockCheckoutUrl,
        invoice: input.invoice,
        amountPaisa: input.amountPaisa,
        rawResponse: {
          checkout_url: mockCheckoutUrl,
          amount: input.amountBdt,
          currency: 'BDT',
          sp_code: '1000',
          message: 'Success',
        },
      };
    }

    const token = await this.getToken();
    const payload = {
      prefix: this.prefix,
      token,
      return_url: input.callbackUrl,
      cancel_url: input.cancelUrl,
      amount: input.amountBdt,
      order_id: input.invoice,
      currency: 'BDT',
      customer_name: input.customerName,
      customer_phone: input.customerPhone || '01700000000',
      customer_email: input.customerEmail || 'customer@example.com',
      customer_address: 'Bangladesh',
      customer_city: 'Dhaka',
      client_ip: '127.0.0.1',
    };

    const res = await fetch(`${this.baseUrl}/api/secret-pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.checkout_url) {
      throw new ValidationError(
        `ShurjoPay payment initiation failed: ${data.message || res.statusText}`,
        this.redactSensitive(data)
      );
    }

    return {
      success: true,
      provider: 'shurjopay',
      mode: 'live',
      paymentId: data.sp_order_id || input.invoice,
      redirectUrl: data.checkout_url,
      invoice: input.invoice,
      amountPaisa: input.amountPaisa,
      rawResponse: this.redactSensitive(data),
    };
  }

  async executePayment(orderId) {
    return this.queryPayment(orderId);
  }

  async queryPayment(orderId) {
    if (!orderId) throw new ValidationError('Order ID is required to verify ShurjoPay transaction.');

    if (this.sandbox || !this.isConfigured()) {
      return {
        success: true,
        provider: 'shurjopay',
        mode: 'sandbox_mock',
        paymentId: orderId,
        transactionId: `SP-TRX-${Date.now().toString(36).toUpperCase()}`,
        status: 'completed',
        amountPaisa: 50000,
        rawResponse: {
          sp_code: '1000',
          transaction_status: 'Completed',
          amount: '500.00',
          currency: 'BDT',
        },
      };
    }

    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}/api/verification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ order_id: orderId }),
    });

    const data = await res.json().catch(() => ([]));
    const record = Array.isArray(data) ? data[0] : data;
    if (!res.ok || !record || String(record.sp_code) !== '1000') {
      throw new ValidationError(`ShurjoPay transaction not completed or invalid.`);
    }

    return {
      success: true,
      provider: 'shurjopay',
      mode: 'live',
      paymentId: record.order_id || orderId,
      transactionId: record.bank_trx_id || record.tx_id,
      status: 'completed',
      amountPaisa: bdtToPaisa(record.amount),
      rawResponse: this.redactSensitive(record),
    };
  }
}

module.exports = { ShurjoPayGateway };
