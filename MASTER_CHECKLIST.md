# MASTER CHECKLIST — Mr. Tumi Grocery & Gift

**Allowed Status Values (Rule 25):**  
`NOT STARTED` | `IN PROGRESS` | `IMPLEMENTED` | `TESTED AND PASSED` | `FAILED` | `BLOCKED` | `OWNER APPROVAL REQUIRED`

---

## Phase & Feature Inventory

### PHASE 01 — Reference Audit & Requirements
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P01-01 | Admin sidebar & menu inventory (screenshot vs DOM evidence) | `TESTED AND PASSED` | `docs/PHASE_01_REFERENCE_AUDIT.md` §2 |
| P01-02 | Admin dashboard 9-band layout specification | `TESTED AND PASSED` | `docs/PHASE_01_REFERENCE_AUDIT.md` §3 |
| P01-03 | Customer storefront audit checklist | `TESTED AND PASSED` | `docs/PHASE_01_REFERENCE_AUDIT.md` §4 |
| P01-04 | Mandatory module functional requirements & dependency map | `TESTED AND PASSED` | `docs/PHASE_01_REFERENCE_AUDIT.md` §6–§7 |
| P01-05 | Unverified items list, risk register & owner decision log | `TESTED AND PASSED` | `docs/PHASE_01_REFERENCE_AUDIT.md` §8–§10 |
| P01-06 | Initial governance documents (`MASTER_CHECKLIST.md`, `PROJECT_STATUS.md`, `DECISIONS.md`, `INTEGRATION_STATUS.md`, `DEPLOYMENT.md`) | `TESTED AND PASSED` | Verified in commit `3611777` |
| P01-07 | Owner review & core business-rule sign-off | `TESTED AND PASSED` | Confirmed by owner |

### PHASE 02 — Architecture, GitHub & Development Foundation
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P02-01 | BestWebHostBD confirmed (`Node.js` + `SSH` + `MySQL-only`) vs `UNVERIFIED` audit (`docs/CPANEL_COMPATIBILITY.md`) | `TESTED AND PASSED` | Strictly separates confirmed facts from `U-01`–`U-08` |
| P02-02 | Finalized architecture specification (`docs/ARCHITECTURE.md` — Express + EJS + Production MySQL) | `TESTED AND PASSED` | Covers all 13 mandatory architecture pillars |
| P02-03 | Non-destructive SQLite-to-MySQL migration plan (`docs/MYSQL_MIGRATION_PLAN.md`) | `TESTED AND PASSED` | Audits all 50 tables + SQL idioms, DDL, `paisa` math, rollback & verification |
| P02-04 | Clean folder conventions, Passenger `app.js`, `.gitignore`, `.env.example` & secret removal | `TESTED AND PASSED` | Existing SQLite prototype preserved non-destructively |
| P02-05 | Dev / test / prod config (`src/config/env.js`: blocks SQLite in `production`, enforces `Asia/Dhaka`, `BDT`, `bn`/`en`) | `TESTED AND PASSED` | Verified in `tests/phase02-foundation.test.js` |
| P02-06 | Linting, EJS compilation, secret scanner (`scripts/check-foundation.js`) & GitHub Actions CI | `TESTED AND PASSED` | Verified via `npm run verify` |
| P02-07 | Explicit owner approval gate to begin Phase 03 implementation | `TESTED AND PASSED` | Approved by owner to execute Phase 03 |

