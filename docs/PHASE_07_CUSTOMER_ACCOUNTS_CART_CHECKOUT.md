# PHASE 07 — CUSTOMER ACCOUNTS, CART & CHECKOUT

**Status:** `IN PROGRESS` — customer account and saved-address vertical slice implemented; checkout acceptance is not complete.
**Database:** Production path is MySQL/InnoDB. Existing synchronous SQLite storefront checkout remains legacy and is not the production implementation for this phase.
**Migration:** `0005_phase07_customer_cart` creates reversible persistent customer cart storage.

## Implemented vertical slice

- Customer registration and login use the existing `customers` table, bcrypt password hashes (cost 12), Bangladesh mobile normalization, bounded input validation, generic invalid-credential errors, login/registration rate limits, session regeneration on successful registration/login, and POST-only logout.
- Authenticated customers can add and remove their own saved addresses. Address inserts validate recipient, Bangladesh mobile, division/district and length limits; default-address changes serialize on the customer row and clear the prior default in one transaction. Address removal is constrained by both address and customer IDs.
- Guest session cart merge is bounded (each product/variant quantity capped at 99), ignores malformed/inactive product IDs and invalid variants, and writes transactionally. A generated non-null variant key enforces one persisted row per customer/product/variant, including base products.
- Account form and address pages support Bangla default and English text. Writes rely on the app-wide CSRF guard; there is no GET logout.
- Password recovery is intentionally unavailable until a verified notification channel and its delivery procedure exist. The interface says so; no fake token-delivery behavior is claimed.

## Verification

- Local tests cover Bangladesh phone normalization, password bounds, and ordered/reversible migration-pair discovery.
- Added live MySQL CI assertions for registration/hash authentication, bad-password rejection, saved-address ownership/deletion and default state, plus bounded cart merge. They have **not yet run** for this change.
- CI migration checks have been extended to include migration `0005`. Live MySQL evidence is pending; this work is not reported `TESTED AND PASSED` against MySQL yet.
- Latest local `npm run verify`: 438 foundation checks, 32 tests passed, 8 MySQL-only tests explicitly skipped locally, 0 failures. `npm audit --omit=dev`: 0 vulnerabilities.

## Remaining Phase 07 acceptance

- Password reset workflow with an authorized, verified email/SMS notification channel; customer profile/password changes and account recovery safeguards.
- Persistent-cart read/sync on every cart mutation, stale price/availability revalidation, cross-session merge policy and cart UI state. Current code merges the guest cart on account login but does not yet make every cart operation durable.
- Guest checkout and signed-in checkout with canonical product/variant/stock resolution; submitted prices and totals must never be trusted. Existing legacy checkout routes are not replaced by this slice.
- Configurable delivery zone/rate administration and authoritative server-computed shipping/discount/tax/total values. Do not invent zone fees or seed fake locations.
- Duplicate-order request locking/idempotency, atomic order + line persistence and inventory reservation/release coordination (dependent on remaining Phase 06 inventory work and Phase 08 lifecycle).
- Checkout terms/privacy consent capture using approved copy, explicit consent timestamp, localized UI and legal-copy review. Do not publish draft legal language as approved.
- End-to-end live MySQL tests for account HTTP sessions, checkout idempotency/concurrency, stock behavior and delivery-fee calculations.

## Security and operational boundaries

- Routes are mounted behind existing request parsing, session, CSRF and shared localization/global middleware. Production must use secure cookies/TLS and MySQL; local SQLite is not an acceptable production substitute.
- No provider credentials, notifications, payment, shipment, production migration, or deployment were performed. No live customer data was created.
