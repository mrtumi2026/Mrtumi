# PHASE 01 — REFERENCE AUDIT AND REQUIREMENTS SPECIFICATION
**Project:** Mr. Tumi Grocery & Gift  
**Market & Locale:** Bangladesh (`Asia/Dhaka`, Currency: `BDT / ৳`, Languages: Bangla `bn` + English `en`)  
**Phase Status:** `IMPLEMENTED` — Awaiting Owner Review & Approval (`OWNER APPROVAL REQUIRED` to proceed to Phase 02)  
**Audit Date:** 2026-10-25  

---

## 1. Sources Inspected & Evidence Classification

To strictly obey Fundamental Rules 3, 10, 11, and 27, every observation in this audit is classified into one of four evidence tiers:

1. **`[SCREENSHOT-VERIFIED]`** — Directly visible in the three Admin Panel screenshots (`image-1.png`, `image-2.png`, `image-3.png`) provided by the owner.
2. **`[DOM-VERIFIED]`** — Verified from the owner-uploaded saved Admin Dashboard HTML (`Dashboard - ফল বাজার.html`), which reveals collapsed Bootstrap 5 submenu items (`#side-menu .collapse`) and client-side AJAX routes present on the dashboard page.
3. **`[STOREFRONT-VERIFIED]`** — Verified via read-only HTTP inspection of public pages on `https://eshop2.coderinbd.com/` (`/`, `/product/...-246`, `/customer/checkout`, `/site/order-track`). Zero modifications were made to the reference site.
4. **`[UNVERIFIED / ASSUMED]`** — Inner admin sub-pages, server-side business rules, database schemas, and third-party API credentials on the reference site that are not publicly accessible or shown in screenshots.

---

## 2. Complete Admin Sidebar & Topbar Menu Inventory

### 2.1 Top Navigation Bar (`[SCREENSHOT-VERIFIED]` across `image-1.png`–`image-3.png`)
- **Left Brand Box (`248px` width, dark navy `#151e2c`):** Reference shows stylized Bangla logo + tagline. **For Mr. Tumi Grocery & Gift:** Must use original **Mr. Tumi Grocery & Gift** logo & tagline (no copied reference logo).
- **Left Controls:**
  - Hamburger sidebar collapse toggle (`☰`)
  - External storefront shortcut (`🌐 Visit Site`)
- **Right Controls:**
  - Fullscreen toggle icon (`⛶`)
  - *(Reference shows yellow `ডেমো` badge — **to be omitted** in Mr. Tumi production software; replaced only in non-production environments by an environment indicator if desired)*
  - Pending-order notification bell (`🔔`) with red counter badge (`30` in screenshot)
  - User profile pill: avatar + `Admin ▾` dropdown

### 2.2 Complete Left Sidebar Menu Inventory (`41` Top-Level Entries)

Every top-level item below was verified in `image-1.png` (items 1–17), `image-2.png` (items 17–32), and `image-3.png` (items 29–41). Collapsed second-level links were verified from the saved dashboard DOM (`[DOM-VERIFIED]`).

