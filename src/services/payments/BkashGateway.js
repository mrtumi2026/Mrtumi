'use strict';

const { PaymentGateway } = require('./PaymentGateway');
const { ValidationError } = require('../../utils/errors');
const { bdtToPaisa } = require('../../utils/money');

class BkashGateway extends PaymentGateway {
  constructor(options = {}) {
    super({
      code: 'bkash_auto',
      name: 'bKash Tokenized Checkout',
      baseUrl: options.baseUrl || 'https://tokenized.sandbox.bka.sh/v1.2.0-beta',
      apiKey: options.apiKey || process.env.BKASH_APP_KEY || '',
      secretKey: options.secretKey || process.env.BKASH_APP_SECRET || '',
      sandbox: options.sandbox ?? (process.env.BKASH_SANDBOX !== 'false'),
    });
    this.username = options.username || process.env.BKASH_USERNAME || '';
    this.password = options.password || process.env.BKASH_PASSWORD || '';
    this._idToken = null;
    this._tokenExpiresAt = 0;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.secretKey && this.username && this.password);
  }

  async getIdToken() {
    if (this._idToken && Date.now() < this._tokenExpiresAt) {
      return this._idToken;
    }
    if (this.sandbox || !this.isConfigured()) {
      this._idToken = 'mock_bkash_id_token';
      this._tokenExpiresAt = Date.now() + 3600000;
      return this._idToken;
    }

    const res = await fetch(`${this.baseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        username: this.username,
        password: this.password,
      },
      body: JSON.stringify({
        app_key: this.apiKey,
        app_secret: this.secretKey,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.statusCode !== '0000' || !data.id_token) {
      throw new ValidationError(`bKash authentication failed: ${data.statusMessage || res.statusText}`);
    }

    this._idToken = data.id_token;
    this._tokenExpiresAt = Date.now() + (Number(data.expires_in || 3600) - 120) * 1000;
    return this._idToken;
  }

  async initiatePayment(rawInput) {
    const input = this.normalizeInitiateInput(rawInput);

    if (this.sandbox || !this.isConfigured()) {
      const mockPaymentId = `BK-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const mockRedirectUrl = `${input.callbackUrl || '/payment/callback'}?paymentID=${mockPaymentId}&status=success`;
      return {
        success: true,
        provider: 'bkash_auto',
        mode: 'sandbox_mock',
        paymentId: mockPaymentId,
        redirectUrl: mockRedirectUrl,
        invoice: input.invoice,
        amountPaisa: input.amountPaisa,
        rawResponse: {
          statusCode: '0000',
          statusMessage: 'Sandbox payment initiated successfully',
          paymentID: mockPaymentId,
          bkashURL: mockRedirectUrl,
        },
      };
    }

    const token = await this.getIdToken();
    const body = {
      mode: '0011',
      payerReference: input.customerPhone || '01700000000',
      callbackURL: input.callbackUrl,
      amount: input.amountBdt,
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: input.invoice,
    };

    const res = await fetch(`${this.baseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-APP-Key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.statusCode !== '0000' || !data.bkashURL) {
      throw new ValidationError(
        `bKash payment initiation failed: ${data.statusMessage || res.statusText}`,
        this.redactSensitive(data)
      );
    }

    return {
      success: true,
      provider: 'bkash_auto',
      mode: 'live',
      paymentId: data.paymentID,
      redirectUrl: data.bkashURL,
      invoice: input.invoice,
      amountPaisa: input.amountPaisa,
      rawResponse: this.redactSensitive(data),
    };
  }

  async executePayment(paymentId) {
    if (!paymentId) throw new ValidationError('Payment ID is required to execute bKash payment.');

    if (this.sandbox || !this.isConfigured()) {
      const mockTrxId = `TRX${Date.now().toString(36).toUpperCase()}${Math.floor(100 + Math.random() * 900)}`;
      return {
        success: true,
        provider: 'bkash_auto',
        mode: 'sandbox_mock',
        paymentId,
        transactionId: mockTrxId,
        status: 'completed',
        amountPaisa: 50000,
        rawResponse: {
          statusCode: '0000',
          statusMessage: 'Successful',
          paymentID: paymentId,
          trxID: mockTrxId,
          transactionStatus: 'Completed',
          amount: '500.00',
          currency: 'BDT',
        },
      };
    }

    const token = await this.getIdToken();
    const res = await fetch(`${this.baseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-APP-Key': this.apiKey,
      },
      body: JSON.stringify({ paymentID: paymentId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.statusCode !== '0000' || !data.trxID) {
      throw new ValidationError(
        `bKash execution failed: ${data.statusMessage || res.statusText}`,
        this.redactSensitive(data)
      );
    }

    const paisa = bdtToPaisa(data.amount);
    return {
      success: true,
      provider: 'bkash_auto',
      mode: 'live',
      paymentId: data.paymentID,
      transactionId: data.trxID,
      status: 'completed',
      amountPaisa: paisa,
      rawResponse: this.redactSensitive(data),
    };
  }

  async queryPayment(paymentId) {
    if (!paymentId) throw new ValidationError('Payment ID is required to query bKash payment.');

    if (this.sandbox || !this.isConfigured()) {
      return {
        provider: 'bkash_auto',
        paymentId,
        status: 'Completed',
        amountPaisa: 50000,
      };
    }

    const token = await this.getIdToken();
    const res = await fetch(`${this.baseUrl}/tokenized/checkout/payment/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-APP-Key': this.apiKey,
      },
      body: JSON.stringify({ paymentID: paymentId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.statusCode !== '0000') {
      throw new ValidationError(`bKash query failed: ${data.statusMessage || res.statusText}`);
    }

    return {
      provider: 'bkash_auto',
      paymentId: data.paymentID,
      transactionId: data.trxID,
      status: data.transactionStatus,
      amountPaisa: data.amount ? bdtToPaisa(data.amount) : 0,
      rawResponse: this.redactSensitive(data),
    };
  }
}

module.exports = { BkashGateway };
