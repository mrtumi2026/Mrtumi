'use strict';

const CourierBaseAdapter = require('../CourierBaseAdapter');

/**
 * Mock Courier Adapter for test suites, QA sandboxing, and offline development.
 * Allows predictable quote comparison, serviceability checks, booking, timeout simulation,
 * unknown outcome reconciliation, and tracking without external API dependencies.
 */
class MockCourierAdapter extends CourierBaseAdapter {
  constructor(config = {}) {
    super(config);
    this.isMock = true;
    this.isSandbox = config.sandbox !== undefined ? Boolean(Number(config.sandbox)) : true;
    this.apiKey = this.apiKey || 'mock_test_key';
    this.rateProfile = config.rate_profile || 'standard'; // 'express', 'budget', 'standard'
  }

  async checkServiceability({ origin, destination }) {
    const destDistrict = String(destination?.district || destination?.city || '').toLowerCase().trim();
    if (destDistrict === 'unserviceable_zone') {
      return { serviceable: false, reason: 'Destination zone outside delivery network coverage' };
    }
    return { serviceable: true, reason: null };
  }

  async getQuote({ origin, destination, weightGrams = 1000, codAmountPaisa = 0 }) {
    const serviceability = await this.checkServiceability({ origin, destination });
    if (!serviceability.serviceable) {
      return {
        providerCode: this.providerCode || 'mock_courier',
        providerName: this.providerName || 'Mock Courier Services',
        available: false,
        chargePaisa: 0,
        codFeePaisa: 0,
        estimatedDaysMin: 0,
        estimatedDaysMax: 0,
        isLiveQuote: true,
        serviceType: 'standard',
        reasonUnavailable: serviceability.reason,
        notes: 'Area not serviceable'
      };
    }

    const dest = String(destination?.district || destination?.city || '').toLowerCase();
    const isInsideDhaka = dest.includes('dhaka');
    const weightKg = Math.max(1, Math.ceil(Number(weightGrams || 1000) / 1000));

    let baseChargePaisa = 6000; // ৳60
    let daysMin = 1;
    let daysMax = 2;

    if (this.rateProfile === 'express') {
      baseChargePaisa = isInsideDhaka ? 10000 : 15000; // ৳100 / ৳150
      daysMin = 1;
      daysMax = isInsideDhaka ? 1 : 2;
    } else if (this.rateProfile === 'budget') {
      baseChargePaisa = isInsideDhaka ? 5000 : 9000; // ৳50 / ৳90
      daysMin = isInsideDhaka ? 2 : 4;
      daysMax = isInsideDhaka ? 3 : 5;
    } else {
      // standard
      baseChargePaisa = isInsideDhaka ? 6000 : 11000; // ৳60 / ৳110
      daysMin = isInsideDhaka ? 1 : 2;
      daysMax = isInsideDhaka ? 2 : 3;
    }

    // Additional weight charge: ৳20 (2000 paisa) per extra kg over 1kg
    const extraKg = Math.max(0, weightKg - 1);
    const weightChargePaisa = extraKg * 2000;
    const totalChargePaisa = baseChargePaisa + weightChargePaisa;

    // COD fee: 1% of COD amount if applicable, min 0
    const codFeePaisa = codAmountPaisa > 0 ? Math.round(codAmountPaisa * 0.01) : 0;

    return {
      providerCode: this.providerCode || 'mock_courier',
      providerName: this.providerName || 'Mock Courier Services',
      available: true,
      chargePaisa: totalChargePaisa,
      codFeePaisa,
      estimatedDaysMin: daysMin,
      estimatedDaysMax: daysMax,
      isLiveQuote: true,
      serviceType: this.rateProfile,
      reasonUnavailable: null,
      notes: `Mock quote for ${weightKg}kg to ${isInsideDhaka ? 'Dhaka' : 'Outside Dhaka'}`
    };
  }

