'use strict';

/**
 * Base abstract adapter for courier service integrations.
 * Provides unified contract for real-time / configured quote comparison,
 * serviceability checks, one-click booking, and tracking synchronization.
 */
class CourierBaseAdapter {
  constructor(config = {}) {
    this.providerCode = String(config.code || '').trim().toLowerCase();
    this.providerName = String(config.name || '').trim();
    this.providerType = String(config.provider_type || config.code || '').trim().toLowerCase();
    this.baseUrl = String(config.base_url || '').trim();
    this.apiKey = String(config.api_key || '').trim();
    this.secretKey = String(config.secret_key || '').trim();
    this.clientId = String(config.client_id || '').trim();
    this.isSandbox = Boolean(Number(config.sandbox || 0));
    this.supportsLiveQuotes = Boolean(Number(config.supports_live_quotes || 0));
    this.serviceOptions = config.service_options_json
      ? (typeof config.service_options_json === 'string' ? JSON.parse(config.service_options_json) : config.service_options_json)
      : {};
  }

  /**
   * Calculate or fetch delivery quote.
   * Returns:
   *   available: boolean
   *   chargePaisa: number (integer paisa)
   *   codFeePaisa: number (integer paisa)
   *   estimatedDaysMin: number
   *   estimatedDaysMax: number
   *   isLiveQuote: boolean (true if from live provider API, false if from contract rate schedule)
   *   serviceType: string
   *   reasonUnavailable: string | null
   *   notes: string
   */
  async getQuote(_shipmentDetails) {
    throw new Error(`getQuote not implemented for adapter ${this.providerCode}`);
  }

  /**
   * Check if delivery route is serviceable.
   */
  async checkServiceability(_route) {
    return { serviceable: true, reason: null };
  }

  /**
   * Execute shipment booking with provider.
   * Returns:
   *   success: boolean
   *   trackingId: string
   *   consignmentId: string
   *   rawResponse: object
   *   error: string | null
   */
  async bookShipment(_bookingPayload) {
    throw new Error(`bookShipment not implemented for adapter ${this.providerCode}`);
  }

  /**
   * Query status from provider.
   * Returns:
   *   trackingId: string
   *   normalizedStatus: 'booked' | 'ready_for_pickup' | 'in_transit' | 'delivered' | 'failed_delivery' | 'cancelled'
   *   rawStatus: string
   *   events: Array<{ status: string, note: string, timestamp: string }>
   */
  async trackShipment(_trackingReference) {
    throw new Error(`trackShipment not implemented for adapter ${this.providerCode}`);
  }

  /**
   * Normalize provider raw status to platform canonical fulfillment status.
   */
  normalizeStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase().trim();
    if (['delivered', 'successful', 'complete', 'completed', 'partial_delivered'].includes(s)) return 'delivered';
    if (['in_transit', 'transit', 'on_the_way', 'out_for_delivery', 'picked_up', 'dispatched'].includes(s)) return 'in_transit';
    if (['cancelled', 'rejected', 'canceled'].includes(s)) return 'cancelled';
    if (['returned', 'return_received'].includes(s)) return 'returned';
    if (['failed', 'delivery_failed', 'undelivered'].includes(s)) return 'failed_delivery';
    if (['booked', 'pending', 'order_placed', 'in_review'].includes(s)) return 'booked';
    return 'in_transit';
  }
}

module.exports = CourierBaseAdapter;
