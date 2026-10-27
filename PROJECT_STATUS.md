# PROJECT STATUS — Mr. Tumi Grocery & Gift

**Last Updated:** 2026-10-26 (`Asia/Dhaka`)
**Repository:** `mrtumi2026/Mrtumi` (Working Branch: `arena/8689c974-mrtumi`)
**Hosting Provider:** BestWebHostBD (`Node.js` + `SSH` + `MySQL-only` confirmed by owner via support; exact target runtime/DB versions `UNVERIFIED` — see `docs/CPANEL_COMPATIBILITY.md`). Local sandbox runtime checked: Node `v22.22.3`, npm `10.9.8`; this does not verify cPanel runtime.
**Current Completed Phase:** **PHASE 05 — CUSTOMER STOREFRONT**
**Current Work:** **PHASE 09 — ADMIN DASHBOARD, USERS & PERMISSIONS** (`IN PROGRESS`, owner-authorized by the current request). Phase 08 remains `IN PROGRESS` (not declared complete): its canonical MySQL checkout/reservation and admin HTTP/RBAC slice passed live MySQL CI run `40301701753`; return/restock policy and verified provider operations remain blocked. No production deployment or migration is authorized.

---

## 20-Phase Master Execution Tracker

| Phase | Title | Status | Gate / Blocker |
|---|---|---|---|
| **Phase 01** | Reference Audit and Requirements | `TESTED AND PASSED` | Complete (`3611777`) |
| **Phase 02** | Architecture, GitHub and Development Foundation | `TESTED AND PASSED` | Complete (`04c69bc`) |
| **Phase 03** | Database, Backend and API Foundation | `TESTED AND PASSED` | Complete (`63bb7a0` — `71` `InnoDB` `utf8mb4` MySQL tables, `paisa` math, ACID transactions, RBAC/CSRF/rate-limit, live `mysql:8.0` CI) |
| **Phase 04** | Branding, Design System and Bilingual UI | `TESTED AND PASSED` | Complete (`033009a` — WCAG AA tokens, temporary brand placeholders, `bn`/`en` dictionaries, `৳`/`Asia/Dhaka` formatters, 4-portal responsive UI) |
| **Phase 05** | Customer Storefront | `TESTED AND PASSED` | **Complete.** MySQL-first `storefrontRepository.js`, Homepage, Category/Subcategory/Childcategory/Brand/Search/Filter/Sort/Pagination, Product Detail (DB gallery, `product_variants`, approved wholesale guard, moderated reviews, JSON-LD), Cart entry points, `/about`, `/faq`, `/contact`, Blogs, `/sitemap.xml` & `/robots.txt` verified locally & on live `mysql:8.0` CI; waiting for explicit owner sign-off (`OWNER APPROVAL REQUIRED`) before Phase 06 |
| **Phase 06** | Products, Inventory, Purchases and Suppliers | `IN PROGRESS` | Owner accepted the current milestone; live MySQL 8.0 CI passed previously. Product edit/variants/gallery/bulk, supplier maintenance, PO transitions/cancel/returns and lot/expiry policy remain outstanding (`docs/PHASE_06_PRODUCTS_INVENTORY_PURCHASES_SUPPLIERS.md`) |
| **Phase 07** | Customer Accounts, Cart and Checkout | `IN PROGRESS` | Canonical MySQL checkout uses authoritative prices/stock, configured delivery/COD, transactions and idempotency; its coded checkout/reservation slice passed live MySQL CI `40301701753`. Persistent carts, approved legal copy, production configuration and remaining end-to-end acceptance remain outstanding (`docs/PHASE_07_CUSTOMER_ACCOUNTS_CART_CHECKOUT.md`) |
| **Phase 08** | Order Management, Incomplete Orders, OTP and Advance Payment | `IN PROGRESS` | Canonical MySQL checkout through transactional inventory reservation and real-login admin HTTP/RBAC tests passed live MySQL CI `40301701753`; final return/restock requires owner policy; OTP delivery, advance collection and payment/refund settlement remain blocked (`docs/PHASE_08_ORDER_LIFECYCLE_OTP_ADVANCE.md`) |
| **Phase 09** | Admin Dashboard, Users and Permissions | `IN PROGRESS` | Migration `0008`, dashboard RBAC/CSRF/audit, MySQL staff/role lifecycle and selected sidebar filtering passed live MySQL 8.0 CI `40308315393` on code SHA `448d2e6a1c60b36422ba825f486a78eea872d58e`. Owner must assign grants; broader legacy route coverage and database-level audit immutability remain open. Phase 08 blockers remain independent |
| **Phase 10** | Courier and Delivery Integrations | `BLOCKED` | Adapter build in P10; live test blocked until Steadfast/Pathao/RedX credentials & outbound access verified |
| **Phase 11** | Payment Gateways | `BLOCKED` | Adapter build in P11; sandbox/live test blocked until bKash/ShurjoPay/UddoktaPay credentials provided |
| **Phase 12** | Fraud Checking, Order Restriction and IP Blocking | `BLOCKED` | Rules engine in P12; live BDCourier check blocked until API key provided |
| **Phase 13** | Bulk SMS and Notifications | `BLOCKED` | Queue & templates in P13; live SMS blocked until BulkSMSBD credentials provided |
| **Phase 14** | Pixels, Tag Manager and Visitor Attribution | `NOT STARTED` | Depends on Phase 05, 07, 08 |
| **Phase 15** | Landing Pages, Promotions and Content | `NOT STARTED` | Depends on Phase 05, 07, 08 |
| **Phase 16** | Wholesale, Multivendor and Reseller | `NOT STARTED` | Depends on Phase 06, 08, 09 |
| **Phase 17** | POS, CRM and HRM | `NOT STARTED` | Depends on Phase 06, 08, 09 (SME salary formula approved) |
| **Phase 18** | Reports, Finance and System Settings | `NOT STARTED` | Depends on Phase 08–17 |
| **Phase 19** | Customer and Admin Android WebView Apps | `NOT STARTED` | Depends on responsive storefront/admin URLs |
| **Phase 20** | Full QA, Security Audit and Owner-Hosting Deployment | `NOT STARTED` | Depends on Phase 01–19 + BestWebHostBD server version checks + explicit owner deploy approval |