| # | Top-Level Menu Label | Icon / Type | Screenshot Evidence | Child Submenu Items (`[DOM-VERIFIED]`) | Target Route Pattern |
|---|---|---|---|---|---|
| 1 | **Dashboard** | Monitor / Single | `image-1.png` (Active) | — | `/admin/dashboard` |
| 2 | **Gemini Assistant** | Chat bubble / Single | `image-1.png` | — | `/admin/gemini-chat` |
| 3 | **POS System** | CPU-Grid / Single | `image-1.png` | — | `/admin/order/create` (or `/admin/pos`) |
| 4 | **Orders** | Cart / Collapsible `>` | `image-1.png` | All Order, Reseller Orders, Incomplete Orders, Pending, Processing, On The Way, In Courier, Completed, Unpaid, Cancelled, Order Status, IP Block | `/admin/order/*`, `/admin/reseller-orders`, `/admin/incomplete-orders`, `/admin/orderstatus/manage`, `/admin/customer/ip-block` |
| 5 | **Refunds** | Rotate-CCW / Collapsible `>` | `image-1.png` | All Refunds, Pending Refunds, Approved Refunds, Processed Refunds | `/admin/refunds` (`?status=...`) |
| 6 | **Products** | Database / Collapsible `>` | `image-1.png` | All Inhouse Products, All Vendor Products, Pending Products, Wholesale Products, Add Product, Categories, Subcategories, Childcategories, Brands, Colors, Sizes | `/admin/inhouse-products/manage`, `/admin/products/*`, `/admin/categories/manage`, `/admin/subcategories/manage`, `/admin/childcategories/manage`, `/admin/brands/manage`, `/admin/color/manage`, `/admin/size/manage` |
| 7 | **Blog** | Edit / Collapsible `>` | `image-1.png` | All Blogs, Add New Blog | `/admin/blogs`, `/admin/blog/create` |
| 8 | **Purchases** | File-text / Single | `image-1.png` | — | `/admin/purchases/manage` |
| 9 | **Suppliers** | Truck / Single | `image-1.png` | — | `/admin/suppliers/manage` |
| 10 | **CRM / HR** | Users / Collapsible `>` | `image-1.png` | Employees, Attendance, Leaves, Salaries, Bonuses, Salary Payments | `/admin/employees`, `/admin/attendances`, `/admin/leaves`, `/admin/salaries`, `/admin/bonuses`, `/admin/salary-payments` |
| 11 | **Coupons** | Gift / Collapsible `>` | `image-1.png` | All Coupons, Add New | `/admin/coupon/manage`, `/admin/coupon/create` |
| 12 | **Reviews** | Star / Collapsible `>` | `image-1.png` | Pending Reviews (badge), All Reviews, Create | `/admin/review/pending`, `/admin/reviews` |
| 13 | **Landing Page** | Layout / Collapsible `>` | `image-1.png` | Campaign, Create | `/admin/campaign/manage`, `/admin/campaign/create` |
| 14 | **Manual Fraud Check** | Search / Single | `image-1.png` | — | `/admin/manual-fraud-check` |
| 15 | **Send Custom SMS** | Send / Single | `image-1.png` | — | `/admin/sms/custom-send` |
| 16 | **Complaints** | Alert-circle / Single | `image-1.png` | — | `/admin/complaints` |
| 17 | **Contact Messages** | Mail / Single | `image-1.png`, `image-2.png` | — | `/admin/contact-messages` |
| 18 | **Newsletter Subscribers** | Mail / Single | `image-2.png` | — | `/admin/newsletter-subscribers` |
| 19 | **Fund / Account** | Briefcase / Single | `image-2.png` | — | `/admin/fund` |
| 20 | **Expenses** | Credit-card / Single | `image-2.png` | — | `/admin/expenses` |
| 21 | **Vendors** | Users / Collapsible `>` | `image-2.png` | All Vendors, Vendor Verifications, Vendor Withdrawals | `/admin/vendors`, `/admin/vendor-verifications`, `/admin/vendor-withdrawals` |
| 22 | **Resellers** | User-check / Collapsible `>` | `image-2.png` | All Resellers, Reseller Deposits, Verifications, Withdrawals | `/admin/resellers`, `/admin/reseller-deposits`, `/admin/reseller-verifications`, `/admin/reseller-withdrawals` |
| 23 | **Users** | User / Collapsible `>` | `image-2.png` | User, Roles, Permissions, Customers | `/admin/users/manage`, `/admin/roles/manage`, `/admin/permissions/manage`, `/admin/customer` |
| 24 | **Delivery** | Truck / Collapsible `>` | `image-2.png` | Delivery persons, Rider withdrawals, Delivery locations (Division → District → Upazila) | `/admin/delivery-boys`, `/admin/delivery-withdrawals`, `/admin/delivery/divisions` |
| 25 | **Site Setting** | Settings / Collapsible `>` | `image-2.png` | General Setting, Sales Notification Popup, Social Media, Feature Bar, Contact, Create Page | `/admin/settings/manage`, `/admin/sale-notification`, `/admin/social-media/manage`, `/admin/features/manage`, `/admin/contact/manage`, `/admin/page/manage` |
| 26 | **Email Settings** | Mail / Single | `image-2.png` | — | `/admin/email-setting` |
| 27 | **Fraud API Settings** | Shield / Collapsible `>` | `image-2.png` | Manage Fraud API | `/admin/fraud-settings` |
| 28 | **Order Restriction** | Clock / Single | `image-2.png`, `image-3.png` | — | `/admin/order-restriction-settings` |
| 29 | **API Integration** | Save / Collapsible `>` | `image-2.png`, `image-3.png` | Payment Gateway, Manual Payment, SMS Gateway, Courier API, Facebook CAPI, Gemini AI, Social Login, Gemini Assistant | `/admin/paymentgeteway/*`, `/admin/smsgeteway/manage`, `/admin/courierapi/manage`, `/admin/facebook-capi/settings`, `/admin/gemini-ai/settings`, `/admin/social-login/settings` |
| 30 | **Cron Job** | Clock / Single | `image-2.png`, `image-3.png` | — | `/admin/cron-jobs` |
| 31 | **G. Pixel and GTM** | Save-Code / Collapsible `>` | `image-2.png`, `image-3.png` | Tag Manager, Pixel Manage, TikTok Pixel | `/admin/tag-manager/manage`, `/admin/pixels/manage`, `/admin/tiktok-pixels/manage` |
| 32 | **Live Ads Result** | Trending-up / Collapsible `>` | `image-2.png`, `image-3.png` | Overview, Facebook Ads, Google Ads, TikTok Ads | `/admin/ads-analytics`, `/admin/ads-analytics/*` |
| 33 | **Facebook Page Post** | Share-2 / Single | `image-2.png`, `image-3.png` | — | `/admin/facebook-page/settings` |
| 34 | **Banner & Sliders** | Image / Single | `image-3.png` | — | `/admin/banner/manage` |
| 35 | **Popup Offer** | Message-square / Single | `image-3.png` | — | `/admin/popup` |
| 36 | **Sales Notification Popup** | Bell / Single | `image-3.png` | — | `/admin/sale-notification` |
| 37 | **Reports** | Pie-chart / Collapsible `>` | `image-3.png` | Order Report, Purchase Report, Expense Report, Stock Report, Profit & Loss | `/admin/reports/*` |
| 38 | **SEO Settings** | Globe / Single | `image-3.png` | — | `/admin/seo-settings` |
| 39 | **Sitemap Settings** | Map / Single | `image-3.png` | — | `/admin/sitemap` |
| 40 | **License** | Key / Single | `image-3.png` | — | `/admin/license-info` |
| 41 | **System Updates** | Refresh-cw / Single | `image-3.png` | — | `/admin/updates` |
| 42 | **Clear Cache** | Refresh-cw / Single | `image-3.png` | — | `/admin/clear-cache` |
| 43 | **Error Log** | File-text / Single | `image-3.png` | — | `/admin/error-log` |