### PHASE 03 — Database, Backend & API Foundation
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P03-01 | `mysql2` connection pool + versioned reversible MySQL migrations & rollback CLI | `TESTED AND PASSED` | `src/db/mysqlPool.js`, `src/db/migrator.js`, `scripts/migrate.js` (`0001`–`0003`) |
| P03-02 | Foreign keys, indexes, constraints & minor-unit (`paisa` `BIGINT`) money schema | `TESTED AND PASSED` | `71` `InnoDB` `utf8mb4_unicode_ci` tables + `src/utils/money.js` |
| P03-03 | MySQL transaction wrapper (`FOR UPDATE`) & idempotency middleware | `TESTED AND PASSED` | `withTransaction`, `lockRowsById`, `idempotencyRepository.js`, `inventoryFoundationRepository.js` |
| P03-04 | Auth, RBAC, CSRF, rate limiting, validation & consistent API/error format | `TESTED AND PASSED` | `src/middleware/{csrf,rateLimit,rbac,errorHandler}.js` + Phase 03 async repos |
| P03-05 | Structured PII-redacting logger, `/health` endpoint & MySQL 8.0 CI test suite | `TESTED AND PASSED` | `src/utils/logger.js`, `src/routes/apiFoundation.js`, `.github/workflows/ci.yml` |
| P03-06 | Explicit owner approval gate to begin Phase 04 implementation | `TESTED AND PASSED` | Approved by owner to execute Phase 04 |

### PHASE 04 — Branding, Design System & Bilingual UI
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P04-01 | **Mr. Tumi Grocery & Gift** brand identity & temporary placeholder assets (`public/uploads/brand/`, `src/i18n/brand.js`) | `TESTED AND PASSED` | Zero reference `"ফল বাজার"` identity in UI; temporary placeholder SVGs active awaiting official owner logo files |
| P04-02 | Bangla (`bn` default) & English (`en`) language switching + 1:1 parity dictionaries (`src/i18n/`, `/locale/:lang`) | `TESTED AND PASSED` | Persisted in session + `mrtumi_lang` cookie; legal/policy copy flagged for owner review (`copy-review-notice.ejs`) |
| P04-03 | Responsive design system, WCAG AA tokens, accessible sidebar/mobile nav & reusable EJS components | `TESTED AND PASSED` | `mrtumi-design-system.css`, `mrtumi-ui.js`, `views/partials/*.ejs`, 43-item dark Admin sidebar & mobile offcanvas |
| P04-04 | Bangladesh currency (`৳`), South Asian grouping, Bangla numerals & `Asia/Dhaka` timestamp formatters | `TESTED AND PASSED` | `src/utils/formatters.js`, verified in `tests/phase04-ui-i18n.test.js` |
| P04-05 | Explicit owner approval gate to begin Phase 05 implementation | `TESTED AND PASSED` | Approved by owner to execute Phase 05 |

### PHASE 05 — Customer Storefront
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P05-01 | Grocery & Gift homepage (DB banners, featured categories, validated Flash Sale & Hot Deal, gift showcase, blogs) | `TESTED AND PASSED` | `views/store/home.ejs` + MySQL-first `storefrontRepository.js` (zero fabricated countdowns/metrics) |
| P05-02 | Category, subcategory, childcategory, brand, search, price/stock/deal filters, 5 sort modes & pagination | `TESTED AND PASSED` | `views/store/catalog.ejs`, `/category/:slug`, `/subcategory/:slug`, `/childcategory/:slug`, `/brand/:slug` |
| P05-03 | Product detail page (DB gallery, `product_variants`/options, approved wholesale tier guard, cart entry points, related items) | `TESTED AND PASSED` | `views/store/product.ejs` + live MySQL 8.0 & local verification (`tests/phase05-*.test.js`) |
| P05-04 | Contact, FAQ, About, policy pages (`copy-review-notice`), blog, moderated approved reviews, Product JSON-LD, `/sitemap.xml` & `/robots.txt` | `TESTED AND PASSED` | `views/store/page.ejs`, `/about`, `/faq`, `/contact`, `/blogs`, `/sitemap.xml`, `/robots.txt` |
| P05-05 | Explicit owner approval gate to begin Phase 06 implementation | `TESTED AND PASSED` | Owner's latest prompt explicitly authorized Phases 06–20 implementation; production deployment remains separately gated |

