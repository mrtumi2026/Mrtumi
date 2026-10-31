# Remaining MySQL Storefront, Authentication & Partner-Portal Work

**Review snapshot:** 2026-10-31, Asia/Dhaka. This is an implementation queue, not owner approval. D3, D6, and D7 remain pending in `OWNER_DECISION_REGISTER.md`. No production changes or provider operations are authorized by this document.

## Security change in this batch

`POST /vendor/orders/mark-ready/:orderId` now requires the session-bound CSRF token and always fails closed before any order query or write. The existing order-page form includes the token. The route remains behind the existing `requireVendor` session check; no vendor permission or grant was added. This applies identically in SQLite and MySQL mode because the handler has no database-dependent branch. A valid vendor session is deliberately not sufficient authority to transition a parent order while D3/fulfillment rules are unresolved.

Only this vendor POST was given CSRF enforcement in this slice. Other vendor forms/routes were not changed because their routes include public account creation/login, stateful profile/wallet writes, and multipart uploads; any wider CSRF rollout needs coordinated form changes and upload-cleanup tests. The current vendor order list remains a legacy SQLite read and is not made MySQL-ready here.

## Findings and current MySQL boundary

### Storefront and checkout

- The MySQL-first storefront repository already covers the public catalogue/search/category/brand/product pages, content/blog/support reads, sitemap, product reviews and public contact/complaint/newsletter writes. Do not redo these completed paths.
- Customer registration/login, address book, persistent cart, cart repricing, coupon validation, delivery/COD quote, checkout order creation, success-page lookup, and CSRF-protected customer checkout are repository-backed in MySQL. Checkout creates an unpaid COD order and records order history/reservations transactionally; it does not claim provider payment.
- `POST /order/quick-submit` explicitly returns 409 in MySQL. It must not be re-enabled by trusting submitted prices, delivery fees, inventory, or customer-provided totals; if selected later, adapt it through the canonical checkout/repricing/idempotency transaction and its tests.
- Customer cancellation explicitly returns 409 in MySQL pending invoice ownership verification. The legacy SQLite cancellation path still changes order state/restocks stock directly and is not the MySQL state-machine path; keep this identified as D7-blocked work, not as an approved mutation.
- `GET /track-order` currently returns an empty result in MySQL rather than reading orders. The SQLite path can search by invoice **or phone**, so an equivalent MySQL implementation must first define a safe lookup contract and avoid disclosing another customer's order. Treat this as a privacy/ownership review, not a plain list-query migration.
- `/campaign/:slug` and `/campaign/:slug/order` remain synchronous SQLite paths. Campaign storage/authoring is not part of the canonical MySQL schema; the legacy order submission uses fixed shipping values and separate writes. Read-only campaign display needs an approved schema/Phase 15 design; campaign ordering must use canonical checkout and wait for applicable D7 rules. Do not port the old fixed-value order handler.
- The order-lookup branch of `/api/store-assistant` is intentionally omitted in MySQL; `/api/recent-verified-order` returns `{enabled:false}` in MySQL. Do not expose customer order/location data or activate sales notifications without an approved privacy/data-use contract.
- Incomplete-checkout capture/withdrawal and first-party attribution code have technical MySQL paths but remain gated by D6 consent/legal/retention approval. Password recovery additionally requires a verified, authorized delivery channel. Do not activate collection, recovery, notification, or attribution from code availability alone.

### Authentication and vendor/reseller portals

- Admin and customer authentication have MySQL repository paths. Vendor/reseller `POST /login` and `POST /register` still use synchronous SQLite calls. `authRepository.findVendorById` and `findResellerById` have MySQL lookups for session refresh, but that does not make portal login or portal handlers MySQL-ready.
- Vendor protected reads are `/vendor/dashboard`, `/vendor/products`, `/vendor/orders`, `/vendor/withdrawals`, and `/vendor/profile`; product/order/wallet/profile queries are legacy SQLite. Some product reads/writes use `vendor_id = req.session.vendorUser.id`; the order list joins product ownership to select vendor lines. These do not establish authority over the parent order status.
- Vendor mutations include product create/edit/delete, `/vendor/orders/mark-ready/:orderId`, withdrawal requests, and profile/password changes. The mark-ready endpoint is the only mutation explicitly disabled in this slice. Wallet/profile/product mutations remain unported and are not authorized for MySQL operation.
- Reseller reads include dashboard, global product catalogue, reseller orders, deposits, withdrawals, and profile. Own-order and wallet reads filter by `reseller_id`; the catalogue/hot-products reads are global. All remain legacy SQLite paths. Reseller order creation also changes product stock and writes order/items in separate statements; deposit/withdrawal requests pair balance updates with transaction rows without an atomic transaction. Do not migrate those workflows as simple CRUD.
- Canonical schema and legacy portal SQL differ substantially: vendors use basis-point commission and integer-paisa balances; resellers use integer-paisa balances and `tx_type`/`amount_paisa`; products use canonical bilingual/paisa/stock-pool fields; canonical orders use `invoice_no`/`order_status` and line-level `order_items.vendor_id`. Legacy handlers expect `commission_rate`, `balance`, `new_price`, `stock`, `invoice_id`, `status`, and other SQLite-era fields.
- `requireVendor` / `requireReseller` currently check session presence only. D3 requires an explicit decision for each entity and operation; do not assume that platform-wide admin choices, portal login, line ownership, or global catalogue visibility settle the access rule.

