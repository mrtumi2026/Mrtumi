# PHASE 07 — CUSTOMER ACCOUNTS, CART & CHECKOUT

**Status: `IN PROGRESS`.** Customer account/address/cart-merge and canonical `DB_CLIENT=mysql` checkout paths exist. Persistent cart load/replace/clear, registration/login guest-cart merge, authenticated cart mutation sync, checkout refresh, and post-order clear have MySQL repository assertions. Cart updates now reject invalid quantities, cap to current stock, and remove stale/out-of-stock items. Guest and authenticated MySQL HTTP cases plus SQLite-backed guest regression passed exact-SHA MySQL 8.0 CI run [`40498016622`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40498016622) on `15f96ea7bdbec7fd02ef62d7f2f91e1d47bf1558`. Approved privacy/legal copy, account recovery, and payment/OTP integrations remain incomplete. Historical persistent-cart evidence: run `40480186793` on `73cdfab3778e1d87dd4e951ac7730bca899a32d1`.

## Implemented vertical slices

- Customer registration/login use MySQL customer rows, bcrypt hashes, Bangladesh phone normalization, bounded validation/rate limits and session regeneration. Customers can maintain their own addresses; guest-cart merge validates product/variant identities.
- Checkout now uses `src/repositories/checkoutRepository.js` in MySQL mode. It ignores client cart JSON/prices, revalidates current product/variant pricing and availability, requires a configured delivery location and active internal COD gateway, computes integer-paisa totals, and creates order/lines/status history/reservation/audit atomically. A unique idempotency key plus request hash protects replay and rejects changed payload reuse.
- The MySQL success page does not display customer phone/address. Orders are initially unpaid, with zero recorded payment and full COD due. No provider payment evidence is inferred. MySQL quick order is disabled; customer invoice cancellation remains blocked until ownership verification exists.
- Guest recovery capture is optional and consent-gated; the browser does not capture data by default and does not opt customers into notifications. Consent can be withdrawn and associated PII/cart fields erased. The opt-in wording is an operational statement, not an approved terms/privacy policy.

## Remaining Phase 07 acceptance

- Cart update now validates integer quantities, caps requested quantity to current availability, and removes unavailable/deactivated products or variants instead of forcing a minimum quantity of one. Guest-mode regression and MySQL guest/authenticated HTTP coverage for invalid quantity, stock capping, persistence and zero-stock removal passed exact-SHA CI run `40498016622` on `15f96ea7bdbec7fd02ef62d7f2f91e1d47bf1558`.
- Complete persistent-cart cross-session/concurrency/error recovery and customer/guest merge policy evidence.
- Owner-configured active `delivery_locations` and COD gateway rows on the actual target database. Empty configuration blocks checkout; do not seed fees or zones from legacy defaults.
- Owner-approved Bangla/English Terms/Privacy copy and a documented consent version/retention policy. Do not treat the inline recovery opt-in as a substitute for approved legal/privacy policy.
- Customer password recovery only after an authorized verified delivery channel, plus profile/password change and account recovery safeguards.
- OTP/advance enforcement remains safely blocked when configured on because there is no customer verification/delivery route or verified payment collection path. Online/manual payment methods are rejected.
- Customer cancellation ownership verification, full historical-order compatibility and reservation expiry/cleanup/recovery workflow.
- Continue expanding route-level MySQL success/denial/CSRF/audit tests for remaining Phase 07 gaps; local MySQL-only skips do not count as passes.

## Verification and boundaries

- The live-MySQL HTTP suite covers server-side prices, CSRF, configured COD/delivery, replay/mismatch, inventory reservation, unpaid/COD accounting, no payment insertion and success-page privacy. This continuation's guest and authenticated cart update availability/persistence tests passed MySQL 8.0 CI run `40498016622` on `15f96ea7bdbec7fd02ef62d7f2f91e1d47bf1558`; the full local suite separately reported 52 passed, 8 MySQL-only skipped, 0 failed. Local skips are not treated as passes; CI TAP totals are not inferred.
- Local SQLite/unit tests are regression coverage only, not evidence that the canonical MySQL path passed.
- No provider credentials, SMS, payment, shipping, production migration or deployment were used.
