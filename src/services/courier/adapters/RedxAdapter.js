'use strict';

const CourierBaseAdapter = require('../CourierBaseAdapter');

/**
 * RedX Courier Service Adapter.
 * Integrates with RedX Logistics API for parcel booking and tracking across Bangladesh.
 */
class RedxAdapter extends CourierBaseAdapter {
  constructor(config = {}) {
    super(config);
    this.baseUrl = this.baseUrl || 'https://openapi.redx.com.bd';
  }

  async getQuote({ origin, destination, weightGrams = 1000, codAmountPaisa = 0 }) {
    const dest = String(destination?.district || destination?.city || '').toLowerCase().trim();
    const isInsideDhaka = dest === 'dhaka' || dest.includes('dhaka city') || dest === 'ঢাকা';
    const isSubDhaka = ['gazipur', 'narayanganj', 'savar', 'keraniganj', 'tongui', 'গাজীপুর', 'নারায়ণগঞ্জ', 'সাভার'].includes(dest);
    const weightKg = Math.max(1, Math.ceil(Number(weightGrams || 1000) / 1000));

    if (weightKg > 10) {
      return {
        providerCode: this.providerCode || 'redx',
        providerName: this.providerName || 'RedX Courier',
        available: false,
        chargePaisa: 0,
        codFeePaisa: 0,
        estimatedDaysMin: 0,
        estimatedDaysMax: 0,
        isLiveQuote: false,
        serviceType: 'standard_delivery',
        reasonUnavailable: 'RedX parcel weight limit exceeded (maximum 10kg)',
        notes: 'Weight restriction exceeded'
      };
    }

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

    const extraKg = Math.max(0, weightKg - 1);
    const extraChargePaisa = extraKg * 2000;
    const totalChargePaisa = baseChargePaisa + extraChargePaisa;
    const codFeePaisa = codAmountPaisa > 0 ? Math.round(codAmountPaisa * 0.01) : 0;

    return {
      providerCode: this.providerCode || 'redx',
      providerName: this.providerName || 'RedX Courier',
      available: true,
      chargePaisa: totalChargePaisa,
      codFeePaisa,
      estimatedDaysMin: daysMin,
      estimatedDaysMax: daysMax,
      isLiveQuote: false,
      serviceType: 'standard_delivery',
      reasonUnavailable: null,
      notes: 'Standard RedX contract tariff schedule'
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
        error: 'RedX API Access Token is not configured.'
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

    const codBdt = Math.round(Number(codAmountPaisa || 0) / 100);
    const weightGrams = Math.max(500, Number(parcel?.weightGrams || 1000));

    if (this.isSandbox) {
      const trackingId = `RDX-SB-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
      return {
        success: true,
        trackingId,
        consignmentId: trackingId,
        rawResponse: {
          tracking_id: trackingId,
          message: 'Parcel created successfully in RedX Sandbox',
          status: 'success'
        },
        error: null
      };
    }

    try {
      const response = await this.safeFetch(`${this.baseUrl}/v1.0.0-beta/parcels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'API-ACCESS-TOKEN': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          customer_name: String(recipient?.name || '').trim().slice(0, 100),
          customer_phone: cleanPhone,
          delivery_area: String(recipient?.district || recipient?.city || 'Dhaka').trim(),
          customer_address: String(recipient?.address || '').trim().slice(0, 255),
          merchant_invoice_id: String(invoiceNo || subOrderId),
          cash_collection_amount: codBdt,
          parcel_weight: weightGrams,
          instruction: String(recipient?.note || `Mr. Tumi Order #${invoiceNo}`).slice(0, 255)
        })
      }, 8000);

      const data = await response.json();
      if (response.ok && data.tracking_id) {
        return {
          success: true,
          trackingId: String(data.tracking_id),
          consignmentId: String(data.tracking_id),
          rawResponse: CourierBaseAdapter.sanitize(data),
          error: null
        };
      }

      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: CourierBaseAdapter.sanitize(data),
        error: data.message || `RedX booking failed: HTTP ${response.status}`
      };
    } catch (err) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        isTimeout: err.code === 'COURIER_NETWORK_TIMEOUT',
        rawResponse: { error: err.message, code: err.code },
        error: err.code === 'COURIER_NETWORK_TIMEOUT'
          ? 'RedX booking request timed out after 8 seconds. Ambiguous state saved for reconciliation.'
          : `RedX network error: ${err.message}`
      };
    }
  }

  async reconcileBooking({ trackingId, invoiceNo, consignmentId }) {
    if (!this.apiKey || this.isSandbox) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'RedX API key unconfigured or sandbox environment'
      };
    }

    const ref = trackingId || consignmentId;
    if (!ref) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'RedX tracking reference missing for reconciliation'
      };
    }

    try {
      const response = await this.safeFetch(`${this.baseUrl}/v1.0.0-beta/parcels/tracking/${encodeURIComponent(ref)}`, {
        method: 'GET',
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${this.apiKey}`
        }
      }, 5000);

      if (response.ok) {
        const data = await response.json();
        if (data && data.tracking) {
          return {
            outcome: 'found',
            found: true,
            confirmedAbsent: false,
            trackingId: ref,
            consignmentId: ref,
            status: data.tracking.status || 'in_transit',
            rawResponse: CourierBaseAdapter.sanitize(data),
            error: null
          };
        }
      }

      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'RedX parcel status could not be verified; absence is unverified (retry blocked)'
      };
    } catch (err) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: `RedX reconciliation error: ${err.message}`
      };
    }
  }

  async trackShipment(trackingReference) {
    if (this.isSandbox) {
      return {
        trackingId: trackingReference,
        normalizedStatus: 'in_transit',
        rawStatus: 'ready_for_pickup',
        events: [
          { status: 'booked', note: 'Parcel created with RedX (Sandbox)', timestamp: new Date().toISOString() }
        ]
      };
    }

    try {
      const response = await this.safeFetch(`${this.baseUrl}/v1.0.0-beta/parcels/tracking/${encodeURIComponent(trackingReference)}`, {
        method: 'GET',
        headers: {
          'API-ACCESS-TOKEN': `Bearer ${this.apiKey}`
        }
      }, 8000);

      const data = await response.json();
      const rawStatus = data.tracking?.status || 'unknown';
      return {
        trackingId: trackingReference,
        normalizedStatus: this.normalizeStatus(rawStatus),
        rawStatus,
        events: [
          { status: rawStatus, note: `RedX: ${rawStatus}`, timestamp: new Date().toISOString() }
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

module.exports = RedxAdapter;