  async reconcileBooking({ invoiceNo }) {
    if (invoiceNo && invoiceNo.includes('REC-FOUND')) {
      const trackingId = `MCK-REC-${Date.now()}`;
      return {
        outcome: 'found',
        found: true,
        confirmedAbsent: false,
        trackingId,
        consignmentId: `CN-${trackingId}`,
        status: 'in_review',
        rawResponse: { simulated: true, outcome: 'found' },
        error: null
      };
    }
    if (invoiceNo && invoiceNo.includes('REC-ABSENT')) {
      return {
        outcome: 'confirmed_absent',
        found: false,
        confirmedAbsent: true,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: { simulated: true, outcome: 'confirmed_absent' },
        error: null
      };
    }
    return {
      outcome: 'unknown_error',
      found: false,
      confirmedAbsent: false,
      trackingId: null,
      consignmentId: null,
      status: null,
      rawResponse: { simulated: true, outcome: 'unknown_error' },
      error: 'Mock provider reconciliation inconclusive (unverified absence)'
    };
  }

  async bookShipment({ shipmentId, subOrderId, invoiceNo, recipient, parcel, codAmountPaisa, idempotencyKey }) {
    if (!this.apiKey && !this.isSandbox) {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { error: 'PROVIDER_CREDENTIALS_MISSING' },
        error: 'Mock courier credentials unconfigured'
      };
    }

    const phone = String(recipient?.phone || '');

    // Edge-case trigger 1: Rejection
    if (phone === '01999999999') {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        rawResponse: { code: 'SIMULATED_REJECTION', message: 'Simulated courier booking rejection' },
        error: 'Simulated courier booking rejection'
      };
    }

    // Edge-case trigger 2: Simulated timeout
    if (phone === '01800000000') {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        isTimeout: true,
        rawResponse: { code: 'SIMULATED_TIMEOUT', message: 'Simulated 8000ms network timeout' },
        error: 'Simulated 8000ms network timeout'
      };
    }

    // Edge-case trigger 3: Simulated unknown booking outcome
    if (phone === '01811111111') {
      return {
        success: false,
        trackingId: null,
        consignmentId: null,
        isUnknownOutcome: true,
        rawResponse: { code: 'SIMULATED_UNKNOWN_OUTCOME', message: 'Carrier acknowledged request but connection dropped before response' },
        error: 'Unknown outcome: carrier connection dropped before confirmation'
      };
    }

    const trackingId = `MCK-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const consignmentId = `CN-${subOrderId || '0'}-${Math.floor(10000 + Math.random() * 90000)}`;

    return {
      success: true,
      trackingId,
      consignmentId,
      rawResponse: {
        status: 'success',
        message: 'Order created successfully in Mock Courier',
        tracking_code: trackingId,
        consignment_id: consignmentId,
        invoice_no: invoiceNo,
        idempotency_key: idempotencyKey,
        booked_at: new Date().toISOString()
      },
      error: null
    };
  }

  async trackShipment(trackingReference) {
    const ref = String(trackingReference || '');
    let status = 'in_transit';
    let note = 'Parcel dispatched from hub';

    if (ref.includes('MCK-DEL')) {
      status = 'delivered';
      note = 'Parcel delivered to recipient';
    } else if (ref.includes('MCK-FAIL')) {
      status = 'failed_delivery';
      note = 'Delivery attempt failed: recipient unreachable';
    } else if (ref.includes('MCK-RET')) {
      status = 'returned';
      note = 'Parcel returned to origin / vendor';
    } else if (ref.includes('MCK-CAN')) {
      status = 'cancelled';
      note = 'Delivery cancelled by courier';
    }

    return {
      trackingId: trackingReference,
      normalizedStatus: status,
      rawStatus: status,
      events: [
        { status: 'booked', note: 'Consignment booked with mock courier', timestamp: new Date(Date.now() - 3600000).toISOString() },
        { status, note, timestamp: new Date().toISOString() }
      ]
    };
  }
}

module.exports = MockCourierAdapter;