*(Plus Mandatory Additions from Master Plan: **Audit Logs** viewer under Users/Security, **Wholesale Applications/Orders** under Products/Wholesale, **Order OTP Settings** under Order Restriction/SMS, and **Android WebView App Info/Config**.)*

---

## 3. Admin Dashboard Layout Specification (`[SCREENSHOT-VERIFIED]`)

The dashboard main canvas (`#f4f6f9` light-gray background, `#ffffff` cards with `1px solid #e5e7eb` border and `12px` radius) consists of **9 vertical bands** plus **1 floating assistant button**:

1. **Band 1 — Page Title & Live Date (`image-1.png`):**
   - Left-aligned `Dashboard` (`h1`, bold dark `#111827`) + subtitle date (`Sunday, October 25, 2026` formatted in `Asia/Dhaka` timezone).
2. **Band 2 — 3-Column External Provider Status Strip (`image-1.png`):**
   - **Card 1 (`BULKSMSBD BALANCE`):** Blue phone icon badge, live balance value or provider error message (screenshot shows real provider error `— user id not found in this 56656 key`), `↻ Refresh` button.
   - **Card 2 (`BD COURIER · MY PLAN`):** Green truck icon badge, plan tier (`Free B`), usage counter (`API কল (ব্যবহার): 70`), next due date (`নেক্সট ডিউ ডেট: —`), `↻ Refresh` button.
   - **Card 3 (`STEADFAST COURIER`):** Purple chat/parcel icon badge, balance (`৳0.00`), in-review parcel count (`ইন রিভিউতে: 0 টি পার্সেল`), active status note, app courier order count (`কুরিয়ারে মোট (অ্যাপ): 0 টি অর্ডার`), `↻ Refresh` button.
3. **Band 3 — Traffic Source Attribution Card (`image-1.png`):**
   - Header: `Traffic Source`, subtitle `অর্ডার কোথা থেকে এসেছে • মোট N অর্ডার`, right badge `Auto-tracked`.
   - Horizontal sub-cards for each attributed channel (`Direct` indigo icon + progress bar, `Facebook` `#1877F2` icon + progress bar, `Google` / `TikTok` / `Other` slate icon + progress bar) with order count and percentage.
4. **Band 4 — 4-Column Primary KPI Strip (`image-1.png`):**
   - `TOTAL ORDERS` (blue cart icon, count, `X pending` subtext)
   - `TOTAL REVENUE` (green `$` icon, `৳...` delivered revenue, `X delivered` subtext)
   - `PENDING ORDERS` (amber trend icon, count, `Need attention` subtext)
   - `LOW STOCK` (rose alert-triangle icon, count, `Below X units` configurable threshold subtext)
5. **Band 5 — `TODAY'S SNAPSHOT` 3-Column Strip (`image-1.png`):**
   - `ORDERS` (`Orders placed today`), `REVENUE` (`Revenue today`), `DELIVERED` (`Delivered revenue`).
6. **Band 6 — `QUICK ACTIONS` 4-Button Action Bar (`image-1.png`, `image-2.png`):**
   - `+ Add Product`, `📋 View Orders`, `⊞ Categories`, `🛍️ Products`.
7. **Band 7 — 2-Column Analytics Charts (`image-2.png`, ~65% / 35% split):**
   - **Left (`Order Trend` — `Last 7 days`):** Area/line chart with dates on X-axis (`Oct 19`–`Oct 25`) and order counts on Y-axis.
   - **Right (`Order Status` — `All time breakdown`):** Donut chart with center total count and bottom color legend (`Pending`, `Processing`, `Completed`, `Cancelled`, etc.).
