# PHASE 05 — CUSTOMER STOREFRONT: PRE-IMPLEMENTATION AUDIT & ARCHITECTURE

**Project:** Mr. Tumi Grocery & Gift (`মি. তুমি গ্রোসারি অ্যান্ড গিফট`)  
**Phase:** `PHASE 05 — CUSTOMER STOREFRONT`  
**Date:** `2026-10-25` (`Asia/Dhaka`)  
**Repository Branch:** `arena/8689c974-mrtumi` (Base Commit: `033009a`)  

---

## 1. Pre-Edit Inspection Findings

Before editing any route, repository, stylesheet, script, or EJS view, we inspected `src/routes/storefront.js` (`984` lines, `72` direct `db.*` calls), `src/repositories/authRepository.js`, `src/db/migrations/0002_catalog_inventory_and_partners.up.sql`, `src/db/migrations/0003_orders_payments_and_operations.up.sql`, `src/db/database.js`, `public/frontEnd/js/storefront.js`, and all `12` templates under `views/store/`.

### 1.1 Baseline Issues Identified & Phase 05 Remediations

1. **Direct SQLite Coupling in Storefront Catalogue Routes (`src/routes/storefront.js`):**
   - All catalogue, search, category, product-detail, blog, CMS, review, contact, complaint, newsletter, and `/sitemap.xml` handlers previously called synchronous `src/db/database.js` (`node:sqlite`) directly and would throw `503 SQLITE_CALLER_NOT_MIGRATED` when `DB_CLIENT=mysql`.
   - **Remediation:** Extract a dedicated async MySQL-first repository (`src/repositories/storefrontRepository.js`) using `src/db/mysqlPool.js` (`InnoDB`, `utf8mb4_unicode_ci`, integer `paisa` columns) with a non-destructive local SQLite fallback when `DB_CLIENT=sqlite` in non-production environments.
2. **Unapproved Vendor / Archived Product Exposure:**
   - Baseline queries checked only `WHERE status = 1`, which would expose `approval_status = 'pending'` vendor products or `is_archived = 1` products.
   - **Remediation:** Enforce `status = 1 AND approval_status = 'approved'` (plus `is_archived = 0` on MySQL) across every storefront listing, search, promo section, product detail, and sitemap query, and compute available stock per `ADR-006` (`vendor_id` uses `vendor_stock_on_hand - vendor_stock_reserved`; in-house uses `stock_on_hand - stock_reserved`).
3. **Hardcoded Sample Thumbnails on Product Detail (`views/store/product.ejs:22–24`):**
   - Baseline `product.ejs` rendered two hardcoded `/uploads/product/lychee-*.jpg` thumbnails on every product page regardless of database data.
   - **Remediation:** Parse `gallery_json` / `gallery` from the database and render gallery thumbnail controls **only when multiple valid product images exist** (`gallery_images.length > 1`).
4. **Fabricated Promo Countdown Dates (`views/store/home.ejs:50, 95`):**
   - Baseline fell back to hardcoded `'2027-06-30T23:59:59'` / `'2027-07-15T23:59:59'` when `flash_sale_end` / `hot_deal_end` were unconfigured.
   - **Remediation:** Render Flash Sale and Hot Deal sections **only** when active approved flagged products exist and the promotion is enabled and not expired; render countdown timers **only** when a valid future end timestamp is configured in `settings`.
5. **Wholesale Tier Validation (`views/store/product.ejs:42`):**
   - Baseline rendered wholesale pricing without verifying `is_wholesale = 1` or `wholesale_price < new_price`.
   - **Remediation:** Render the Wholesale Tier table **only** when `is_wholesale` is enabled, `approval_status === 'approved'`, `wholesale_min_qty >= 2`, and `0 < wholesale_price_paisa < new_price_paisa`.
6. **Catalogue Navigation, Filtering, Sorting & Pagination Gaps:**
   - Added `/subcategory/:slug`, `/childcategory/:slug`, and `/brand/:slug` routes alongside `/category/:slug`, `/all-products`, `/flash-sales`, and `/hot-deals`.
   - Added parameterized server-side filtering (`q`, `category`, `subcategory`, `childcategory`, `brand`, `min_price`, `max_price`, `in_stock`, `deal`), 5 sort modes (`newest`, `price_asc`, `price_desc`, `best_selling`, `name_asc`), and true server-side pagination reusing `views/partials/pagination.ejs`.