## Concrete remaining-work queue

| Priority | Work item | Classification / gate | Safe acceptance boundary |
|---|---|---|---|
| 1 | Keep vendor parent-order status mutation fail-closed; retain route-specific CSRF on its form/POST | **Code-ready and implemented** | SQLite + MySQL tests show missing CSRF is rejected and valid-token requests change neither an owner order nor another vendor's order/history. No same-vendor success is asserted. |
| 2 | Extend CSRF to other vendor POST routes, updating login/register/logout, profile, wallet, and delete forms; design a safe upload/CSRF failure cleanup path before protecting multipart product create/edit | **Code-ready security work; not part of this slice** | Exercise each legitimate form flow with a valid token and each POST without one; failed multipart CSRF must remove only the newly uploaded unassigned file. Do not weaken CSRF or delete existing/shared uploads. |
| 3 | Define vendor/reseller access scope separately for login/onboarding, reads, product actions, orders, verification, and finance; then design MySQL portal repositories | **Blocked by D3** | Owner records exact scope per entity/operation. Before any approved mutation, test cross-vendor/reseller denial and permitted same-owner behavior against the selected model. For orders, resolve mixed-vendor parent-order ownership explicitly. |
| 4 | MySQL vendor/reseller portal login and registration, account status/verification rules, rate limits, session lifecycle, and self-service read repositories | **Blocked by D3; implementation review after decision** | Preserve bcrypt/session behavior and status gates; use canonical columns and parameterized repositories. Do not let login success imply verification or mutation authority. |
| 5 | MySQL reseller global product catalogue read | **Candidate read-only slice; D3 read scope and canonical projection must be confirmed** | Select approved/active/available canonical products and preserve documented reseller display semantics; prove it exposes no vendor-private fields. Do not couple this read to order creation or stock mutation. |
| 6 | Safe customer order tracking and support-assistant order lookup | **Privacy/ownership contract required; review against D6/D7 before coding** | Prefer strong, exact order verification; return only approved fields; deny enumeration and cross-customer access. Do not reproduce legacy “invoice OR phone” search unchanged. |
| 7 | D6-dependent recovery, abandoned-checkout retention/deletion, consent text/withdrawal, and attribution activation | **Blocked by D6** | Implement only after exact bilingual purpose/field/consent/retention/erasure decisions and an authorized verified recovery channel with test evidence. Existing consent UI/code is not approval. |
| 8 | Customer cancellation, return/restock, partial-item disposition, refund/advance/COD settlement, campaign order flow, and any vendor fulfilment transition | **Blocked by D7 where lifecycle/financial authority is involved** | Owner-approved actor/eligibility/state/amount/stock-pool/reconciliation rules; route through the existing lifecycle transaction and append status history atomically. Internal refund review is not settlement. |
| 9 | Campaign display/order MySQL architecture and any public quick-order replacement | **Engineering design; keep legacy order POST disabled until canonical flow is used** | Canonical schema, inventory repricing, configured delivery/COD, idempotency, CSRF and full rollback tests. Never port the legacy fixed-fee/multi-write handler. |

## No-go boundaries

- Do not infer D3 from current filters, session fields, existing permission keys, or database foreign keys.
- Do not restore the vendor `mark-ready` update or grant same-vendor parent-order authority until an owner-defined order-scope rule exists. A line-level `vendor_id` is not, by itself, ownership of a mixed-vendor parent order.
- Do not enable D6 collection/recovery/attribution or D7 cancellation/returns/settlement from test fixtures or historical SQLite behavior.
- Existing admin vendor/reseller directory GETs are already migrated in the previous slice; no duplicate work is selected here.
- No production data/settings/schema changes, deployment, hosting changes, or live provider calls are included.