### PHASE 06 — Products, Inventory, Purchases & Suppliers
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P06-01 | Product creation with unique SKU, bilingual names, category/brand ID validation, paisa prices, optional opening stock ledger, archive/restore and raster upload hardening | `IMPLEMENTED` | Initial vertical slice at `/admin/phase06`; edit, variants, gallery manager, bulk operations, robust taxonomy selectors, CSV import/export remain `NOT STARTED` |
| P06-02 | Warehouse/vendor inventory reads, reason-required negative-safe adjustments, immutable `stock_ledger` movements, low-stock threshold display, MySQL row locks and audit | `IN PROGRESS` | Covered adjustments and concurrent locking passed local and MySQL 8.0 CI (`40277859457`); variant movement, reservation/release and full inventory reports remain outstanding |
| P06-03 | Supplier create, multi-line draft purchase order, partial/full receipt, receipt idempotency and atomic stock/ledger update | `IN PROGRESS` | Covered draft/partial receipt/idempotency paths tested locally and on MySQL 8.0 CI (`40277859457`). Supplier edit/history, PO order/cancel transitions, receipt UI, supplier returns and payable ledger remain outstanding |
| P06-04 | Checkout stock reservation/release, low-stock thresholds & CSV import/export | `NOT STARTED` | Phase 07 checkout reservation/release; CSV tooling is outstanding |
| P06-05 | Phase 06 complete acceptance, batch/lot/expiry policy decision and live MySQL 8.0 approval | `IN PROGRESS` | Owner accepted the current milestone and approved moving into Phase 07; acceptance gaps and the unresolved batch/expiry requirement remain tracked in `docs/PHASE_06_PRODUCTS_INVENTORY_PURCHASES_SUPPLIERS.md` |

### PHASE 07 — Customer Accounts, Cart & Checkout
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P07-01 | Customer registration, login, logout, password recovery & address book | `IN PROGRESS` | MySQL-backed registration/login, regenerated sessions, POST logout and address management implemented; verified notification-based password recovery remains unavailable pending authorized channel |
| P07-02 | Guest checkout, BD phone validation & persistent cart sync | `IN PROGRESS` | Persistent cart load/replace/clear, guest merge, authenticated mutations, checkout refresh and post-success clear are implemented; cart add/update/remove/clear are CSRF-protected and exact-SHA MySQL CI run `40483319058` passed on `5f77f4077125ef40c48c71c1f5bed5284a3be128`. Cart cross-device concurrency/error recovery and other Phase 07 criteria remain open |
| P07-03 | Configurable delivery zones/fees, server-only total math & duplicate order lock | `IN PROGRESS` | Requires active owner-configured `delivery_locations` and COD gateway; server computes paisa totals, reserves inventory and uses request-hash idempotency; no defaults are seeded |
| P07-04 | Terms/privacy consent handling at checkout | `IN PROGRESS` | Required order confirmation and optional recovery opt-in exist; coded checkout slice passed live MySQL CI `40301701753`; approved legal copy/retention policy remain blockers |

### PHASE 08 — Order Management, Incomplete Orders, OTP & Advance Payment
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P08-01 | Order state machine, `order_status_history`, notes & authorized item edits | `IN PROGRESS` | MySQL row-locked transitions/history/audit and guarded admin UI; canonical checkout now creates/reserves orders; real-login/RBAC/CSRF/admin HTTP suite passed live MySQL CI `40301701753`; notes/item edits remain |
| P08-02 | Cancellation, returns, refund initiation & stock restoration | `IN PROGRESS` | Admin cancellation/failure releases reservations and shipment consumes stock; final `returned`/restock is disabled pending explicit owner policy; refund approval is internal only, no provider settlement |
| P08-03 | Consent-aware incomplete checkout capture & duplicate order detection | `IN PROGRESS` | Optional explicit recovery consent, no default capture/message consent, withdrawal/erasure; checkout request-hash migration and replay protection tested in live MySQL CI `40301701753`; remaining acceptance is open |
| P08-04 | Admin-configurable Order OTP verification (expiry, attempt cap, cooldown, rate limit) | `IN PROGRESS` | Repository OTP protections remain; admin HTTP endpoint exposes summary only; checkout blocks when OTP is enabled because customer verification/delivery is not wired; SMS blocked |
| P08-05 | Admin-configurable advance payment (fixed/%) + remaining COD balance & min/max order rules | `IN PROGRESS` | Integer-paisa math/settings exist; checkout blocks any non-zero advance until a verified provider collection path exists; coded checkout slice passed live MySQL CI `40301701753`; remaining acceptance is open |