7. **Support, FAQ, About, Policy, Blog, Reviews & SEO (`P05-04`):**
   - Added dedicated `/contact`, `/faq`, `/about`, and `/robots.txt` endpoints alongside `/page/:slug`, `/blogs`, `/blog/:slug`, and `/sitemap.xml`.
   - Preserved Phase 04's `views/partials/copy-review-notice.ejs` on unapproved legal/policy CMS pages (`about-us`, `return-policy`, `privacy-policy`, `terms-conditions`) and temporary brand placeholder SVGs.
   - Added CSRF/rate-limited review, contact, complaint, and newsletter handlers (`reviews` always insert as `'pending'` for moderation; only `'approved'` reviews display publicly).
   - Localized client-side mini-cart, quick-view, and toast messages in `public/frontEnd/js/storefront.js` via `window.__MT_I18N`.

---

## 2. Database Caller Boundary & Remaining SQLite Dependencies

In compliance with Section 4 (*"Follow the approved migration plan, use a clear repository/service boundary, and document which existing routes still depend on SQLite"*):

### 2.1 Storefront Routes Migrated to MySQL-First `storefrontRepository.js` in Phase 05 (`0` Direct SQLite Calls)
- `GET /` (Homepage: banners, featured categories, validated Flash Sale & Hot Deal, category rows, featured products, recent blogs)
- `GET /all-products`, `GET /search`, `GET /flash-sales`, `GET /hot-deals`
- `GET /category/:slug`, `GET /subcategory/:slug`, `GET /childcategory/:slug`, `GET /brand/:slug`
- `GET /product/:slug` (Product detail, DB gallery, `product_variants` + option selectors, validated wholesale tier, approved reviews + rating summary, related products, Product JSON-LD)
- `POST /cart/add` & `POST /cart/update` (Product & variant price/stock lookup now runs through `storefrontRepository.findProductForCart`)
- `GET /about`, `GET /faq`, `GET /contact`, `GET /page/:slug`
- `GET /blogs`, `GET /blog/:slug`
- `POST /api/review`, `POST /api/contact`, `POST /api/complaint`, `POST /api/newsletter`
- `POST /api/store-assistant` (Product search branch now queries `storefrontRepository`; order-lookup branch guarded gracefully on MySQL until Phase 08)
- `GET /sitemap.xml` & `GET /robots.txt`

### 2.2 Storefront Routes Explicitly Deferred to Phases 07, 08 & 15 (Still Using Non-Production SQLite Bridge When `DB_CLIENT=sqlite`)
Per scope discipline (no premature Phase 07/08/15 checkout/order-pipeline rewrites in Phase 05), the following order/checkout routes in `src/routes/storefront.js` remain preserved for local prototype workflows and are scheduled for MySQL transaction conversion in their designated phases:

| Route(s) in `src/routes/storefront.js` | Remaining `db.*` Calls | Scheduled Phase | Reason Deferred |
|---|---:|---|---|
| `generateInvoiceId` helper | `1` | **Phases 07 & 08** | Replaced by transactional MySQL invoice generator |
| `computeCartTotals` coupon lookup & `POST /checkout/apply-coupon` | `2` | **Phase 07** | Part of server-authoritative cart & coupon engine |
| `POST /checkout/save-incomplete` | `3` | **Phase 08** | Consent-aware incomplete order capture |
| `GET /customer/checkout` & `POST /customer/checkout` | `11` | **Phases 07 & 08** | Customer accounts, delivery zones, `FOR UPDATE` checkout transaction, OTP & advance payment |
| `POST /order/quick-submit` | `9` | **Phases 07 & 08** | Shares atomic order-creation & stock-reservation transaction with checkout |
| `GET /order-success/:invoiceId`, `POST /order/:invoiceId/cancel`, `GET /track-order` | `8` | **Phase 08** | Order state machine, stock restoration ledger & PII-safe phone+invoice tracking (`R-06`) |
| `GET /campaign/:slug` & `POST /campaign/:slug/order` | `7` | **Phase 15** | Multi-product landing page engine |
| `POST /api/store-assistant` (order lookup) & `GET /api/recent-verified-order` | `3` | **Phase 08** | Reads `orders` / `order_items` tables |
| **Total Remaining in `storefront.js`** | **`44`** *(down from `72`)* | **Phases 07, 08, 15** | Guarded by `assertSqliteAllowed()` in production; repo total reduced `439 → 411` |
