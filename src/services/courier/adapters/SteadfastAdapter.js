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
   * Steadfast does not provide a dynamic quote API endpoint in v1;
   * it operates on standard zone tariff slabs.
   * We return the contracted tariff clearly marked as isLiveQuote = false.
   */
  async getQuote({ origin, destination, weightGrams = 1000, codAmountPaisa = 0 }) {
    const dest = String(destination?.district || destination?.city || '').toLowerCase().trim();
    const isInsideDhaka = dest === 'dhaka' || dest.includes('dhaka city') || dest === 'ঢাকা';
    const isSubDhaka = ['gazipur', 'narayanganj', 'savar', 'keraniganj', 'tongui', 'গাজীপুর', 'নারায়ণগঞ্জ', 'সাভার'].includes(dest);
    const weightKg = Math.max(1, Math.ceil(Number(weightGrams || 1000) / 1000));

    // Restriction check
    if (weightKg > 15) {
      return {
        providerCode: this.providerCode || 'steadfast',
        providerName: this.providerName || 'Steadfast Courier',
        available: false,
        chargePaisa: 0,
        codFeePaisa: 0,
        estimatedDaysMin: 0,
        estimatedDaysMax: 0,
        isLiveQuote: false,
        serviceType: 'standard_doorstep',
        reasonUnavailable: 'Steadfast standard parcel limit exceeded (maximum 15kg)',
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

    // Additional weight: ৳20 per kg above 1kg
    const extraKg = Math.max(0, weightKg - 1);
    const extraChargePaisa = extraKg * 2000;
    const totalChargePaisa = baseChargePaisa + extraChargePaisa;

    // COD fee: 1% of COD amount
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
    return { serviceable: true, reason: null };
  }

  /**
   * Reconciles booking if a timeout or ambiguous state occurs.
   * NOTE: Steadfast lookup miss is never treated as confirmed absence because invoice reference
   * indexing semantics can have queue lag; miss is treated strictly as unknown_error.
   */
  async reconcileBooking({ invoiceNo, consignmentId, trackingId }) {
    if (!this.apiKey || !this.secretKey) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'Steadfast API credentials unconfigured'
      };
    }

    if (this.isSandbox) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'Steadfast sandbox does not provide authoritative absence reconciliation'
      };
    }

    const queryKey = consignmentId || invoiceNo || trackingId;
    if (!queryKey) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'Missing invoiceNo or consignmentId for Steadfast reconciliation'
      };
    }

    try {
      const endpoint = consignmentId
        ? `${this.baseUrl}/status_by_cid/${encodeURIComponent(consignmentId)}`
        : `${this.baseUrl}/status_by_invoice/${encodeURIComponent(invoiceNo)}`;

      const response = await this.safeFetch(endpoint, {
        method: 'GET',
        headers: {
          'Api-Key': this.apiKey,
          'Secret-Key': this.secretKey,
          'Accept': 'application/json'
        }
      }, 5000);

      if (response.ok) {
        const data = await response.json();
        if (data && (data.status === 200 || data.delivery_status)) {
          return {
            outcome: 'found',
            found: true,
            confirmedAbsent: false,
            trackingId: String(data.tracking_code || invoiceNo),
            consignmentId: String(data.consignment_id || ''),
            status: data.delivery_status || 'in_review',
            rawResponse: CourierBaseAdapter.sanitize(data),
            error: null
          };
        }
      }

      // If response is 404 or parcel not found: lookup miss is NOT confirmed absence!
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'Steadfast status query returned no active parcel; absence is unverified (retry blocked)'
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
        error: `Steadfast reconciliation network error: ${err.message}`
      };
    }
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
    const payload = {
      invoice: String(invoiceNo || subOrderId || '').slice(0, 100),
      recipient_name: String(recipient?.name || '').trim().slice(0, 100),
      recipient_phone: cleanPhone,
      recipient_address: String(recipient?.address || '').trim().slice(0, 255),
      cod_amount: codBdt,
      note: String(recipient?.note || `Mr. Tumi Order #${invoiceNo}`).slice(0, 255)
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
      const response = await this.safeFetch(`${this.baseUrl}/create_order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': this.apiKey,
          'Secret-Key': this.secretKey
        },
        body: JSON.stringify(payload)
      }, 8000);

      const data = await response.json();
      if (response.ok && data.status === 200 && data.consignment) {
        return {
          success: true,
          trackingId: data.consignment.tracking_code || String(data.consignment.consignment_id),
          consignmentId: String(data.consignment.consignment_id),
          rawResponse: CourierBaseAdapter.sanitize(data),
          error: null
        };
      }

      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: CourierBaseAdapter.sanitize(data),
        error: data.message || (data.errors ? JSON.stringify(data.errors) : `Steadfast booking failed (HTTP ${response.status})`)
      };
    } catch (err) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        isTimeout: err.code === 'COURIER_NETWORK_TIMEOUT',
        rawResponse: { error: err.message, code: err.code },
        error: err.code === 'COURIER_NETWORK_TIMEOUT'
          ? 'Steadfast booking request timed out after 8 seconds. Ambiguous state saved for reconciliation.'
          : `Steadfast network error: ${err.message}`
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
      const response = await this.safeFetch(`${this.baseUrl}/status_by_trackingcode/${encodeURIComponent(trackingReference)}`, {
        method: 'GET',
        headers: {
          'Api-Key': this.apiKey,
          'Secret-Key': this.secretKey
        }
      }, 8000);

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
