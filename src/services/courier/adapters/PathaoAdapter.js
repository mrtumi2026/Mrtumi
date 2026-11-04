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

    if (weightKg > 10) {
      return {
        providerCode: this.providerCode || 'pathao',
        providerName: this.providerName || 'Pathao Courier',
        available: false,
        chargePaisa: 0,
        codFeePaisa: 0,
        estimatedDaysMin: 0,
        estimatedDaysMax: 0,
        isLiveQuote: false,
        serviceType: 'standard_48h',
        reasonUnavailable: 'Pathao parcel weight limit exceeded (maximum 10kg)',
        notes: 'Weight restriction exceeded'
      };
    }

    // If live API is configured and live quotes are supported
    if (this.supportsLiveQuotes && this.apiKey && !this.isSandbox) {
      try {
        const response = await this.safeFetch(`${this.baseUrl}/aladdin/api/v1/merchant/price-plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            store_id: this.storeId,
            item_type: 1, // Parcel
            delivery_type: 48, // Standard 48h
            item_weight: weightKg,
            recipient_city: isInsideDhaka ? 1 : 2,
            recipient_zone: 1
          })
        }, 5000);

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
        // Fall back to standard tariff schedule if live quote times out or errors
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

  async reconcileBooking({ consignmentId }) {
    if (!this.apiKey || !consignmentId || this.isSandbox) {
      return { found: false, trackingId: null, consignmentId: null, status: null };
    }

    try {
      const response = await this.safeFetch(`${this.baseUrl}/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        }
      }, 5000);

      if (response.ok) {
        const data = await response.json();
        if (data && data.data && data.data.consignment_id) {
          return {
            found: true,
            trackingId: String(data.data.consignment_id),
            consignmentId: String(data.data.consignment_id),
            status: data.data.order_status
          };
        }
      }
    } catch (_err) {
      // Quietly ignore reconciliation errors
    }
    return { found: false, trackingId: null, consignmentId: null, status: null };
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

    // Phone format validation
    const rawPhone = String(recipient?.phone || '').replace(/[^0-9]/g, '');
    const cleanPhone = rawPhone.length === 13 && rawPhone.startsWith('880') ? rawPhone.slice(2) : rawPhone;
    if (!/^01[3-9]\d{8}$/.test(cleanPhone)) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { error: 'INVALID_PHONE' },
        error: `Invalid Bangladesh recipient phone number format: '${recipient?.phone}'. Must be 11 digits (e.g. 017XXXXXXXX).`
      };
    }

    // Pathao requires min 10 characters for recipient address
    const cleanAddress = String(recipient?.address || '').trim();
    if (cleanAddress.length < 10) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { error: 'ADDRESS_TOO_SHORT' },
        error: 'Pathao requires a detailed recipient address of at least 10 characters.'
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
      const response = await this.safeFetch(`${this.baseUrl}/aladdin/api/v1/orders`, {
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
          recipient_phone: cleanPhone,
          recipient_address: cleanAddress,
          recipient_city: 1,
          recipient_zone: 1,
          delivery_type: 48,
          item_type: 1,
          special_instruction: String(recipient?.note || '').slice(0, 255),
          item_quantity: 1,
          item_weight: weightKg,
          amount_to_collect: codBdt,
          item_description: `Order #${invoiceNo}`
        })
      }, 8000);

      const data = await response.json();
      if (response.ok && data.data && data.data.consignment_id) {
        return {
          success: true,
          trackingId: String(data.data.consignment_id),
          consignmentId: String(data.data.consignment_id),
          rawResponse: CourierBaseAdapter.sanitize(data),
          error: null
        };
      }

      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: CourierBaseAdapter.sanitize(data),
        error: data.message || `Pathao booking failed: HTTP ${response.status}`
      };
    } catch (err) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        isTimeout: err.code === 'COURIER_NETWORK_TIMEOUT',
        rawResponse: { error: err.message, code: err.code },
        error: err.code === 'COURIER_NETWORK_TIMEOUT'
          ? 'Pathao booking request timed out after 8 seconds. Ambiguous state saved for reconciliation.'
          : `Pathao network error: ${err.message}`
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
      const response = await this.safeFetch(`${this.baseUrl}/aladdin/api/v1/orders/${encodeURIComponent(trackingReference)}/info`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        }
      }, 8000);

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
