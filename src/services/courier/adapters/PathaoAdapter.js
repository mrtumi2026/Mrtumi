'use strict';

const CourierBaseAdapter = require('../CourierBaseAdapter');

/**
 * Pathao Courier Service Adapter.
 * Integrates with Pathao Courier API for parcel delivery and tracking.
 */
class PathaoAdapter extends CourierBaseAdapter {
  constructor(config = {}) {
    super(config);
    this.config = config;
    this.baseUrl = this.baseUrl || 'https://courier-api.pathao.com';
    this.storeId = this.serviceOptions.store_id || 1;
    this.refreshToken = this.serviceOptions.refresh_token || config.refresh_token || null;
    this.clientId = this.serviceOptions.client_id || config.client_id || this.clientId || null;
    this.clientSecret = this.serviceOptions.client_secret || config.client_secret || this.secretKey || null;
    this.username = this.serviceOptions.username || config.username || null;
    this.password = this.serviceOptions.password || config.password || null;
  }

  /**
   * Refreshes OAuth 2.0 access token using refresh_token, client_credentials, or user credentials.
   */
  async refreshAccessToken() {
    if (this.isSandbox) {
      this.apiKey = 'pathao_sandbox_refreshed_token';
      return { success: true, accessToken: this.apiKey, refreshToken: 'pathao_sandbox_refresh_token' };
    }

    const clientId = this.clientId || this.serviceOptions.client_id || (this.config && this.config.client_id);
    const clientSecret = this.clientSecret || this.serviceOptions.client_secret || (this.config && this.config.client_secret) || this.secretKey;
    const refreshToken = this.refreshToken || this.serviceOptions.refresh_token;
    const username = this.username || this.serviceOptions.username || (this.config && this.config.username);
    const password = this.password || this.serviceOptions.password || (this.config && this.config.password);

    let payload = null;
    if (refreshToken) {
      payload = {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      };
    } else if (clientId && clientSecret && username && password) {
      payload = {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'password',
        username,
        password
      };
    } else if (clientId && clientSecret) {
      payload = {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      };
    }

    if (!payload || !clientId || !clientSecret) {
      return { success: false, error: 'Pathao OAuth credentials (client_id/client_secret) not configured for token refresh' };
    }

    try {
      const response = await this.safeFetch(`${this.baseUrl}/aladdin/api/v1/issue-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      }, 5000);

      const data = await response.json();
      if (response.ok && data && (data.access_token || data.token)) {
        const token = data.access_token || data.token;
        this.apiKey = token;
        if (data.refresh_token) {
          this.refreshToken = data.refresh_token;
        }
        return { success: true, accessToken: token, refreshToken: data.refresh_token || null };
      }
      return { success: false, error: data?.message || `Token refresh failed with HTTP ${response.status}` };
    } catch (err) {
      return { success: false, error: `Token refresh network error: ${err.message}` };
    }
  }

  /**
   * Performs an authenticated HTTP fetch. Automatically handles 401 Unauthorized
   * by refreshing the OAuth token and retrying the request once.
   */
  async authenticatedFetch(url, options = {}, timeoutMs = 8000) {
    const headers = Object.assign({}, options.headers || {}, {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json'
    });
    const opts = Object.assign({}, options, { headers });

    let response = await this.safeFetch(url, opts, timeoutMs);

    // If 401 Unauthorized and OAuth credentials exist, attempt token refresh and retry once
    const hasOAuth = Boolean((this.clientId || this.serviceOptions.client_id) && (this.clientSecret || this.serviceOptions.client_secret || this.secretKey));
    if (response.status === 401 && hasOAuth) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed.success) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        response = await this.safeFetch(url, Object.assign({}, options, { headers }), timeoutMs);
      }
    }

    return response;
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
        const response = await this.authenticatedFetch(`${this.baseUrl}/aladdin/api/v1/merchant/price-plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
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

  /**
   * Reconciles booking if a timeout or ambiguous state occurs.
   * If consignmentId is absent, uses provider-supported alternative lookup: merchant_order_id.
   * Lookup miss is strictly treated as unknown_error (never assumed absent).
   */
  async reconcileBooking({ consignmentId, invoiceNo, trackingId }) {
    if (!this.apiKey) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'Pathao API Bearer token unconfigured'
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
        error: 'Pathao sandbox does not provide authoritative absence reconciliation'
      };
    }

    const queryConsignment = consignmentId || trackingId;
    const queryMerchantOrder = invoiceNo;

    if (!queryConsignment && !queryMerchantOrder) {
      return {
        outcome: 'unknown_error',
        found: false,
        confirmedAbsent: false,
        trackingId: null,
        consignmentId: null,
        status: null,
        rawResponse: null,
        error: 'Neither consignmentId nor merchant_order_id (invoiceNo) provided for Pathao reconciliation'
      };
    }

    try {
      // 1. Primary lookup by consignment_id if available
      if (queryConsignment) {
        const response = await this.authenticatedFetch(`${this.baseUrl}/aladdin/api/v1/orders/${encodeURIComponent(queryConsignment)}/info`, {
          method: 'GET'
        }, 5000);

        if (response.ok) {
          const data = await response.json();
          if (data && data.data && data.data.consignment_id) {
            return {
              outcome: 'found',
              found: true,
              confirmedAbsent: false,
              trackingId: String(data.data.consignment_id),
              consignmentId: String(data.data.consignment_id),
              status: data.data.order_status,
              rawResponse: CourierBaseAdapter.sanitize(data),
              error: null
            };
          }
        }
      }

      // 2. Alternative lookup by merchant_order_id (provider-supported fallback)
      if (queryMerchantOrder) {
        const altResponse = await this.authenticatedFetch(`${this.baseUrl}/aladdin/api/v1/orders?merchant_order_id=${encodeURIComponent(queryMerchantOrder)}`, {
          method: 'GET'
        }, 5000);

        if (altResponse.ok) {
          const altData = await altResponse.json();
          const match = altData?.data?.data?.[0] || altData?.data?.[0] || (altData?.data?.consignment_id ? altData.data : null);
          if (match && match.consignment_id) {
            return {
              outcome: 'found',
              found: true,
              confirmedAbsent: false,
              trackingId: String(match.consignment_id),
              consignmentId: String(match.consignment_id),
              status: match.order_status,
              rawResponse: CourierBaseAdapter.sanitize(altData),
              error: null
            };
          }
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
        error: 'Pathao order not found by consignment ID or merchant_order_id; absence is unverified (retry blocked)'
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
        error: `Pathao reconciliation network error: ${err.message}`
      };
    }
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
      const response = await this.authenticatedFetch(`${this.baseUrl}/aladdin/api/v1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
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
      const response = await this.authenticatedFetch(`${this.baseUrl}/aladdin/api/v1/orders/${encodeURIComponent(trackingReference)}/info`, {
        method: 'GET'
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
