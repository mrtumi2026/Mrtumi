# INTEGRATION STATUS — Mr. Tumi Grocery & Gift

**Last Updated:** 2026-10-25 (`Asia/Dhaka`)

Per **Fundamental Rules 5, 10, 11, 12, and 25**, no external provider integration is marked live until verified against the real provider with owner-supplied credentials and outbound network connectivity.

**Phase 02 Hygiene Update:** All mock/placeholder token strings (`BSMS-LIVE-...`, `BDC-PRO-...`, `SF-LIVE-KEY-...`, `PTH-CLIENT-...`, `REDX-TOKEN-...`, `EAAGm...`) and fake live balances from the pre-Phase-01 prototype were purged in Phase 02. Unconfigured integrations now initialize cleanly with blank keys (`''`), zero balance (`0`), and inactive status (`0` / `Not Configured`).

| Integration | Category | Target Phase | Adapter Code Status | Credentials Provided? | Outbound Connectivity (`BestWebHostBD`) | Current Overall Status |
|---|---|---|---|---|---|---|
| **Steadfast Courier** | Courier | Phase 10 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **Pathao Courier** | Courier | Phase 10 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **RedX Courier** | Courier | Phase 10 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **bKash Checkout** | Payment Gateway | Phase 11 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **ShurjoPay** | Payment Gateway | Phase 11 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **UddoktaPay** | Payment Gateway | Phase 11 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **Cash on Delivery (COD)** | Internal Payment | Phase 11 | `NOT STARTED` (Hardening in P08/P11) | N/A | Internal | `NOT STARTED` |
| **Manual Mobile Banking (`TrxID`)** | Manual Payment | Phase 11 | `NOT STARTED` (Hardening in P11) | N/A | Internal | `NOT STARTED` |
| **BD Courier Fraud Checker** | Fraud / Risk API | Phase 12 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **BulkSMSBD** | SMS Gateway | Phase 13 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `BLOCKED` |
| **Meta Pixel & Facebook CAPI** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | `UNVERIFIED` on BestWebHostBD | `NOT STARTED` |
| **Google Tag Manager (GTM)** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | Browser-side | `NOT STARTED` |
| **TikTok Pixel** | Attribution / Ads | Phase 14 | `NOT STARTED` | No | Browser-side | `NOT STARTED` |
| **SMTP Transactional Email** | Email | Phase 18 | `NOT STARTED` | No | `UNVERIFIED` (ports `465`/`587`) | `BLOCKED` |
