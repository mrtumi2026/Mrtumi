'use strict';

const CourierBaseAdapter = require('../CourierBaseAdapter');

const MESSAGE = 'Automatic booking is only built for Pathao, Steadfast and RedX. For this courier, book in the courier\'s own panel and type the tracking ID on the order page.';

/**
 * A courier saved in admin that has no API integration. It never calls another
 * provider's API with this courier's keys and never invents a tracking number.
 */
class ManualCourierAdapter extends CourierBaseAdapter {
  async getQuote() {
    return {
      providerCode: this.providerCode, providerName: this.providerName, available: false, chargePaisa: 0, codFeePaisa: 0,
      estimatedDaysMin: 0, estimatedDaysMax: 0, isLiveQuote: false, serviceType: 'manual', reasonUnavailable: MESSAGE, notes: MESSAGE
    };
  }

  async bookShipment() {
    return { success: false, trackingId: null, consignmentId: null, rawResponse: { error: 'MANUAL_COURIER' }, error: MESSAGE };
  }

  async trackShipment(trackingReference) {
    return { trackingId: trackingReference, normalizedStatus: 'unknown', rawStatus: 'error', events: [{ status: 'error', note: MESSAGE, timestamp: new Date().toISOString() }] };
  }

  async testConnection() {
    return { ok: false, message: MESSAGE };
  }
}

module.exports = ManualCourierAdapter;
