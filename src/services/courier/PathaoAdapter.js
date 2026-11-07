'use strict';

const { CourierAdapter } = require('./CourierAdapter');
const { ValidationError } = require('../../utils/errors');

class PathaoAdapter extends CourierAdapter {
  constructor(options = {}) {
    super({
      code: 'pathao',
      name: 'Pathao Courier',
      baseUrl: options.baseUrl || 'https://api-hermes.pathao.com',
      apiKey: options.apiKey || process.env.PATHAO_CLIENT_ID || '',
      secretKey: options.secretKey || process.env.PATHAO_CLIENT_SECRET || '',
      sandbox: options.sandbox ?? (process.env.PATHAO_SANDBOX !== 'false'),
    });
    this.storeId = options.storeId || process.env.PATHAO_STORE_ID || '';
    this.username = options.username || process.env.PATHAO_USERNAME || '';
    this.password = options.password || process.env.PATHAO_PASSWORD || '';
    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.secretKey && this.username && this.password && this.storeId);
  }

  async getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt) {
      return this._accessToken;
    }
    if (this.sandbox || !this.isConfigured()) {
      this._accessToken = 'mock_pathao_access_token';
      this._tokenExpiresAt = Date.now() + 3600000;
      return this._accessToken;
    }

    const res = await fetch(`${this.baseUrl}/aladdin/api/v1/issue-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.apiKey,
        client_secret: this.secretKey,
        username: this.username,
        password: this.password,
        grant_type: 'password',
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new ValidationError(`Pathao authentication failed: ${data.message || res.statusText}`);
    }

    this._accessToken = data.access_token;
    this._tokenExpiresAt = Date.now() + (Number(data.expires_in || 3600) - 300) * 1000;
    return this._accessToken;
  }

  async createShipment(rawInput) {
    const input = this.normalizeShipmentInput(rawInput);
    const releaseLock = this.acquireLock(input.orderId);

    try {
      if (this.sandbox || !this.isConfigured()) {
        const mockConsignmentId = `PTH-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
        return {
          success: true,
          provider: 'pathao',
          mode: 'sandbox_mock',
          consignmentId: mockConsignmentId,
          trackingCode: mockConsignmentId,
          invoice: input.invoice,
          status: 'pending',
          codAmountPaisa: input.codAmountPaisa,
          rawResponse: {
            type: 'success',
            code: 200,
            message: 'Order created successfully in Pathao sandbox.',
            data: {
              consignment_id: mockConsignmentId,
              merchant_order_id: input.invoice,
              order_status: 'Pending',
            },
          },
        };
      }

      const token = await this.getAccessToken();
      const body = {
        store_id: Number(this.storeId),
        merchant_order_id: input.invoice,
        recipient_name: input.recipientName,
        recipient_phone: input.recipientPhone,
        recipient_address: input.recipientAddress,
        delivery_type: 48,
        item_type: 2,
        special_instruction: input.note || '',
        item_quantity: 1,
        item_weight: Math.max(0.5, input.weightGrams / 1000),
        amount_to_collect: input.codAmountBdt,
      };

      const res = await fetch(`${this.baseUrl}/aladdin/api/v1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.code !== 200 || !data.data) {
        throw new ValidationError(
          `Pathao booking failed: ${data.message || res.statusText}`,
          this.redactSensitive(data)
        );
      }

      return {
        success: true,
        provider: 'pathao',
        mode: 'live',
        consignmentId: String(data.data.consignment_id),
        trackingCode: String(data.data.consignment_id),
        invoice: input.invoice,
        status: data.data.order_status || 'pending',
        codAmountPaisa: input.codAmountPaisa,
        rawResponse: this.redactSensitive(data),
      };
    } finally {
      releaseLock();
    }
  }

  async trackShipment(consignmentId) {
    if (!consignmentId) throw new ValidationError('Consignment ID is required.');

    if (this.sandbox || !this.isConfigured()) {
      return {
        provider: 'pathao',
        trackingCode: consignmentId,
        status: 'in_transit',
        statusDescription: 'Order in transit (Sandbox Simulation)',
        updatedAt: new Date().toISOString(),
      };
    }

    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.data) {
      throw new ValidationError(`Pathao tracking failed: ${data.message || res.statusText}`);
    }

    return {
      provider: 'pathao',
      trackingCode: consignmentId,
      status: this.mapStatus(data.data.order_status),
      rawStatus: data.data.order_status,
      updatedAt: data.data.updated_at || new Date().toISOString(),
    };
  }

  mapStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase();
    if (s.includes('delivered') && !s.includes('partial')) return 'delivered';
    if (s.includes('partial')) return 'partial_delivered';
    if (s.includes('cancel')) return 'cancelled';
    if (s.includes('return')) return 'returned';
    if (s.includes('transit') || s.includes('picked') || s.includes('assigned')) return 'in_transit';
    return 'pending';
  }
}

module.exports = { PathaoAdapter };