### PHASE 09 — Admin Dashboard, Users & Permissions
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P09-01 | Reference-inspired dashboard powered 100% by real DB queries | `IN PROGRESS` | MySQL repository, explicit route permissions and full-stack MySQL HTTP tests passed CI `40308315393` on `448d2e6a1c60b36422ba825f486a78eea872d58e`. Provider metrics remain explicitly unavailable |
| P09-02 | Staff accounts, roles & granular server-side permission middleware | `IN PROGRESS` | Migration `0008` adds catalog keys without grants; MySQL staff/role lifecycle, distinct grant/role-assignment permissions, audit and session revocation passed CI `40308315393`. Owner must decide who receives grants; full legacy admin route coverage remains |
| P09-03 | Permission-filtered sidebar navigation & immutable `audit_logs` | `IN PROGRESS` | Selected sidebar/profile links are grant-filtered; read-only audit UI/API and mutation audit records passed CI `40308315393`. Remaining legacy links, database-level append-only protection and retention decision remain open |

### PHASE 10 — Courier & Delivery Integrations
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P10-01 | Unified `CourierAdapter` architecture, duplicate booking lock & redacted logs | `NOT STARTED` | Scheduled for Phase 10 |
| P10-02 | Steadfast Courier adapter, tracking sync, webhook & COD settlement | `BLOCKED` | Adapter in P10; live test blocked until API keys supplied |
| P10-03 | Pathao Courier adapter (city/zone/area, shipment, webhook) | `BLOCKED` | Adapter in P10; live test blocked until API keys supplied |
| P10-04 | RedX Courier adapter & internal Delivery Rider / Division→District→Upazila module | `BLOCKED` | Adapter in P10; live test blocked until API keys supplied |

### PHASE 11 — Payment Gateways
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P11-01 | Unified `PaymentGateway` ledger, server-to-server callback verification & idempotency | `NOT STARTED` | Scheduled for Phase 11 |
| P11-02 | bKash Tokenized Checkout adapter (sandbox + prod config) | `BLOCKED` | Adapter in P11; sandbox/live test needs bKash credentials |
| P11-03 | ShurjoPay adapter (sandbox + prod config) | `BLOCKED` | Adapter in P11; sandbox/live test needs ShurjoPay credentials |
| P11-04 | UddoktaPay adapter + Manual Payment verification + COD reconciliation | `BLOCKED` | Adapter in P11; sandbox/live test needs UddoktaPay credentials |

### PHASE 12 — Fraud Checking, Order Restriction & IP Blocking
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P12-01 | BDCourier fraud-checker API adapter + manual lookup interface | `BLOCKED` | Adapter in P12; live lookup needs BDCourier API key |
| P12-02 | Configurable risk thresholds, manual-review queue & velocity limits | `NOT STARTED` | Scheduled for Phase 12 |
| P12-03 | Temporary (TTL) & permanent IP/phone restrictions (CGNAT-safe) + block/unblock audit | `NOT STARTED` | Scheduled for Phase 12 |

### PHASE 13 — Bulk SMS & Notifications
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P13-01 | BulkSMSBD official API adapter, retry queue & delivery status tracking | `BLOCKED` | Adapter in P13; live send needs BulkSMSBD key & Sender ID |
| P13-02 | Bilingual (`bn`/`en`) SMS templates, OTP & order alerts, phone masking in logs | `NOT STARTED` | Scheduled for Phase 13 |