8. **Band 8 — 2-Column Catalogue Overview (`image-2.png`, ~60% / 40% split):**
   - **Left (`Products (N)` + `View all`):** Table with columns `PRODUCT` (square thumbnail + title), `CATEGORY`, `PRICE` (`৳...`), `STOCK` (green/red pill).
   - **Right (`Product Categories` + `View all`):** List of categories with dark dot + category name on left and product count pill on right.
9. **Band 9 — `Recent Orders` Table + `FINANCE SUMMARY` 4-Card Strip (`image-3.png`):**
   - **Recent Orders Table:** `CUSTOMER`, `INVOICE` (`#32721`), `AMOUNT` (`৳520`), `STATUS` (colored badge pill), `DATE` (`14 Oct 2026`), plus `View all` link.
   - **Finance Summary (`4` cards):** `FUND BALANCE`, `TOTAL EXPENSES`, `TODAY'S EXPENSES`, `MONTHLY EXPENSES` — all derived strictly from real database ledger entries.
10. **Floating Action Widget (`image-1.png`–`image-3.png`):**
    - Bottom-right circular indigo/violet (`#6366f1`) robot button opening the AI / Admin Assistant slide-over panel.

---

## 4. Customer Storefront Audit Checklist (`[STOREFRONT-VERIFIED]`)

Audited via read-only inspection of `https://eshop2.coderinbd.com/`:

| Area | Reference Observation | Mr. Tumi Grocery & Gift Requirement |
|---|---|---|
| **Top Notice Bar** | Scrolling Bangla marquee (`SPECIAL NOTICE`) | Configurable bilingual (`bn`/`en`) top announcement bar from DB settings |
| **Header & Search** | Brand logo, search bar, cart counter, navigation | Original **Mr. Tumi Grocery & Gift** branding, live search, language switcher (`বাংলা / EN`), Customer Account login/profile, Cart badge |
| **Hero & Promo Banners** | Multi-slide hero banner + mid-page promotional banners | DB-driven responsive sliders (`hero`, `promo_mid`, `promo_bottom`) with grocery & gift campaigns |
| **Flash Sale & Hot Deal** | Countdown timers (`দিন : ঘণ্টা : মিনিট : সেকেন্ড`), `% ছাড়` badge, `বিক্রি X • বাকি Y`, `/flash-sales`, `/hot-deals` | DB-configured campaign start/end timestamps (`Asia/Dhaka`), server-validated promo pricing |
| **Product Cards** | Image, discount badge, title, old/new price in `৳`, `অর্ডার করুন` quick-option modal (`পণ্য অপশন নির্বাচন করুন` -> `কার্টে যোগ করুন` / `অর্ডার করুন`) | Add to Cart + Quick Variant Modal, stock-aware button states, accessible keyboard/mobile touch targets |
| **Product Detail (`/product/:slug`)** | Multi-image gallery, Brand, Category, SKU/Code, Stock status, Wholesale tier table (`পাইকারি মূল্য`), Color/Size selectors, Qty `−/+`, `Add to Cart`, `Buy Now`, description, reviews, related products | Full Grocery (weight/pack variants) & Gift (box/wrapping/message note options) variant support + verified reviews |
| **Checkout (`/customer/checkout`)** | 3-step indicator (`কার্ট → চেকআউট → কনফার্মেশন`), Delivery form (`পূর্ণ নাম`, `মোবাইল নম্বর`, `সম্পূর্ণ ঠিকানা`, `শিপিং`, `অর্ডার নোট`), Payment cards (`COD`, `bKash`, `ShurjoPay`, `UddoktaPay`, Manual methods with `TrxID`), Coupon box, Summary | Guest + Registered checkout, BD phone validation, OTP verification (when enabled), configurable Advance Payment + COD balance calculation, server-side total calculation, idempotency token |
| **Order Tracking** | `/site/order-track` returned HTTP `404` on reference site | Working `/track-order` route with invoice + phone verification (preventing PII leakage via invoice guessing!) |
| **Social Proof & Support** | Verified Order toast popup (`এই মাত্র কিনেছেন`) + floating `লাইভ সহায়তা` widget (`প্রোডাক্ট খুঁজুন`, `অর্ডার ট্র্যাক`, `কমপ্লেইন`, `রিফান্ড`) | Privacy-safe recent order notification (masked/first name + district only, configurable toggle) + live support/complaint ticket submission |

---

## 5. Existing Workspace Baseline Audit (`/home/user/Mrtumi`)

Per **Fundamental Rule 4** (*"Inspect the existing project before changing anything. Preserve working features and avoid unnecessary rewrites"*), the current workspace at `/home/user/Mrtumi` on branch `arena/8689c974-mrtumi` (base commit `781fcb4`) was inspected:

- **What currently exists (uncommitted working tree prototype):**
  - Node.js (`v22.22.3`) + Express 4 + native `node:sqlite` (`DatabaseSync`) + EJS + Bootstrap 5 modular monolith (`server.js`, `src/db/database.js`, `src/middleware/*`, `src/routes/*`, `views/store/*`, `views/admin/*`, `views/vendor/*`, `views/reseller/*`).
- **Critical Gaps Between Current Prototype and the 20-Phase Master Plan (Why Phased Hardening is Essential):**
  1. **Branding & Domain:** Currently branded as *"ফল বাজার"* (lychee demo seed) rather than **Mr. Tumi Grocery & Gift** with bilingual (`bn`/`en`) UI switching.
  2. **Database & Money Precision:** Currently uses `REAL` floating-point columns in a single monolithic `initializeDatabase()` script rather than **versioned reversible migrations** and **integer minor units (paisa) / exact BDT integer/decimal arithmetic** with foreign-key enforcement (`PRAGMA foreign_keys = ON`) and explicit SQLite `BEGIN IMMEDIATE` transactions.
  3. **Security & Compliance:** Lacks CSRF tokens on state-changing forms, rate limiting on login/checkout/OTP/fraud endpoints, granular server-side RBAC permission checks per route, audit trail table (`audit_logs`), `.env.example`, and PII redaction/masking in logs and public order tracking.
  4. **Mandatory Business Logic Missing or Stubbed:**
     - Registered Customer Accounts (sign-up, login, password reset, address book)
     - Order OTP Verification (expiry, attempt limits, cooldown, rate limit)
     - Configurable Advance Payment (fixed/percentage) + remaining COD balance & payment reconciliation
     - Stock Ledger (`inventory_movements`), stock reservations, partial purchase receiving, and CSV import/export
     - Formal Wholesale customer onboarding/approval workflow
     - Official provider adapters with honest state tracking (`NOT_CONFIGURED` / `SANDBOX` / `LIVE`) instead of simulated courier/payment responses
     - Meta Pixel + Facebook CAPI deduplication (`event_id`) + GTM + TikTok Pixel + UTM attribution
     - Reusable Multi-Product Landing Page themes (draft/preview/publish)
     - POS Cashier Shift/Session reconciliation & barcode/SKU lookup
     - Customer & Admin Android WebView App source projects (Phase 19)
     - Automated test suite + CI workflow + backup/restore scripts

---

## 6. Functional Requirements Summary by Mandatory Module

