# INTEGRATION STATUS — Mr. Tumi Grocery & Gift

**Last Updated:** 2026-11-05 (`Asia/Dhaka`)  
**Repository:** `mrtumi2026/Mrtumi` (Branch: `antigravity/final-launch-readiness`)  

Per **Fundamental Rules 5, 10, 11, 12, and 25**, no external provider integration is marked live until verified against the real provider with owner-supplied credentials and verified outbound connectivity on BestWebHostBD. All external network adapters implement strict fail-closed defaults, preventing any accidental live charges, duplicate courier bookings, or unconsented data sharing.

---

## 1. Provider Integrations Status Matrix

| Integration | Category | Target Phase | Implementation Status | Contract / Mock Verified? | Outbound Connectivity (`BestWebHostBD`) | Operational Launch Status |
|---|---|---|---|:---:|:---:|---|
| **Mock Courier** | Internal Testing | Phase 10 | `TESTED AND PASSED` | ✅ Full Lifecycle | Internal | `OPERATIONAL FOR TESTING` |
| **Steadfast Courier** | Courier | Phase 10 | `TESTED AND PASSED` | ✅ Contract Verified | `UNVERIFIED` (Awaiting Keys) | `CODE-READY — AWAITING LIVE KEYS` |
| **Pathao Courier** | Courier | Phase 10 | `TESTED AND PASSED` | ✅ OAuth Refresh Verified | `UNVERIFIED` (Awaiting Keys) | `CODE-READY — AWAITING LIVE KEYS` |
| **RedX Courier** | Courier | Phase 10 | `TESTED AND PASSED` | ✅ Contract Verified | `UNVERIFIED` (Awaiting Keys) | `CODE-READY — AWAITING LIVE KEYS` |
| **Cash on Delivery (COD)** | Internal Payment | Phase 07/11 | `TESTED AND PASSED` | ✅ Server Paisa Verified | Internal | `READY FOR LAUNCH` |
| **Manual MFS (bKash/Nagad)** | Internal Payment | Phase 11/20 | `TESTED AND PASSED` | ✅ Action Center Verified | Internal | `READY FOR LAUNCH` |
| **bKash Tokenized Checkout** | Payment Gateway | Phase 11 | `IN PROGRESS` | ⚠️ Mock Verified | `UNVERIFIED` (Awaiting Keys) | `CODE-READY — AWAITING MERCHANT KEYS` |
| **ShurjoPay** | Payment Gateway | Phase 11 | `IN PROGRESS` | ⚠️ Mock Verified | `UNVERIFIED` (Awaiting Keys) | `CODE-READY — AWAITING MERCHANT KEYS` |
| **UddoktaPay** | Payment Gateway | Phase 11 | `IN PROGRESS` | ⚠️ Mock Verified | `UNVERIFIED` (Awaiting Keys) | `CODE-READY — AWAITING MERCHANT KEYS` |
| **Bulk SMS BD** | SMS Gateway | Phase 13 | `TESTED AND PASSED` | ✅ Format & Redaction | `UNVERIFIED` (Awaiting Sender ID) | `CODE-READY — DISPATCH DISABLED` |
| **BDCourier Fraud Check** | Fraud Prevention | Phase 12 | `TESTED AND PASSED` | ✅ IP/Phone Block Center | `UNVERIFIED` (Awaiting API Key) | `INTERNAL BLOCK READY` |
| **First-Party Attribution** | Analytics | Phase 14 | `TESTED AND PASSED` | ✅ Session UTM Verified | Internal | `READY (DEFAULT-OFF PENDING D6)` |
| **Meta Pixel & CAPI** | Ad Tracking | Phase 14 | `IN PROGRESS` | ⚠️ Event Structure Ready | `UNVERIFIED` (Awaiting Pixel ID) | `DISABLED PENDING D6 & PIXEL ID` |

---

## 2. Integration Verification Summary

1. **Multi-Courier Engine:**
   - Unified `CourierBaseAdapter` handles phone normalization (`01XXXXXXXXX`), weight limits (0.1–50 kg), address sanitization, and credential redaction.
   - `PathaoAdapter` includes automatic Bearer token refresh upon receiving HTTP 401 Unauthorized, re-issuing credentials once before concluding error.
   - Idempotent booking table `fulfillment_shipments` and tri-state reconciliation guarantee no duplicate parcel creation on network timeout.
2. **Payment Processing:**
   - COD orders calculate exact integer-paisa totals, apply delivery fees based on verified delivery locations, and record initial state as `unpaid` with full COD due.
   - Direct digital payment APIs (bKash, Shurjopay, UddoktaPay) remain fail-closed with zero mock successes masquerading as real settlement.
3. **SMS & Alerts:**
   - `VENDOR_OTP_SMS_ENABLED=false` by default. Credentials and OTP values are excluded from all server logs.
