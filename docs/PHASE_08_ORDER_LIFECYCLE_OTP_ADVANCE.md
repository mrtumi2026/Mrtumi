# PHASE 08 — ORDER MANAGEMENT, INCOMPLETE ORDERS, OTP & ADVANCE PAYMENT

**Status: `IN PROGRESS`.** This branch now contains a canonical MySQL checkout path and expanded live-MySQL tests, but those tests have not yet run in CI. Local MySQL-only tests are explicitly skipped. Provider delivery/settlement, owner-controlled return policy, production configuration, and Phase 07 end-to-end acceptance remain open.

## Current implementation

- `src/repositories/checkoutRepository.js` is the canonical `DB_CLIENT=mysql` storefront order writer. It reads only the server session cart (never `cart_backup_json`), locks/revalidates current product and variant prices/stock, requires an active configured delivery location and enabled `payment_gateways.code='cod'`, computes amounts in integer paisa, and writes the order, lines, initial status history, reservation, coupon usage and audit record in one InnoDB transaction.
- Orders begin `pending` / `unpaid` with `paid_paisa=0` and `cod_due_paisa=total_paisa`. No `order_payments` entry or payment success is fabricated. Only configured COD is offered; online/manual methods are rejected. If OTP or a non-zero advance policy is enabled without a verified delivery/checkout flow, submission fails closed. Migration `0007_checkout_idempotency_hash` adds a nullable SHA-256 request digest beside the existing unique request key; identical retries return the same invoice, while changed payload replay is rejected.
- The MySQL checkout page shows server-repriced cart items and only configured delivery zones/COD. It no longer submits a client cart backup. A required order-confirmation checkbox and CSRF token protect submission. The legacy SQLite checkout remains only for non-MySQL development; quick order is disabled on MySQL, and unverified customer invoice cancellation is paused there. Admin cancellation still uses the Phase 08 transition/release path.
- Checkout recovery is opt-in only. The browser does not auto-capture on phone blur unless the optional consent box is checked. Capture stores normalized contact plus product/variant IDs and quantities; it discards client prices, defaults messaging consent off, and supports session-bound consent withdrawal/erasure. Do not send recovery messages.
- Admin order/refund/recovery/settings screens remain behind server-side session, granular permission and CSRF guards. A read-only `/admin/phase08/orders/:id/otp` endpoint exposes summary counts/status only—never the phone, OTP digest or code. OTP generation/verification remains repository-only: there is no customer HTTP verification/delivery route and no SMS is sent.
- Order transitions reserve inventory when the order is created, release holds on cancellation/failure and consume reservations on shipment. Reservation behavior currently rejects multiple variant lines for one product and vendor-product variants. Existing reservation expiry is 30 minutes and there is no automated expiry/re-reservation workflow yet.
- Refund approval is an internal review decision, not provider settlement. No adapter or live charge/refund was called.

## Return/refund/restock policy — unresolved owner decision

`return_requested` is the last enabled order state. The `returned` transition is intentionally blocked and does not restock inventory until the owner approves the following exact policy:

1. Which delivered orders/items are eligible, the request window, excluded product classes and required customer evidence.
2. Whether partial-item returns are allowed; how quantities, discount/coupon allocation, delivery fees, taxes and reseller/vendor amounts are recalculated.
3. Required inspection and disposition for each returned item (resalable warehouse stock, quarantine, vendor return, or write-off); who authorizes it and what evidence is recorded.
4. Refund amount calculation and authorization limits, and whether approval means only internal approval or can ever initiate/confirm a provider settlement.
5. Whether original delivery fees are refundable and how COD/advance/manual payments are handled.

Until that decision is recorded, staff cannot mark an order `returned`; no schema or prior test fixture is treated as owner policy. This intentionally supersedes the older broad return/restock assumption for the current implementation.

## Configuration and integration blockers

- Checkout requires real active rows in `delivery_locations` with owner-configured integer-paisa charges and an active `payment_gateways` row with code `cod`. Empty configuration disables submission; no defaults or location rows are seeded by this change.
- COD works as an internal unpaid/due-at-delivery workflow only. Online payment, manual TrxID review, provider confirmation, advance collection, and refund settlement are not implemented. If advance is required by policy, checkout pauses.
- If `otp_mode=on`, checkout pauses because there is no customer verification endpoint or authorized OTP delivery adapter. SMS remains `BLOCKED` pending owner-approved provider credentials, adapter/security review and verified delivery evidence.
- Non-SuperAdmin access needs exact grants for `orders.manage`, `refunds.review`, `checkout.recovery.view`, `checkout.recovery.manage`, and `settings.manage`. This change does not seed or overwrite production role permissions; Phase 09 permission administration remains outstanding.
- Persistent cart read/sync on every cart mutation, customer invoice ownership verification for cancellation, reservation expiry/recovery, and historical SQLite order migration are not included.

## Verification

- Added live MySQL HTTP coverage in `tests/phase05-mysql.test.js` for the MySQL storefront checkout, CSRF, server-side pricing despite forged client cart data, configured delivery fee/COD, idempotent replay/mismatch, reservation, unpaid status, no payment row and a privacy-minimized order-success page.
- Added `tests/phase08-admin-http-mysql.test.js`: actual MySQL role/permission rows and admin login are used with HTTP routes to test authentication, per-role RBAC, CSRF, invalid transitions, concurrent replay, audit, refund review without settlement, recovery consent/settings and OTP-summary privacy. `tests/phase06-mysql.test.js` now asserts final return/restock is blocked pending policy.
- The shared MySQL migration test now covers seven paired migrations, including `0007`, and CI runs up/status/down-seven/up.
- Local `npm run lint` and `npm test` passed at the current branch state, but all live MySQL suites were skipped locally because no MySQL service is available. These local results do **not** establish the MySQL checkout, admin HTTP or migration round-trip as passed. A new CI run is required.
- Previous successful CI run `40292904036` was for the earlier SHA `9fca29a8ed07ac278d2553d53f99ec5e74d79b2a`; it predates these changes and is not evidence for this branch's checkout/migration/admin additions.

## Phase 07/08 completion gate

Keep both phases `IN PROGRESS` until the new MySQL 8.0 CI suite passes, production deployment configuration is supplied/verified, remaining P07 cart/privacy acceptance is addressed, operational reservation expiry/recovery is resolved, OTP/advance behavior is safely integrated or explicitly deferred by the owner, and the return policy above is approved or formally deferred. Do not execute production migrations, deployment, SMS, payment or refunds.