| Module ID | Module Name | Core Mandatory Requirements | Target Phase |
|---|---|---|---|
| **M01** | **Architecture, Config & CI** | Modular monolith, `.env.example`, dev/test/prod separation, ESLint/formatting, GitHub Actions CI, zero secrets in Git | Phase 02 |
| **M02** | **Database, Migrations & Transactions** | Versioned up/down SQL migrations, FK constraints, indexes, integer minor-unit (`paisa`) money handling, `BEGIN IMMEDIATE` transactions, idempotency keys, structured logger, `/health` endpoint | Phase 03 |
| **M03** | **Mr. Tumi Branding & Bilingual Design System** | Original Mr. Tumi Grocery & Gift branding, Bangla/English (`bn`/`en`) toggle + dictionaries, responsive desktop/tablet/mobile UI, WCAG-compliant forms, BDT & `Asia/Dhaka` formatting | Phase 04 |
| **M04** | **Customer Storefront** | DB-driven home, grocery & gift categories/subcategories/childcategories, search/filter/sort/pagination, variant picker, related items, CMS pages, FAQ, blog, reviews, SEO & `/sitemap.xml` | Phase 05 |
| **M05** | **Products, Stock Ledger, Purchases & Suppliers** | SKU/barcode, cost/selling/wholesale prices, immutable `stock_ledger` movements, stock reservation/release, supplier POs, full/partial receiving, damaged/return adjustments, low-stock alerts, CSV import/export | Phase 06 |
| **M06** | **Customer Accounts, Cart & Checkout** | Guest + registered customer accounts, address book, BD mobile regex (`^01[3-9]\d{8}$`), persistent cart, configurable delivery zones/fees, server-side total calculation, idempotent checkout, consent checkbox | Phase 07 |
| **M07** | **Order Lifecycle, Incomplete Orders, OTP & Advance Payment** | Unique invoice numbers, configurable status state machine + `order_status_history`, authorized edits, returns/refunds, consent-aware incomplete checkout capture, OTP verification, fixed/% advance payment + COD balance, min/max order rules | Phase 08 |
| **M08** | **Admin Dashboard, Staff Users, Roles & RBAC** | 1:1 reference-inspired dashboard (100% live DB queries), staff CRUD, granular permissions enforced server-side on every route, permission-filtered sidebar, `audit_logs` on all sensitive mutations | Phase 09 |
| **M09** | **Courier & Delivery Integrations** | Shared `CourierProvider` interface + adapters for **Steadfast**, **Pathao**, **RedX** + internal Delivery Riders & Division→District→Upazila table; webhook signature check, duplicate booking lock, COD reconciliation, redacted API logs | Phase 10 |
| **M10** | **Payment Gateways** | Shared `PaymentGateway` interface + **bKash**, **ShurjoPay**, **UddoktaPay**, **Manual Transfer**, and **COD**; server-to-server verification, callback validation, idempotency, payment ledger, refund states | Phase 11 |
| **M11** | **Fraud Check, Order Restriction & IP/Phone Blocking** | **BDCourier** fraud-check adapter + manual lookup UI, configurable risk thresholds -> manual-review queue, velocity/attempt limits, temporary (TTL) & permanent IP/phone blocks, shared-IP/CGNAT safe handling (never blind auto-reject on shared mobile carrier IP alone), block/unblock audit trail | Phase 12 |
| **M12** | **Bulk SMS BD & Notifications** | **BulkSMSBD** adapter, bilingual SMS templates, OTP + order confirmation + status updates, retry queue, provider status vs submission distinction, phone masking in logs, admin test-SMS action | Phase 13 |
| **M13** | **Pixels, CAPI, GTM & Visitor Attribution** | Meta Pixel, Facebook CAPI (server-side with shared `event_id` deduplication), Google Tag Manager, TikTok Pixel, UTM/referrer capture, verified-purchase-only `Purchase` firing, PII minimization | Phase 14 |
| **M14** | **Multi-Product Landing Pages, Promotions & Content** | Reusable multi-product landing-page themes (grocery combo, gift hamper, festival offer), draft/preview/publish workflow, banners, popup offers, privacy-safe sales notification popup, coupons with validity rules | Phase 15 |
| **M15** | **Wholesale, Multivendor & Reseller** | Separate RBAC-isolated modules: Wholesale buyer application/tiers/MOQ; Vendor onboarding/approval, isolated dashboard, product moderation, commission & dispute/settlement ledger; Reseller onboarding, margin/commission rules, order attribution & reversal on return/cancel | Phase 16 |
| **M16** | **POS, CRM & HRM** | POS barcode/SKU scan, cashier shift open/close reconciliation, receipt print, POS returns; CRM customer history, support notes, complaints; HRM departments, employees, attendance, shifts, leaves, documents (payroll gated on owner compliance confirmation) | Phase 17 |
| **M17** | **Reports, Finance & System Settings** | Fund accounts, expense categories, distinct Revenue vs Collected Cash vs Outstanding COD vs Expenses vs Net Profit reports, courier/gateway reconciliation, permissioned CSV export, SMTP email, SEO, cron monitor, error log, cache clear | Phase 18 |
| **M18** | **Android WebView Apps (Customer + Admin)** | Native Android (Kotlin/Gradle) project sources for Customer Storefront App & Admin App: HTTPS enforcement, safe external payment intent/redirect handling, deep links, offline screen, session expiry, zero hardcoded secrets, build & signing guide | Phase 19 |
| **M19** | **Full QA, Security Audit & Deployment Readiness** | Unit + integration + E2E tests, RBAC/CSRF/SQLi/XSS audit, backup & restore verification, `DEPLOYMENT.md`, `INTEGRATION_STATUS.md`, release checklist (no production deploy without explicit owner approval) | Phase 20 |

---

## 7. Feature Dependency Map

```
PHASE 01 (Audit & Requirements)
   │
   ▼
PHASE 02 (Architecture, Repo, Env, Linting, CI)
   │
   ▼
PHASE 03 (Migrations, Schema, Money Math, Auth/RBAC Core, Transactions, Audit Log, Logger)
   ├───────────────────────────────┬───────────────────────────────┐
   ▼                               ▼                               ▼
PHASE 04 (Mr. Tumi Brand + i18n)  PHASE 06 (Products, Stock       PHASE 09 (Admin Dashboard,
   │                               Ledger, Suppliers, Purchases)   Users, Granular RBAC)
   ▼                               │                               │
PHASE 05 (Customer Storefront) ◄───┘                               │
   │                                                               │
   ▼                                                               │
PHASE 07 (Customer Accounts, Cart, Zones, Server-Validated Checkout)
   │
   ▼
PHASE 08 (Order Workflow, Incomplete Orders, OTP, Advance Payment, Refunds)
   ├──────────────┬──────────────┬──────────────┬──────────────────┤
   ▼              ▼              ▼              ▼                  ▼
PHASE 10       PHASE 11       PHASE 12       PHASE 13           PHASE 14
(Couriers:     (Payments:     (Fraud API,    (BulkSMSBD &       (Meta Pixel, CAPI,
Steadfast,     bKash,         Restrictions,  Notification       GTM, TikTok,
Pathao, RedX)  ShurjoPay,     CGNAT-Safe     Queue)             UTM Attribution)
               UddoktaPay)    IP/Phone Block)
   │              │              │              │                  │
   └──────────────┴──────┬───────┴──────────────┴──────────────────┘
                         ▼
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
      PHASE 15        PHASE 16        PHASE 17
   (Multi-Product   (Wholesale,     (POS + Cashier
   Landing Pages,   Multivendor &   Shifts, CRM &
   Promos, CMS)     Reseller)       HRM)
         └───────────────┼───────────────┘
                         ▼
                      PHASE 18 (Finance Reconciliation, Reports, Settings, Cron, Diagnostics)
                         │
                         ▼
                      PHASE 19 (Customer & Admin Android WebView Apps)
                         │
                         ▼
                      PHASE 20 (Full QA, Security Audit, Backup/Restore Drill & Deployment Package)
```