### PHASE 14 — Pixels, Tag Manager & Visitor Attribution
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P14-01 | Meta Pixel + Facebook Conversions API (`event_id` deduplication) | `NOT STARTED` | Scheduled for Phase 14 |
| P14-02 | Google Tag Manager & TikTok Pixel integration | `NOT STARTED` | Scheduled for Phase 14 |
| P14-03 | UTM/platform visitor tracking, consent handling & verified-only `Purchase` events | `IN PROGRESS` | First-party session UTM capture and order consent provenance are implemented behind `ANALYTICS_ATTRIBUTION_ENABLED=false` by default; user opt-in is CSRF-protected and revocable. Migration/order persistence, consent HTTP behavior and no-consent behavior passed exact-SHA MySQL CI run `40483319058` on `5f77f4077125ef40c48c71c1f5bed5284a3be128`. No external event or Purchase dispatch is implemented |

### PHASE 15 — Landing Pages, Promotions & Content
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P15-01 | Reusable multi-product landing-page themes with draft/preview/publish workflow | `NOT STARTED` | Uses shared validated checkout engine |
| P15-02 | Banners, sliders, popup offers, privacy-safe sales notification popup & coupon validity rules | `NOT STARTED` | Scheduled for Phase 15 |

### PHASE 16 — Wholesale, Multivendor & Reseller
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P16-01 | Wholesale buyer onboarding, approval, MOQ/pack rules & tiered pricing | `NOT STARTED` | Scheduled for Phase 16 |
| P16-02 | Isolated Multivendor portal, separate vendor stock, product moderation & commission ledger | `NOT STARTED` | Approved (`ADR-006`) |
| P16-03 | Isolated Reseller portal using Mr. Tumi warehouse stock, margin attribution & return reversal | `NOT STARTED` | Approved (`ADR-006`) |

### PHASE 17 — POS, CRM & HRM
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P17-01 | POS barcode/SKU search, cashier shift open/close reconciliation, receipts & POS returns | `NOT STARTED` | Scheduled for Phase 17 |
| P17-02 | CRM customer profiles, order history, support notes & complaints | `NOT STARTED` | Scheduled for Phase 17 |
| P17-03 | HRM employees, departments, attendance, shifts, leaves, documents & approved SME payroll | `NOT STARTED` | Approved (`ADR-008`) |

### PHASE 18 — Reports, Finance & System Settings
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P18-01 | Fund/account ledger, expense categories & reconciled P&L (Revenue ≠ Profit) | `NOT STARTED` | Scheduled for Phase 18 |
| P18-02 | Order, purchase, stock, courier COD, gateway, vendor/reseller & refund reports + CSV | `NOT STARTED` | Scheduled for Phase 18 |
| P18-03 | Site, email/SMTP, SEO, sitemap, cron monitor, error log, cache clear & update status | `NOT STARTED` | Scheduled for Phase 18 |

### PHASE 19 — Customer & Admin Android WebView Apps
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P19-01 | Customer Android WebView project source (deep links, safe payment redirects, offline UI) | `NOT STARTED` | Scheduled for Phase 19 |
| P19-02 | Admin Android WebView project source (role-aware, session timeout, zero embedded secrets) | `NOT STARTED` | Scheduled for Phase 19 |
| P19-03 | Build instructions, keystore signing guide & release documentation | `NOT STARTED` | Scheduled for Phase 19 |

### PHASE 20 — Full QA, Security Audit & Owner-Hosting Deployment
| ID | Feature / Deliverable | Status | Notes |
|---|---|---|---|
| P20-01 | Full unit, integration, RBAC, financial reconciliation & E2E test suite execution | `NOT STARTED` | Scheduled for Phase 20 |
| P20-02 | Security audit (CSRF, XSS, SQLi, upload safety, dependency audit, PII redaction) | `NOT STARTED` | Scheduled for Phase 20 |
| P20-03 | Backup & restore drill, `DEPLOYMENT.md`, `INTEGRATION_STATUS.md` & release checklist | `NOT STARTED` | Production deploy requires explicit owner approval |
