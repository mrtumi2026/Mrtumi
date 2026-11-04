# Courier & Delivery Management Subsystem

**Project:** Mr. Tumi Grocery & Gift (`mrtumi.com`)
**Branch:** `antigravity/courier-hardening`
**Migration Baseline:** 0029 (`0029_multi_courier_engine.up.sql`)
**Engines Supported:** MySQL 8.0 (InnoDB) and MariaDB 10.11 (InnoDB)

---

## 1. Subsystem Architecture Overview

The Courier & Delivery Management Subsystem orchestrates multi-carrier parcel fulfillment across Mr. Tumi's multi-vendor marketplace in Bangladesh. It connects vendor sub-orders, external courier logistics APIs, warehouse handovers, customer tracking, and cash-on-delivery (COD) accounting.

```
                    ┌─────────────────────────┐
                    │ Customer Tracking Views │
                    └───────────▲─────────────┘
                                │
                    ┌───────────┴─────────────┐
                    │      Parent Orders      │
                    └───────────▲─────────────┘
                                │ (Sync status & tracking)
                    ┌───────────┴─────────────┐
                    │    Vendor Sub-Orders    │
                    └───────────▲─────────────┘
                                │
                    ┌───────────┴─────────────┐
                    │  fulfillment_shipments  │
                    │   (Row Locks & States)  │
                    └─────▲─────────────▲─────┘
                          │             │
        ┌─────────────────┴─┐         ┌─┴────────────────┐
        │  Multi-Courier    │         │ Courier COD      │
        │  Adapters         │         │ Collections      │
        │ (Steadfast,Pathao,│         │ (Remittance &    │
        │  RedX, Mock)      │         │  Settlements)    │
        └───────────────────┘         └──────────────────┘
```

### Supported Providers & Adapters
1. **Mock Courier Adapter (`mock_courier`):**
   - Deterministic fixtures for test environments and staging without external internet dependency.
   - Handles simulated serviceability, dynamic rate calculation, one-click booking, tracking, and deterministic tri-state reconciliation (`REC-FOUND`, `REC-ABSENT`, `REC-ERROR`).
2. **Steadfast Adapter (`steadfast`):**
   - Implements Steadfast Courier API (`create_order`, `status_by_cid`, `status_by_trackingcode`).
   - Contract tariff calculation fallback when live rate endpoint is unavailable.
   - Enforces phone number format (`01XXXXXXXXX`) and delivery area validation.
3. **Pathao Adapter (`pathao`):**
   - Implements Pathao Courier API with OAuth client token authentication.
   - Supports price estimation (`order/calculate-price`), parcel creation, tracking, and order lookup.
4. **RedX Adapter (`redx`):**
   - Implements RedX Logistics API (`/parcel`, `/parcel/track`).
   - Contract schedule fallback when sandbox or live pricing is offline.
   - Sanitizes and formats weight and pickup store references.

---

## 2. Admin Courier Configuration & Management

Authorized administrators manage courier configurations under `/admin/courierapi/manage`.

### Security & Governance
- **RBAC Enforced:** Access requires `settings.manage` permission; unauthorized staff requests return 403.
- **CSRF Protected:** All state mutations (`create`, `update`, `toggle`, `delete`) require CSRF token validation.
- **Credential Masking:** Secret keys and API tokens are never sent in plain text to HTML views; keys are masked with bullet prefixes (`••••••••1234`).
- **Live Quotes & Options:** Admin can toggle `supports_live_quotes` (0 or 1) and specify provider service options in valid JSON format.

---

## 3. Vendor Delivery & Fulfillment Workflow

Vendors manage their assigned sub-orders independently through `/vendor/orders`.

1. **Order Acceptance & Packaging:**
   - Vendor transitions sub-order: `order_placed` → `vendor_accepted` → `processing` → `packed` → `ready_for_pickup`.
2. **Quote Comparison & Recommendation:**
   - At `ready_for_pickup`, vendor clicks **Compare & Book Courier**.
   - `CourierRecommendationEngine` evaluates all active providers, ranks them by total cost, speed, and reliability, and provides transparent explanations (e.g. "Lowest cost with high delivery success").
3. **One-Click Booking:**
   - Vendor clicks **Book Now** on the recommended option or chooses an alternative.
   - Generates an `idempotency_key` preventing double submissions.
   - Atomically locks `fulfillment_shipments` `FOR UPDATE`.
   - Records `booking_status = 'succeeded'`, `tracking_id`, and syncs carrier code to `vendor_sub_orders`.
4. **Separation of Booking & Physical Handover (Phase B Contract):**
   - Courier booking DOES NOT equal parcel pickup.
   - Sub-order status remains `ready_for_pickup`.
   - Vendor confirms physical handover ONLY when the courier rider arrives and physically takes the package (`POST /vendor/sub-orders/:id/handover`).
   - Handover sets `status = 'in_transit'`, records `picked_up_at = UTC_TIMESTAMP()`, and triggers parent order status synchronization.
5. **Vendor Isolation:**
   - Strict `vendor_id` checks ensure Vendor A can never view, book, or modify Vendor B's sub-orders or financial records.

---

## 4. Customer Tracking Experience

Customers track deliveries through their authenticated portal (`/customer/account/orders/:id`) or public tracking (`/track-order`).