---

## 8. Unverified Items List (`[UNVERIFIED / ASSUMED]`)

In accordance with Phase 01 instructions (*"Distinguish screenshot-verified items from assumptions. Do not claim that hidden features have been inspected"*), the following items could **not** be visually verified from the 3 dashboard screenshots or public storefront URL:

1. **Inner Admin Sub-Page Layouts on Reference Site:** Exact form fields inside the reference site's inner admin pages (e.g., `/admin/salaries`, `/admin/facebook-page/settings`, `/admin/order-restriction-settings`, `/admin/license-info`) were behind authentication on `eshop2.coderinbd.com` and not included in the 3 screenshots.
2. **Owner's Target Hosting Environment:** Shared cPanel (PHP/MySQL vs Node.js Passenger), VPS (Ubuntu/Docker/Nginx), or Managed Cloud (Render/Railway/DigitalOcean) is not yet specified by the owner.
3. **Live Third-Party API Credentials:** No sandbox or production API keys have been supplied yet for `Steadfast`, `Pathao`, `RedX`, `BDCourier`, `bKash`, `ShurjoPay`, `UddoktaPay`, `BulkSMSBD`, `Meta CAPI`, or `SMTP`.
4. **Reference Site's `Live Ads Result` Data Source:** Whether the reference site pulls live ad spend via Meta/Google/TikTok Marketing OAuth APIs or manual/pixel-attributed reporting is unverified from the screenshots.
5. **Android Play Store Package IDs & Signing Keystore:** Desired Android `applicationId`s (e.g., `com.mrtumi.shop` and `com.mrtumi.admin`) and splash/icon assets are not yet provided.
6. **Bangladesh Payroll / Tax / HRM Rules:** Exact salary deduction, overtime, or tax rules for Mr. Tumi's staff (Phase 17 explicitly requires confirming local compliance rules before implementing payroll).

---

## 9. Risk Register & Mitigations

| Risk ID | Category | Risk Description | Severity | Mitigation Strategy |
|---|---|---|---|---|
| **R-01** | Hosting Compatibility | Owner's hosting might be cPanel shared hosting without Node.js support, or might lack persistent disk/cron support | **High** | Confirm exact hosting environment with owner before committing Phase 02 stack; document runtime & database options clearly |
| **R-02** | Financial Accuracy | Floating-point math (`0.1 + 0.2`) or trusting browser-submitted totals causes BDT/discount rounding errors or price tampering | **Critical** | Store all monetary amounts as integer minor units (`paisa`, `1 BDT = 100 paisa`) or exact integer BDT + server-only calculation inside DB transactions |
| **R-03** | Overselling & Stock Drift | Concurrent Storefront, POS, Landing Page, and Reseller orders decrementing stock without locking or ledger entries | **Critical** | Use atomic `BEGIN IMMEDIATE` transactions + immutable `stock_ledger` table; reconcile cached `products.stock` against ledger sum in automated tests |
| **R-04** | Shared Carrier IP False Positives | Bangladesh mobile operators (GP, Robi, Banglalink, Teletalk) use CGNAT where thousands of legitimate shoppers share one public IPv4 | **High** | Never auto-reject solely on shared IP; combine phone/account velocity, OTP step-up challenge, TTL-expiring rate limits, and manual review queue |
| **R-05** | Fake Payment / Unverified Callback | Customer spoofs browser return URL from bKash/ShurjoPay/UddoktaPay without paying | **Critical** | Mark order paid **only** after server-to-server payment verification API call + idempotent transaction reference check |
| **R-06** | PII Exposure in Order Tracking / Logs | Public order tracking by 5-digit invoice alone lets attackers enumerate customer names, phones, and addresses | **High** | Require **both** Invoice ID + matching Customer Phone (or authenticated account) on `/track-order`; mask phone numbers & redact tokens in logs |
| **R-07** | Unconfigured External Providers | Live courier/SMS/payment APIs cannot be verified until owner supplies sandbox/production credentials | **Medium** | Implement strict provider adapter interfaces + honest status badges (`NOT_CONFIGURED`, `SANDBOX_CONFIGURED`, `LIVE_VERIFIED`); never fake live success |

