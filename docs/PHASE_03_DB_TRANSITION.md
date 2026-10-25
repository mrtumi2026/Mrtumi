# PHASE 03 — DATABASE, BACKEND & API FOUNDATION: STAGED SQLITE-TO-MYSQL TRANSITION

**Project:** Mr. Tumi Grocery & Gift  
**Phase:** `PHASE 03 — DATABASE, BACKEND AND API FOUNDATION`  
**Date:** `2026-10-25` (`Asia/Dhaka`)  
**Production Target:** BestWebHostBD (Node.js + SSH + **MySQL ONLY** — SQLite strictly prohibited in production)

---

## 1. Executive Summary & Honesty Statement

Phase 03 establishes the production-grade MySQL (`mysql2/promise`), versioned migration (`0001`–`0003`, `71` `InnoDB` `utf8mb4_unicode_ci` tables), integer minor-unit (`paisa`) money math, idempotency, RBAC/CSRF/rate-limit middleware, PII-redacting structured logger, health readiness endpoint (`/health`), and async repository foundation.

**Explicit Staged Transition Status:**
- **Phase 03 has NOT migrated the entire 4-portal prototype away from SQLite yet.**
- Only the **Phase 03-scoped core infrastructure callers** (`server.js`, `src/middleware/sessionManager.js`, `src/middleware/auth.js`, `src/routes/adminAuth.js`, and `src/routes/apiFoundation.js`) have been converted to the async repository layer (`src/repositories/*`).
- The **8 portal feature route files** (`439` `db.*` call sites) still call the non-production local SQLite bridge (`src/db/database.js`) when `DB_CLIENT=sqlite` and are scheduled for conversion in their respective approved feature phases (**Phases 05–18**).
- If any un-migrated route calls `src/db/database.js` while `DB_CLIENT=mysql` or `NODE_ENV=production`, `assertSqliteAllowed()` immediately throws `503 SQLITE_CALLER_NOT_MIGRATED` / `SQLITE_PROHIBITED_IN_PRODUCTION` — guaranteeing SQLite can never run accidentally in production.
- Local SQLite data files (`data/pholbazar.db`, `pholbazar.db-wal`, `pholbazar.db-shm`) remain **100% untouched and untracked**. No customer data has been copied externally, and no migrations have been run against any production server.

---

## 2. Complete Database Caller Inventory (Before vs. After Phase 03)

### 2.1 Callers Migrated in Phase 03 (`19` legacy `db.*` calls replaced by async repositories)

| File | Pre-Phase-03 `db.*` Calls | Post-Phase-03 Direct `db.*` Calls | Phase 03 Replacement |
|---|---:|---:|---|
| `src/middleware/sessionManager.js` | `6` (`exec:1, get:1, run:4`) | **`0`** | Async `src/repositories/sessionRepository.js` (`web_sessions` on MySQL `InnoDB` or non-prod SQLite fallback) |
| `src/middleware/auth.js` | `10` (`getSettings:1, all:5, get:4`) | **`0`** | Async `src/repositories/settingsRepository.js` + `src/repositories/authRepository.js` + `src/middleware/rbac.js` |
| `src/routes/adminAuth.js` | `1` (`get:1`) | **`0`** | Async `authRepository.findActiveAdminByEmail` + `auditLogRepository.recordAuditLog` + CGNAT-safe `createRateLimiter` |
| `server.js` | `2` (`initializeDatabase:1, run:1`) | **`1` (guarded boot only)** | Error logging moved to `auditLogRepository.recordErrorLog`; `db.initializeDatabase()` runs ONLY when `!env.isProduction && env.db.client === 'sqlite'` |
| `src/routes/apiFoundation.js` | *(new)* | **`0` direct** | `/health`, `/api/v1/health`, `/api/v1/csrf-token` backed by `pingPool()` on MySQL |

### 2.2 Remaining Un-Migrated SQLite Callers (`439` `db.*` calls across `8` portal route files)

Every un-migrated file below is explicitly tracked and scheduled for repository conversion in its designated feature phase:

| Un-Migrated Route File | `db.*` Call Count | Method Breakdown | Scheduled Conversion Phases | Domain Operations Covered |
|---|---:|---|---|---|
| `src/routes/storefront.js` | `72` | `get:24, all:23, run:22, getSettings:3` | **Phases 05, 07, 08, 15, 16** | Storefront home, category/product browse, cart, 3-step checkout, order tracking, campaigns, reviews, customer account |
| `src/routes/adminCatalog.js` | `44` | `all:19, run:22, get:3` | **Phases 06 & 15** | Categories, subcategories, childcategories, brands, attributes, products, stock & purchase CRUD |
| `src/routes/adminOrders.js` | `74` | `run:37, all:22, get:15` | **Phases 08, 10, 11, 17** | Order pipeline, status transitions, POS checkout, courier booking, invoice/label generation, refunds |
| `src/routes/adminDashboard.js` | `38` | `get:25, all:9, getSettings:3, run:1` | **Phases 09 & 18** | KPI cards, revenue/order summaries, source breakdown, operational alerts |
| `src/routes/adminSettings.js` | `52` | `run:19, all:16, get:11, setSetting:4, getSettings:2` | **Phases 09, 10, 11, 13, 14, 18** | General settings, shipping zones, OTP/advance toggles, courier/gateway/SMS/pixel credentials, roles & staff users |
| `src/routes/adminOperations.js` | `96` | `run:58, all:35, get:3` | **Phases 12, 15, 16, 17, 18** | Campaigns, banners, coupons, blogs, CMS pages, fraud checks, IP blocks, vendor/reseller payouts, HRM & expenses |
| `src/routes/vendorPanel.js` | `34` | `get:16, all:9, run:9` | **Phase 16** | Vendor registration/login, separate vendor product/stock submission, admin approval workflow, commissions & withdrawals |
| `src/routes/resellerPanel.js` | `29` | `get:11, run:9, all:7, getSettings:2` | **Phase 16** | Reseller registration/login, warehouse-backed reseller orders, margin ledger & withdrawal requests |
| **Total Remaining** | **`439`** | **`8` route files** | **Phases 05–18** | Converted module-by-module with ACID repository tests |