### Features & Privacy Safeguards
- **Clear Progress Steps:** Displays real-time progress (`Processing` → `In Courier` → `On The Way` → `Delivered`).
- **Multi-Package Visibility:** In multi-vendor orders, each vendor's parcel is tracked independently with its respective courier name and tracking code.
- **Bilingual Interface:** English and Bengali labels for all statuses.
- **Customer Privacy Protection:**
  - Public `/track-order` requires customer login to view delivery details, preventing unauthorized scraping of customer addresses or phone numbers.
  - Zero leakage: Internal courier API keys, raw provider JSON payloads, buy prices, commissions, and supplier notes are strictly excluded from customer views.

---

## 5. Booking Reliability, Recovery & Reconciliation Lifecycle

Network failures, provider timeouts, and rate limits are managed through a hardened state machine:

```
[ ready_for_pickup ]
        │
        ▼ (One-Click Booking Initiated)
[ in_review (Lock Acquired) ]
        │
        ├── Provider 200 OK ──────► [ succeeded ] (Parcel Created)
        │
        ├── Network Timeout ──────► [ unknown_timeout ] (BLOCKED)
        │                                  │
        │                                  ▼ (Reconciliation Run)
        │                    ┌─────────────┼─────────────┐
        │                    │             │             │
        │                 [found]     [absent]     [unknown]
        │                    │             │             │
        │                    ▼             ▼             ▼
        │              [ succeeded ]   [ failed ]   [ BLOCKED ]
        │              (Recovered)    (Retry OK)   (Remains in_review)
        │
        └── Provider 4xx/5xx ─────► [ failed ] (Safe to Retry)
```

### Tri-State Reconciliation Contract
When reconciling an ambiguous booking (`unknown_timeout` or `in_review`), provider adapters return one of three outcomes:
1. **`found`:** Carrier confirms the parcel exists on their server. Recovers `trackingId` and sets `booking_status = 'succeeded'`.
2. **`confirmed_absent`:** Carrier definitively confirms zero parcel records exist. Sets `booking_status = 'failed'`, safely unlocking a fresh booking attempt.
3. **`unknown_error`:** Missing credentials, provider endpoint error, sandbox limitation, or timeout during lookup. The booking **REMAINS BLOCKED** (`unknown_timeout`/`in_review`). Never assume parcel is absent on lookup failure!

---

## 6. Courier Operations & Monitoring Center

Super Admins access the centralized monitoring dashboard at `/admin/fulfillment/ambiguous-shipments`.

### Capabilities:
- **Real-Time KPI Metrics:** Cards for Ambiguous, Stalled (60m+), Failed Bookings, Succeeded Bookings, In Transit, and Delivered parcels.
- **Multi-Status Filtering:** View `All Ambiguous (Default)`, `All Shipments`, `unknown_timeout`, `in_review`, `failed`, or `succeeded`.
- **Stalled Detection:** Shipments remaining unresolved for > 60 minutes are marked with a prominent `Stalled` warning.
- **Audit Trail Inspection:** Full JSON audit modal displaying timeline events from `fulfillment_shipment_events`, recommendation snapshots, and sanitized booking responses.
- **Super Admin Manual Override:**
  - Requires Super Admin authorization.
  - Mandatory provider evidence (e.g. carrier portal ticket # or signed confirmation, min 5 characters).
  - Can resolve as `confirm_parcel_exists` (requires tracking reference) or `confirm_parcel_absent` (unlocks safe re-booking).
  - Logs immutable event to `fulfillment_shipment_events`.
- **COD Collection & Remittance Reconciliation:**
  - Allows recording courier remittance reference, collected paisa, courier fee, and COD service fee.
  - Verifies amounts against `cod_due_paisa`.
  - Automatically marks parent order as `payment_status = 'paid'` when all shipments for the order are reconciled.

---

## 7. Database Migration & Rollback Safety (Migration 0029)

- **Migration Up:** `0029_multi_courier_engine.up.sql`
  - Adds `quoted_charge_paisa`, `booking_idempotency_key`, `recommendation_snapshot_json`, `booking_response_json`, `external_consignment_id` to `fulfillment_shipments`.
  - Adds `supports_live_quotes`, `service_options_json` to `courier_apis`.
- **Migration Down:** `0029_multi_courier_engine.down.sql`
  - Drops the added columns.
- **Rollback Safety Warning:**
  - Rolling back Migration 0029 in a persistent environment with live shipments will cause permanent loss of courier tracking IDs, recommendation audit history, and provider response snapshots.
  - Review `migration-0029-rollback-safety-guide.md` before executing any rollback in persistent environments.

---

## 8. Known Limitations & Owner Decisions Required

1. **Production Carrier Credentials:**
   - Live booking with Steadfast, Pathao, or RedX requires valid merchant credentials (API Key, Secret Key, Client ID) configured in `/admin/courierapi/manage`.
   - In test and CI environments, `mock_courier` is used exclusively.
2. **Alert & Escalation Policies:**
   - Stalled shipment threshold defaults to 60 minutes. Owner can adjust notification thresholds or notification webhooks as business policies evolve.
3. **Financial Policies:**
   - COD fees, courier remittance deductions, and vendor payout schedules are subject to business owner agreements and marketplace terms.
