'use strict';

const CourierBaseAdapter = require('../CourierBaseAdapter');

/**
 * Pathao Courier Service Adapter.
 * Integrates with Pathao Courier API for parcel delivery and tracking.
 */
class PathaoAdapter extends CourierBaseAdapter {
  constructor(config = {}) {
    super(config);
    this.baseUrl = this.baseUrl || 'https://courier-api.pathao.com';
    this.storeId = this.serviceOptions.store_id || 1;
  }

  async getQuote({ origin, destination, weightGrams = 1000, codAmountPaisa = 0 }) {
    const dest = String(destination?.district || destination?.city || '').toLowerCase().trim();
    const isInsideDhaka = dest === 'dhaka' || dest.includes('dhaka city') || dest === 'ঢাকা';
    const isSubDhaka = ['gazipur', 'narayanganj', 'savar', 'keraniganj', 'tongui', 'গাজীপুর', 'নারায়ণগঞ্জ', 'সাভার'].includes(dest);
    const weightKg = Math.max(0.5, Number(weightGrams || 1000) / 1000);

    // If live API is configured and live quotes are supported
    if (this.supportsLiveQuotes && this.apiKey && !this.isSandbox) {
      try {
        const fetch = globalThis.fetch || require('node-fetch');
        const response = await fetch(`${this.baseUrl}/aladdin/api/v1/merchant/price-plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            store_id: this.storeId,
            item_type: 1, // Parcel
            delivery_type: 48, // Standard 48h
            item_weight: weightKg,
            recipient_city: isInsideDhaka ? 1 : 2,
            recipient_zone: 1
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (data && data.data) {
            const plan = data.data;
            const deliveryPaisa = Math.round(Number(plan.delivery_fee || 60) * 100);
            const codFeePaisa = Math.round(Number(plan.cod_charge || 0) * 100);
            return {
              providerCode: this.providerCode || 'pathao',
              providerName: this.providerName || 'Pathao Courier',
              available: true,
              chargePaisa: deliveryPaisa,
              codFeePaisa,
              estimatedDaysMin: isInsideDhaka ? 1 : 2,
              estimatedDaysMax: isInsideDhaka ? 2 : 3,
              isLiveQuote: true,
              serviceType: 'standard_48h',
              reasonUnavailable: null,
              notes: 'Live price plan from Pathao Courier API'
            };
          }
        }
      } catch (_err) {
        // Fall back to standard tariff if live API call fails
      }
    }

    // Standard Pathao tariff schedule fallback
    let baseChargePaisa = 12000; // Outside Dhaka: ৳120
    let daysMin = 2;
    let daysMax = 3;

    if (isInsideDhaka) {
      baseChargePaisa = 6000; // Inside Dhaka: ৳60
      daysMin = 1;
      daysMax = 2;
    } else if (isSubDhaka) {
      baseChargePaisa = 10000; // Sub-Dhaka: ৳100
      daysMin = 2;
      daysMax = 3;
    }

    const roundedKg = Math.ceil(weightKg);
    const extraKg = Math.max(0, roundedKg - 1);
    const extraChargePaisa = extraKg * 2000;
    const totalChargePaisa = baseChargePaisa + extraChargePaisa;
    const codFeePaisa = codAmountPaisa > 0 ? Math.round(codAmountPaisa * 0.01) : 0;

    return {
      providerCode: this.providerCode || 'pathao',
      providerName: this.providerName || 'Pathao Courier',
      available: true,
      chargePaisa: totalChargePaisa,
      codFeePaisa,
      estimatedDaysMin: daysMin,
      estimatedDaysMax: daysMax,
      isLiveQuote: false,
      serviceType: 'standard_doorstep',
      reasonUnavailable: null,
      notes: 'Standard Pathao tariff schedule'
    };
  }

  async checkServiceability({ origin, destination }) {
    return { serviceable: true, reason: null };
  }

  async bookShipment({ shipmentId, subOrderId, invoiceNo, recipient, parcel, codAmountPaisa, idempotencyKey }) {
    if (!this.apiKey && !this.isSandbox) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { error: 'CREDENTIALS_MISSING' },
        error: 'Pathao API Bearer Token is not configured.'
      };
    }

    const codBdt = Math.round(Number(codAmountPaisa || 0) / 100);
    const weightKg = Math.max(0.5, Number(parcel?.weightGrams || 1000) / 1000);

    if (this.isSandbox) {
      const consignmentId = `PTH-SB-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
      return {
        success: true,
        trackingId: consignmentId,
        consignmentId,
        rawResponse: {
          type: 'success',
          code: 200,
          message: 'Order created successfully in Pathao Sandbox',
          data: {
            consignment_id: consignmentId,
            merchant_order_id: invoiceNo,
            order_status: 'Pickup Requested',
            delivery_fee: 60
          }
        },
        error: null
      };
    }

    try {
      const fetch = globalThis.fetch || require('node-fetch');
      const response = await fetch(`${this.baseUrl}/aladdin/api/v1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          store_id: this.storeId,
          merchant_order_id: String(invoiceNo || subOrderId),
          recipient_name: String(recipient?.name || '').trim(),
          recipient_phone: String(recipient?.phone || '').trim(),
          recipient_address: String(recipient?.address || '').trim(),
          recipient_city: 1,
          recipient_zone: 1,
          delivery_type: 48,
          item_type: 1,
          special_instruction: recipient?.note || '',
          item_quantity: 1,
          item_weight: weightKg,
          amount_to_collect: codBdt,
          item_description: `Order #${invoiceNo}`
        })
      });

      const data = await response.json();
      if (response.ok && data.data && data.data.consignment_id) {
        return {
          success: true,
          trackingId: String(data.data.consignment_id),
          consignmentId: String(data.data.consignment_id),
          rawResponse: data,
          error: null
        };
      }

      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: data,
        error: data.message || `Pathao booking failed: HTTP ${response.status}`
      };
    } catch (err) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { error: err.message },
        error: `Pathao network error: ${err.message}`
      };
    }
  }

  async trackShipment(trackingReference) {
    if (this.isSandbox) {
      return {
        trackingId: trackingReference,
        normalizedStatus: 'in_transit',
        rawStatus: 'Pickup Requested',
        events: [
          { status: 'booked', note: 'Pathao order requested', timestamp: new Date().toISOString() }
        ]
      };
    }

    try {
      const fetch = globalThis.fetch || require('node-fetch');
      const response = await fetch(`${this.baseUrl}/aladdin/api/v1/orders/${encodeURIComponent(trackingReference)}/info`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        }
      });
      const data = await response.json();
      const rawStatus = data.data?.order_status || 'unknown';
      return {
        trackingId: trackingReference,
        normalizedStatus: this.normalizeStatus(rawStatus),
        rawStatus,
        events: [
          { status: rawStatus, note: `Pathao: ${rawStatus}`, timestamp: new Date().toISOString() }
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

module.exports = PathaoAdapter;
