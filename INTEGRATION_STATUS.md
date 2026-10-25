# INTEGRATION STATUS — Mr. Tumi Grocery & Gift

Per **Fundamental Rules 5, 10, 11, 12, and 25**, no external provider integration is ever marked live until verified against the real provider with owner-supplied credentials and outbound network access.

**Sandbox Network Note:** The current Arena development sandbox restricts outbound internet to `github.com`, `npmjs.org`, and `pypi.org`. Therefore, all external Bangladesh courier, payment, fraud, and SMS adapters will be built cleanly against official provider request/response contracts with configuration UI, webhook signature validation, and mocked contract tests in Phases 10–14, and verified live on staging/owner hosting once credentials are supplied.

| Integration | Category | Target Phase | Adapter Code Status | Credentials Provided? | Live / Sandbox Verification | Current Overall Status |
|---|---|---|---|---|---|---|
| **Steadfast Courier** | Courier | Phase 10 | `NOT STARTED` (Prototype stub only) | No | Not Tested | `BLOCKED` |
| **Pathao Courier** | Courier | Phase 10 | `NOT STARTED` (Prototype stub only) | No | Not Tested | `BLOCKED` |
| **RedX Courier** | Courier | Phase 10 | `NOT STARTED` | No | Not Tested | `BLOCKED` |
| **bKash Checkout** | Payment Gateway | Phase 11 | `NOT STARTED` | No | Not Tested | `BLOCKED` |
| **ShurjoPay** | Payment Gateway | Phase 11 | `NOT STARTED` | No | Not Tested | `BLOCKED` |
| **UddoktaPay** | Payment Gateway | Phase 11 | `NOT STARTED` | No | Not Tested | `BLOCKED` |
| **Cash on Delivery (COD)** | Internal Payment | Phase 11 | `NOT STARTED` (Hardening in P08/P11) | N/A (Internal) | Scheduled P11 | `NOT STARTED` |
| **Manual Mobile Banking (bKash/Nagad/Rocket TrxID)** | Manual Payment | Phase 11 | `NOT STARTED` (Hardening in P11) | N/A (Admin-verified) | Scheduled P11 | `NOT STARTED` |
| **BD Courier Fraud Checker** | Fraud / Risk API | Phase 12 | `NOT STARTED` (Prototype stub only) | No | Not Tested | `BLOCKED` |
| **BulkSMSBD** | SMS Gateway | Phase 13 | `NOT STARTED` (Prototype stub only) | No | Not Tested | `BLOCKED` |
| **Meta Pixel & Facebook CAPI** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | Not Tested | `NOT STARTED` |
| **Google Tag Manager (GTM)** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | Not Tested | `NOT STARTED` |
| **TikTok Pixel** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | Not Tested | `NOT STARTED` |
| **SMTP Transactional Email** | Email | Phase 18 | `NOT STARTED` | No | Not Tested | `BLOCKED` |
