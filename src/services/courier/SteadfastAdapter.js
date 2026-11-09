'use strict';

const crypto = require('crypto');
const { CourierAdapter } = require('./CourierAdapter');
const { ValidationError } = require('../../utils/errors');

class SteadfastAdapter extends CourierAdapter {
  constructor(options = {}) {
    super({
      code: 'steadfast',
      name: 'Steadfast Courier',
      baseUrl: options.baseUrl || 'https://portal.packzy.com/api/v1',
      apiKey: options.apiKey || process.env.STEADFAST_API_KEY || '',
      secretKey: options.secretKey || process.env.STEADFAST_SECRET_KEY || '',
      sandbox: options.sandbox ?? (process.env.STEADFAST_SANDBOX !== 'false'),
    });
  }

  async createShipment(rawInput) {
    const input = this.normalizeShipmentInput(rawInput);
    const releaseLock = this.acquireLock(input.orderId);

    try {
      if (this.sandbox || !this.isConfigured()) {
        const mockConsignmentId = `STF-${Math.floor(100000 + Math.random() * 900000)}`;
        const mockTrackingCode = `STF-TRK-${input.invoice}-${Date.now().toString(36).toUpperCase()}`;
        return {
          success: true,
          provider: 'steadfast',
          mode: 'sandbox_mock',
          consignmentId: mockConsignmentId,
          trackingCode: mockTrackingCode,
          invoice: input.invoice,
          status: 'in_review',
          codAmountPaisa: input.codAmountPaisa,
          rawResponse: {
            status: 200,
            message: 'Order created successfully in sandbox mode.',
            consignment: {
              consignment_id: mockConsignmentId,
              invoice: input.invoice,
              tracking_code: mockTrackingCode,
              status: 'in_review',
            },
          },
        };
      }

      const body = {
        invoice: input.invoice,
        recipient_name: input.recipientName,
        recipient_phone: input.recipientPhone,
        recipient_address: input.recipientAddress,
        cod_amount: input.codAmountBdt,
        note: input.note || '',
      };

      const res = await fetch(`${this.baseUrl}/create_order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': this.apiKey,
          'Secret-Key': this.secretKey,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 200 || !data.consignment) {
        throw new ValidationError(
          `Steadfast booking failed: ${data.message || res.statusText || 'Unknown provider error'}`,
          this.redactSensitive(data)
        );
      }

      return {
        success: true,
        provider: 'steadfast',
        mode: 'live',
        consignmentId: String(data.consignment.consignment_id),
        trackingCode: String(data.consignment.tracking_code),
        invoice: input.invoice,
        status: data.consignment.status || 'in_review',
        codAmountPaisa: input.codAmountPaisa,
        rawResponse: this.redactSensitive(data),
      };
    } finally {
      releaseLock();
    }
  }

  async trackShipment(trackingCode) {
    if (!trackingCode) throw new ValidationError('Tracking code is required.');

    if (this.sandbox || !this.isConfigured()) {
      return {
        provider: 'steadfast',
        trackingCode,
        status: 'in_transit',
        statusDescription: 'Order is in transit (Sandbox Simulation)',
        updatedAt: new Date().toISOString(),
      };
    }

    const res = await fetch(`${this.baseUrl}/status_by_trackingcode/${encodeURIComponent(trackingCode)}`, {
      headers: {
        'Api-Key': this.apiKey,
        'Secret-Key': this.secretKey,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ValidationError(`Steadfast tracking request failed: ${data.message || res.statusText}`);
    }

    return {
      provider: 'steadfast',
      trackingCode,
      status: this.mapStatus(data.delivery_status || data.status),
      rawStatus: data.delivery_status || data.status,
      updatedAt: data.updated_at || new Date().toISOString(),
    };
  }

  mapStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase();
    if (s.includes('delivered') && !s.includes('partial')) return 'delivered';
    if (s.includes('partial')) return 'partial_delivered';
    if (s.includes('cancelled')) return 'cancelled';
    if (s.includes('hold')) return 'hold';
    if (s.includes('transit') || s.includes('picked')) return 'in_transit';
    return 'pending';
  }

  verifyWebhookSignature(payload, signature) {
    if (!this.secretKey || !signature) return false;
    const computed = crypto.createHmac('sha256', this.secretKey)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  }
}

module.exports = { SteadfastAdapter };
