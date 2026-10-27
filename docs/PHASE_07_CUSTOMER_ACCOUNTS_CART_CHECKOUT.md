# PHASE 07 — CUSTOMER ACCOUNTS, CART & CHECKOUT

**Status: `IN PROGRESS`.** Customer account/address/cart-merge and canonical `DB_CLIENT=mysql` checkout paths exist. Persistent cart load/replace/clear, registration/login guest-cart merge, authenticated cart mutation sync, checkout refresh, and post-order clear have now been implemented with MySQL repository assertions. Exact-SHA CI run `40480186793` passed on `73cdfab3778e1d87dd4e951ac7730bca899a32d1`, exercising the MySQL test suite including the new persistence assertions. Approved privacy/legal copy, account recovery, and payment/OTP integrations remain incomplete.

## Implemented vertical slices

- Customer registration/login use MySQL customer rows, bcrypt hashes, Bangladesh phone normalization, bounded validation/rate limits and session regeneration. Customers can maintain their own addresses; guest-cart merge validates product/variant identities.
- Checkout now uses `src/repositories/checkoutRepository.js` in MySQL mode. It ignores client cart JSON/prices, revalidates current product/variant pricing and availability, requires a configured delivery location and active internal COD gateway, computes integer-paisa totals, and creates order/lines/status history/reservation/audit atomically. A unique idempotency key plus request hash protects replay and rejects changed payload reuse.
- The MySQL success page does not display customer phone/address. Orders are initially unpaid, with zero recorded payment and full COD due. No provider payment evidence is inferred. MySQL quick order is disabled; customer invoice cancellation remains blocked until ownership verification exists.
- Guest recovery capture is optional and consent-gated; the browser does not capture data by default and does not opt customers into notifications. Consent can be withdrawn and associated PII/cart fields erased. The opt-in wording is an operational statement, not an approved terms/privacy policy.

## Remaining Phase 07 acceptance

- Persistent cart reads and writes across sessions and every cart mutation, stale-availability handling, and customer/guest merge policy.
- Owner-configured active `delivery_locations` and COD gateway rows on the actual target database. Empty configuration blocks checkout; do not seed fees or zones from legacy defaults.
- Owner-approved Bangla/English Terms/Privacy copy and a documented consent version/retention policy. Do not treat the inline recovery opt-in as a substitute for approved legal/privacy policy.
- Customer password recovery only after an authorized verified delivery channel, plus profile/password change and account recovery safeguards.
- OTP/advance enforcement remains safely blocked when configured on because there is no customer verification/delivery route or verified payment collection path. Online/manual payment methods are rejected.
- Customer cancellation ownership verification, full historical-order compatibility and reservation expiry/cleanup/recovery workflow.
- Continue expanding route-level MySQL success/denial/CSRF/audit tests for remaining Phase 07 gaps; local MySQL-only skips do not count as passes.

## Verification and boundaries

- The live-MySQL HTTP test covers server-side prices, CSRF, configured COD/delivery, replay/mismatch, inventory reservation, unpaid/COD accounting, no payment insertion and success-page privacy. Exact-SHA CI run `40480186793` passed on SHA `73cdfab3778e1d87dd4e951ac7730bca899a32d1`, exercising the new persistent-cart assertions along with the existing HTTP checkout tests.
- Local SQLite/unit tests are regression coverage only, not evidence that the canonical MySQL path passed.
- No provider credentials, SMS, payment, shipping, production migration or deployment were used.