---

## Phase 06 — Current Implementation and Verification State

- Added reversible migration `0004_phase06_inventory_purchases_suppliers` for supplier metadata, product type, purchase totals/lines, unit-cost stock ledger, and idempotent receipt records. Migration up/status/down and repository integration tests passed in GitHub Actions against live MySQL 8.0.
- Implemented an Admin-session + CSRF-protected initial screen at `/admin/phase06` and async repository methods for product creation, optional opening stock, archive/restore, safe raster-upload validation, supplier creation, reasoned stock adjustments, draft multi-line purchase orders, and partial/full receipts.
- Verified result for the preceding Phase 06 milestone: lint 575 passed; local tests 27 passed with 8 explicit MySQL skips and no failures; production dependency audit 0 vulnerabilities. GitHub Actions Run `40278078567` passed with MySQL 8.0 migrations and tests active (the documented Phase 06 evidence).
- Phase 06 remains `IN PROGRESS` despite owner acceptance of the current milestone; edit/variants/gallery/bulk/CSV, supplier maintenance, full PO transitions/returns, receipt UI, unresolved batch/lot/expiry policy remain documented gaps. See `docs/PHASE_06_PRODUCTS_INVENTORY_PURCHASES_SUPPLIERS.md`.
- Phase 07 remains `IN PROGRESS`: account/address/cart-merge and canonical MySQL checkout slices exist; persistent cart load/replace/clear, guest-cart merge on registration/login, authenticated mutations and checkout refresh/order clearing are implemented with new repository assertions. Those assertions/routes passed exact-SHA CI run `40480186793` on `73cdfab3778e1d87dd4e951ac7730bca899a32d1`. Approved legal copy, recovery, reservation cleanup and payment/OTP integrations remain incomplete. Phase 08 remains `IN PROGRESS`: checkout reservation wiring, OTP-summary endpoint and authenticated MySQL admin HTTP suite exist; latest exact-SHA CI passed, but return completion/restock remains blocked on owner policy and OTP/advance/provider operations remain fail-closed. See `docs/PHASE_07_CUSTOMER_ACCOUNTS_CART_CHECKOUT.md`, `docs/PHASE_08_ORDER_LIFECYCLE_OTP_ADVANCE.md` and `docs/MASTER_PHASE_01_20_AUDIT.md`. Phase 14 is now `IN PROGRESS`: first-party UTM attribution is being added behind a default-off `ANALYTICS_ATTRIBUTION_ENABLED` flag, requires a session opt-in, and emits no third-party events. Local unit tests pass; migration/order provenance and consent HTTP assertions await exact-SHA MySQL CI. Meta CAPI, GTM and TikTok adapters remain unimplemented and owner privacy-copy/retention and provider IDs are required before activation. Phase 19 was re-inspected: no Android project or Java/Gradle/SDK exists in the environment, and production URL/signing ownership are unverified; no placeholder project or host was fabricated. Execution queue: `docs/MASTER_EXECUTION_QUEUE.md`. No production deployment or live data migration was performed.

## Summary of Finalized Phase 05 Deliverables & Remaining Staged Dependencies

1. **MySQL-First Customer Storefront Repository (`src/repositories/storefrontRepository.js`, `docs/PHASE_05_CUSTOMER_STOREFRONT.md`):**
   - Migrated all Phase 05 storefront catalogue, search, taxonomy (`category`/`subcategory`/`childcategory`/`brand`), product detail, cart product/variant lookup, CMS, FAQ, Contact, Blog, Review, Support, Newsletter, and SEO Sitemap queries to async MySQL (`InnoDB`, `utf8mb4`, `BIGINT` `paisa`, `product_variants`, `ADR-006` warehouse vs vendor stock pools) while preserving local non-production SQLite fallback.
   - Reduced remaining SQLite calls in `src/routes/storefront.js` from `72 → 44` (and repository-wide remaining calls from `439 → 411`), documenting the exact `44` deferred checkout/order/landing-page calls scheduled for Phases 07, 08, and 15.
2. **Honest Storefront UX & SEO (`views/store/*`, `public/frontEnd/js/storefront.js`):**
   - Removed hardcoded sample thumbnails on Product Detail and fabricated promo countdown dates on Homepage; Flash Sale, Hot Deal, Gift showcase, gallery thumbnails, and Wholesale Tier tables render **only** when backed by valid, approved database records/settings.
   - Added `/about`, `/faq`, `/contact`, `/subcategory/:slug`, `/childcategory/:slug`, `/brand/:slug`, `/robots.txt`, canonical/OpenGraph tags, and Product `Schema.org` JSON-LD.
3. **Unresolved Owner Inputs Carried Forward Honestly:**
   - Official **Mr. Tumi Grocery & Gift** logo files (temporary brand placeholders remain active).
   - Final owner-approved Bangla & English legal/policy copy (`copy-review-notice.ejs` remains active on draft CMS policy pages).
