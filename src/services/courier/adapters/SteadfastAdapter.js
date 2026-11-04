'use strict';

const CourierBaseAdapter = require('../CourierBaseAdapter');

/**
 * Steadfast Courier Service Adapter.
 * Integrates with Steadfast API v1 for Bangladesh domestic parcel delivery.
 */
class SteadfastAdapter extends CourierBaseAdapter {
  constructor(config = {}) {
    super(config);
    this.baseUrl = this.baseUrl || 'https://portal.steadfast.com.bd/api/v1';
  }

  /**
   * Steadfast does not have a dynamic quote API endpoint;
   * it operates on standard zone tariff slabs.
   * We return the contracted tariff clearly marked as isLiveQuote = false.
   */
  async getQuote({ origin, destination, weightGrams = 1000, codAmountPaisa = 0 }) {
    const dest = String(destination?.district || destination?.city || '').toLowerCase().trim();
    const isInsideDhaka = dest === 'dhaka' || dest.includes('dhaka city') || dest === 'ঢাকা';
    const isSubDhaka = ['gazipur', 'narayanganj', 'savar', 'keraniganj', 'tongui', 'গাজীপুর', 'নারায়ণগঞ্জ', 'সাভার'].includes(dest);
    const weightKg = Math.max(1, Math.ceil(Number(weightGrams || 1000) / 1000));

    let baseChargePaisa = 13000; // Outside Dhaka: ৳130
    let daysMin = 2;
    let daysMax = 4;

    if (isInsideDhaka) {
      baseChargePaisa = 6000; // Inside Dhaka: ৳60
      daysMin = 1;
      daysMax = 2;
    } else if (isSubDhaka) {
      baseChargePaisa = 10000; // Sub-Dhaka: ৳100
      daysMin = 2;
      daysMax = 3;
    }

    // Additional weight: ৳20 per kg above 1kg
    const extraKg = Math.max(0, weightKg - 1);
    const extraChargePaisa = extraKg * 2000;
    const totalChargePaisa = baseChargePaisa + extraChargePaisa;

    // COD fee: 1% COD fee
    const codFeePaisa = codAmountPaisa > 0 ? Math.round(codAmountPaisa * 0.01) : 0;

    return {
      providerCode: this.providerCode || 'steadfast',
      providerName: this.providerName || 'Steadfast Courier',
      available: true,
      chargePaisa: totalChargePaisa,
      codFeePaisa,
      estimatedDaysMin: daysMin,
      estimatedDaysMax: daysMax,
      isLiveQuote: false, // Explicit contract tariff schedule; provider API has no dynamic quote endpoint
      serviceType: 'standard_doorstep',
      reasonUnavailable: null,
      notes: 'Standard contract tariff schedule (Steadfast does not support dynamic quote API)'
    };
  }

  async checkServiceability({ origin, destination }) {
    // Steadfast covers 64 districts in Bangladesh nationwide
    return { serviceable: true, reason: null };
  }

  async bookShipment({ shipmentId, subOrderId, invoiceNo, recipient, parcel, codAmountPaisa, idempotencyKey }) {
    if (!this.apiKey || !this.secretKey) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { error: 'CREDENTIALS_MISSING' },
        error: 'Steadfast API key or Secret key is not configured.'
      };
    }

    const codBdt = Math.round(Number(codAmountPaisa || 0) / 100);
    const payload = {
      invoice: String(invoiceNo || subOrderId || ''),
      recipient_name: String(recipient?.name || '').trim(),
      recipient_phone: String(recipient?.phone || '').trim(),
      recipient_address: String(recipient?.address || '').trim(),
      cod_amount: codBdt,
      note: String(recipient?.note || `Mr. Tumi Order #${invoiceNo}`)
    };

    // If sandbox mode, return mock success response without external HTTP
    if (this.isSandbox) {
      const trackingCode = `SF-SB-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
      const consignmentId = `SF-CID-${Date.now().toString().slice(-7)}`;
      return {
        success: true,
        trackingId: trackingCode,
        consignmentId,
        rawResponse: {
          status: 200,
          message: 'Order created in Steadfast sandbox environment',
          consignment: {
            consignment_id: consignmentId,
            tracking_code: trackingCode,
            invoice: payload.invoice,
            recipient_name: payload.recipient_name,
            cod_amount: payload.cod_amount,
            status: 'in_review'
          }
        },
        error: null
      };
    }

    try {
      const fetch = globalThis.fetch || require('node-fetch');
      const response = await fetch(`${this.baseUrl}/create_order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': this.apiKey,
          'Secret-Key': this.secretKey
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      if (response.ok && data.status === 200 && data.consignment) {
        return {
          success: true,
          trackingId: data.consignment.tracking_code || String(data.consignment.consignment_id),
          consignmentId: String(data.consignment.consignment_id),
          rawResponse: data,
          error: null
        };
      }

      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: data,
        error: data.message || `Steadfast booking failed with status ${data.status || response.status}`
      };
    } catch (err) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { error: err.message },
        error: `Steadfast network error: ${err.message}`
      };
    }
  }

  async trackShipment(trackingReference) {
    if (!this.apiKey || !this.secretKey) {
      return {
        trackingId: trackingReference,
        normalizedStatus: 'in_transit',
        rawStatus: 'unconfigured',
        events: []
      };
    }

    if (this.isSandbox) {
      return {
        trackingId: trackingReference,
        normalizedStatus: 'in_transit',
        rawStatus: 'in_review',
        events: [
          { status: 'booked', note: 'Order placed with Steadfast (Sandbox)', timestamp: new Date().toISOString() }
        ]
      };
    }

    try {
      const fetch = globalThis.fetch || require('node-fetch');
      const response = await fetch(`${this.baseUrl}/status_by_trackingcode/${encodeURIComponent(trackingReference)}`, {
        method: 'GET',
        headers: {
          'Api-Key': this.apiKey,
          'Secret-Key': this.secretKey
        }
      });
      const data = await response.json();
      const rawStatus = data.delivery_status || 'unknown';
      return {
        trackingId: trackingReference,
        normalizedStatus: this.normalizeStatus(rawStatus),
        rawStatus,
        events: [
          { status: rawStatus, note: `Steadfast status: ${rawStatus}`, timestamp: new Date().toISOString() }
        ]
      };
    } catch (err) {
      return {
        trackingId: trackingReference,
        normalizedStatus: 'in_transit',
        rawStatus: 'error',
        events: [{ status: 'error', note: err.message, timestamp: new Date().toISOString() }]
      };
    }
  }
}

module.exports = SteadfastAdapter;
