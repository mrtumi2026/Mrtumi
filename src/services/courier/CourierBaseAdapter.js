'use strict';

/**
 * Base abstract adapter for courier service integrations.
 * Provides unified contract for real-time / configured quote comparison,
 * serviceability checks, one-click booking, timeout handling, and tracking synchronization.
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
   * Safe fetch with explicit timeout and AbortController to prevent hanging requests.
   * Ensures API credentials are never leaked in network errors.
   */
  async safeFetch(url, options = {}, timeoutMs = 8000) {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = controller ? controller.signal : undefined;

    let timeoutHandle = null;
    if (controller && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
    }

    try {
      const response = await fetchFn(url, {
        ...options,
        signal
      });
      return response;
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        const timeoutError = new Error(`Courier API request timed out after ${timeoutMs}ms`);
        timeoutError.code = 'COURIER_NETWORK_TIMEOUT';
        throw timeoutError;
      }
      const netError = new Error(`Courier API network error: ${err.message}`);
      netError.code = 'COURIER_NETWORK_ERROR';
      throw netError;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Deeply sanitizes objects to redact sensitive secrets before logging or storing in DB.
   */
  static sanitize(data) {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data)) return data.map(item => CourierBaseAdapter.sanitize(item));

    const sanitized = {};
    const sensitivePatterns = /api[-_]?key|secret[-_]?key|secret|token|password|auth|authorization/i;

    for (const [key, value] of Object.entries(data)) {
      if (sensitivePatterns.test(key) && typeof value === 'string') {
        sanitized[key] = '[REDACTED]';
      } else if (value && typeof value === 'object') {
        sanitized[key] = CourierBaseAdapter.sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * Calculate or fetch delivery quote.
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
   */
  async bookShipment(_bookingPayload) {
    throw new Error(`bookShipment not implemented for adapter ${this.providerCode}`);
  }

  /**
   * Reconcile an existing or timed-out booking attempt with provider before retrying.
   * Returns: { found: boolean, trackingId: string | null, consignmentId: string | null, status: string | null }
   */
  async reconcileBooking(_query) {
    return { found: false, trackingId: null, consignmentId: null, status: null };
  }

  /**
   * Query status from provider.
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
    if (['in_transit', 'transit', 'on_the_way', 'out_for_delivery', 'picked_up', 'dispatched', 'in_review', 'delivered_approval_pending'].includes(s)) return 'in_transit';
    if (['cancelled', 'rejected', 'canceled', 'cancelled_approval_pending'].includes(s)) return 'cancelled';
    if (['returned', 'return_received', 'return_completed'].includes(s)) return 'returned';
    if (['failed', 'delivery_failed', 'undelivered'].includes(s)) return 'failed_delivery';
    if (['booked', 'pending', 'order_placed', 'pickup_requested'].includes(s)) return 'booked';
    return 'in_transit';
  }
}

module.exports = CourierBaseAdapter;