---

## 3. MySQL Foundation Architecture Delivered in Phase 03

1. **Locked Driver & Async Pool (`src/db/mysqlPool.js`):**
   - `mysql2/promise` (`mysql2@^3.24.6`, `0` npm audit vulnerabilities, pure JS — zero C++ `node-gyp` build issues on CloudLinux cPanel).
   - Enforces `STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`, `charset: 'utf8mb4'`, `timezone: '+00:00'` (UTC storage; `Asia/Dhaka` display formatting).
   - Parameterized query wrappers (`queryAll`, `queryOne`, `execute`), sanitized error mapping (`DB_DUPLICATE_ENTRY`, `DB_FOREIGN_KEY_CONSTRAINT`, `DB_CONNECTION_FAILED`), `withTransaction` auto-commit/auto-rollback, and deterministic ascending `lockRowsById` (`SELECT ... FOR UPDATE`) to prevent AB-BA deadlocks.
2. **Versioned Reversible Migrations (`src/db/migrator.js`, `scripts/migrate.js`, `src/db/migrations/`):**
   - `schema_migrations` tracking version, name, SHA-256 checksum, execution duration, and timestamp.
   - MySQL advisory lock (`GET_LOCK('mrtumi_schema_migration', 15)`) preventing concurrent migration races, guaranteed to release in `finally`.
   - Strict checksum tamper detection (`MIGRATION_CHECKSUM_MISMATCH`), out-of-order detection (`OUT_OF_ORDER_MIGRATION`), paired `.down.sql` enforcement, and `CONFIRM_PRODUCTION_MIGRATION=true` CLI safety guard.
   - **Migration `0001_core_security_and_sessions` (`11` tables):** `roles`, `permissions`, `role_permissions`, `users`, `settings`, `web_sessions`, `audit_logs`, `idempotency_keys`, `rate_limits`, `ip_blocks`, `error_logs`.
   - **Migration `0002_catalog_inventory_and_partners` (`18` tables):** `categories`, `subcategories`, `childcategories`, `brands`, `colors`, `sizes`, `vendors`, `vendor_withdrawals`, `resellers`, `reseller_transactions`, `products`, `product_variants`, `suppliers`, `purchases`, `purchase_items`, `stock_ledger`, `stock_reservations`, `wholesale_applications`.
   - **Migration `0003_orders_payments_and_operations` (`42` tables):** `customers`, `customer_addresses`, `password_resets`, `delivery_locations`, `delivery_boys`, `delivery_withdrawals`, `coupons`, `order_statuses`, `orders`, `order_items`, `order_status_history`, `order_otps`, `payment_gateways`, `order_payments`, `refunds`, `incomplete_orders`, `courier_apis`, `courier_shipments`, `courier_webhook_logs`, `fraud_checks`, `campaigns`, `banners`, `reviews`, `blogs`, `cms_pages`, `features`, `social_links`, `complaints`, `contact_messages`, `newsletter_subscribers`, `sms_logs`, `notification_queue`, `visitor_events`, `pos_shifts`, `hrm_departments`, `employees`, `attendances`, `leaves`, `salaries`, `bonuses`, `fund_transactions`, `expenses`.
3. **Money Integrity (`src/utils/money.js`):**
   - All MySQL monetary columns use `BIGINT` integer minor units (`*_paisa`, `1 BDT = 100 paisa`).
   - Eliminates IEEE-754 floating-point drift across prices, discounts, shipping, delivery advance, COD due, vendor commissions (`commission_rate_bps`), reseller margins, POS shifts, and HRM payroll.
4. **Concurrency & Duplicate Protection (`src/repositories/idempotencyRepository.js`, `inventoryFoundationRepository.js`):**
   - `executeIdempotent`: Unique `(scope, idem_key)` + SHA-256 request payload hash + `SELECT ... FOR UPDATE` inside `withTransaction`.
   - `adjustProductStockAtomically`: Separate row-locked warehouse (`stock_on_hand`) vs vendor (`vendor_stock_on_hand`) stock pools + immutable `stock_ledger` entries.
