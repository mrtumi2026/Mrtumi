# INTEGRATION STATUS — Mr. Tumi Grocery & Gift

**Last Updated:** 2026-10-26 (`Asia/Dhaka`)

Per **Fundamental Rules 5, 10, 11, 12, and 25**, no external provider integration is marked live until verified against the real provider with owner-supplied credentials and verified outbound connectivity on BestWebHostBD.

| Integration | Category | Target Phase | Adapter Code Status | Credentials Provided? | Outbound Connectivity (`BestWebHostBD`) | Current Overall Status |
|---|---|---|---|---|---|---|
| **Steadfast Courier** | Courier | Phase 10 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **Pathao Courier** | Courier | Phase 10 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **RedX Courier** | Courier | Phase 10 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **bKash Checkout** | Payment Gateway | Phase 11 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **ShurjoPay** | Payment Gateway | Phase 11 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **UddoktaPay** | Payment Gateway | Phase 11 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **Cash on Delivery (COD)** | Internal Payment | Phase 07/11 | `PARTIAL` — canonical MySQL checkout records unpaid orders and full COD due only when an active `code='cod'` row exists; no collection/reconciliation settlement workflow | N/A | Internal | `PARTIAL — CONFIGURATION REQUIRED` |
| **Manual Mobile Banking (`TrxID`)** | Manual Payment | Phase 11 | `NOT STARTED` (Hardening in P11) | N/A | Internal | `NOT STARTED` |
| **BD Courier Fraud Checker** | Fraud / Risk API | Phase 12 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **BulkSMSBD** | SMS Gateway | Phase 13 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `BLOCKED` |
| **Meta Pixel & Facebook CAPI** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | `UNVERIFIED` (`U-07`) | `NOT STARTED` |
| **Google Tag Manager (GTM)** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | Browser-side | `NOT STARTED` |
| **TikTok Pixel** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | Browser-side | `NOT STARTED` |
| **SMTP Transactional Email** | Email | Phase 18 | `NOT STARTED` | No | `UNVERIFIED` (`465`/`587`) | `BLOCKED` |