---

## 10. Questions Requiring Owner Decisions (`OWNER APPROVAL REQUIRED`)

Per **Fundamental Rule 23**, please confirm or adjust the proposed safe defaults below before Phase 02 begins:

1. **Q1 — Hosting Target & Stack Confirmation (Critical for Phase 02):**
   - *Question:* What type of hosting will you deploy **Mr. Tumi Grocery & Gift** on (e.g., **VPS / Cloud Server**, **cPanel with Node.js Selector**, or **cPanel PHP/MySQL-only shared hosting**)?
   - *Proposed Default:* Keep and harden the **Node.js 22 + Express + SQLite (WAL) / PostgreSQL-ready Modular Monolith** currently in `/home/user/Mrtumi` if your hosting supports Node.js (VPS, Cloud, or cPanel with NodeJS). *(If your hosting is strictly PHP/MySQL-only cPanel without Node.js, tell us now so we align Phase 02 before writing further code!)*
2. **Q2 — Brand Visuals & Default Language:**
   - *Question:* Should the default storefront language on first visit be **Bangla (`bn`)** with a header toggle to **English (`en`)**, and do you have an official logo/color palette for **Mr. Tumi Grocery & Gift**?
   - *Proposed Default:* Default **Bangla (`bn`)** with instant `বাংলা / EN` switcher; original **Mr. Tumi Grocery & Gift** SVG wordmark + fresh emerald-green (`#1b4332` / `#16a34a`) & warm gift-gold (`#d97706`) palette until final brand assets are supplied.
3. **Q3 — GitHub Remote Push Policy:**
   - *Question:* Do you authorize committing and pushing completed phase work to branch `arena/8689c974-mrtumi` on your connected GitHub repository (`mrtumi2026/Mrtumi`) at the end of each phase starting in Phase 02?
   - *Proposed Default:* Wait for your explicit confirmation before running `git push`.
4. **Q4 — Order OTP & Advance Payment Defaults (Phase 08):**
   - *Question:* Should **COD Order OTP Verification** and **Advance Delivery Charge Payment** be *optional & admin-toggleable* (OFF by default until BulkSMSBD / Payment credentials are entered), or mandatory for outside-Dhaka orders?
   - *Proposed Default:* Configurable in Admin Settings (supports OFF, All COD Orders, or Outside-Dhaka / High-Value Orders Only; Advance Payment configurable as OFF, Delivery Charge Only, Fixed BDT, or `%` of order).
5. **Q5 — Ownership & Refund Rules Across Vendor / Reseller / Wholesale (Phase 16):**
   - *Question:* Who holds physical stock and bears return shipping cost for Multivendor vs Reseller orders?
   - *Proposed Default:* **Inhouse & Reseller orders** draw from Mr. Tumi warehouse stock (Reseller margin credited only after `Completed` delivery and reversed on return); **Vendor products** track vendor-owned stock, require Admin product approval before going live, and credit `(Item Subtotal − Commission %)` to Vendor wallet upon `Completed` delivery.
6. **Q6 — HRM Payroll Scope (Phase 17):**
   - *Question:* Do you want simple Bangladesh SME monthly salary sheet (Basic + Bonus/Allowance − Advance/Leave Deduction = Net Payable) or statutory tax/provident-fund calculation?
   - *Proposed Default:* Configurable SME Salary Sheet (Basic + Bonus − Deduction) with manual approval before payout recording.

---

## 11. Phase 01 Acceptance Criteria Verification

- [x] Reference URL (`https://eshop2.coderinbd.com/`) and all three Admin screenshots (`image-1.png`, `image-2.png`, `image-3.png`) analyzed without modifying the reference site.
- [x] Complete visible sidebar/menu inventory (`43` top-level items + all collapsible child items) documented with screenshot vs DOM evidence tags.
- [x] Dashboard layout specification documented across all 9 bands + floating assistant widget.
- [x] Customer storefront audit checklist completed (including reference `/site/order-track` 404 finding).
- [x] Functional requirements defined for all mandatory modules (`M01`–`M19`).
- [x] Feature dependency map created across all 20 phases.
- [x] Unverified items list explicitly separated from verified facts.
- [x] Risk register and owner decision questions documented with safe defaults.
- [x] Initial `MASTER_CHECKLIST.md`, `PROJECT_STATUS.md`, `DECISIONS.md`, `INTEGRATION_STATUS.md`, and `DEPLOYMENT.md` created.
- [x] Zero application code modified during Phase 01.
