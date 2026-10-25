# PROJECT STATUS — Mr. Tumi Grocery & Gift

**Last Updated:** 2026-10-25 (`Asia/Dhaka`)  
**Repository:** `mrtumi2026/Mrtumi` (Working Branch: `arena/8689c974-mrtumi`)  
**Hosting Provider:** BestWebHostBD (`Node.js` + `SSH` + `MySQL-only` confirmed by owner via support; exact runtime/DB versions `UNVERIFIED` — see `docs/CPANEL_COMPATIBILITY.md`)  
**Current Completed Phase:** **PHASE 03 — DATABASE, BACKEND AND API FOUNDATION**  
**Gate Status:** `OWNER APPROVAL REQUIRED` — Waiting for explicit owner approval before starting **Phase 04**  

---

## 20-Phase Master Execution Tracker

| Phase | Title | Status | Gate / Blocker |
|---|---|---|---|
| **Phase 01** | Reference Audit and Requirements | `TESTED AND PASSED` | Complete (`3611777`) |
| **Phase 02** | Architecture, GitHub and Development Foundation | `TESTED AND PASSED` | Complete (`04c69bc`) |
| **Phase 03** | Database, Backend and API Foundation | `TESTED AND PASSED` | **Complete.** `mysql2/promise` pool, reversible migrations `0001`–`0003` (`71` `InnoDB` `utf8mb4` tables), `paisa` money math, `FOR UPDATE` transactions, idempotency, RBAC/CSRF/rate-limit, PII logger, `/health`, Phase 03 async repositories & live `mysql:8.0` CI verified; waiting for explicit owner sign-off (`OWNER APPROVAL REQUIRED`) before Phase 04 |
| **Phase 04** | Branding, Design System and Bilingual UI | `NOT STARTED` | Depends on Phase 03 owner approval (`bn` default + `en` toggle approved) |
| **Phase 05** | Customer Storefront | `NOT STARTED` | Depends on Phase 03–04 |
| **Phase 06** | Products, Inventory, Purchases and Suppliers | `NOT STARTED` | Depends on Phase 03 (`warehouse` vs `vendor` stock rules approved) |
| **Phase 07** | Customer Accounts, Cart and Checkout | `NOT STARTED` | Depends on Phase 05–06 |
| **Phase 08** | Order Management, Incomplete Orders, OTP and Advance Payment | `NOT STARTED` | Depends on Phase 07 (configurable OTP & advance payment approved) |
| **Phase 09** | Admin Dashboard, Users and Permissions | `NOT STARTED` | Depends on Phase 03, 06, 08 |
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

## Summary of Finalized Phase 03 Deliverables & Staged Transition Honesty

1. **MySQL Pool, Transactions & Checksum-Verified Migrations (`src/db/mysqlPool.js`, `src/db/migrator.js`, `scripts/migrate.js`, `src/db/migrations/0001..0003`):** `71` `InnoDB` `utf8mb4_unicode_ci` tables, `GET_LOCK` migration locking, SHA-256 checksum integrity, reverse-FK `down` rollbacks, `FOR UPDATE` row locking, and `CONFIRM_PRODUCTION_MIGRATION=true` CLI guard.
2. **Backend Utilities & Security Middleware (`src/utils/*`, `src/middleware/{csrf,rateLimit,rbac,errorHandler}.js`, `src/routes/apiFoundation.js`):** Integer `paisa` (`1 BDT = 100 paisa`) arithmetic, PII/secret-redacting logger, CGNAT-safe rate limiting, synchronizer/HMAC CSRF protection, server-side RBAC, standardized JSON error/response envelopes, and `/health` readiness endpoint.
3. **Staged SQLite-to-MySQL Transition (`docs/PHASE_03_DB_TRANSITION.md`):**
   - **Migrated in Phase 03:** `sessionManager.js`, `auth.js`, `adminAuth.js`, `server.js` error logging, and `apiFoundation.js` (`19` infrastructure `db.*` calls replaced by `src/repositories/*`), plus `idempotencyRepository.js` and `inventoryFoundationRepository.js`.
   - **Not Yet Migrated (Scheduled Phases 05–18):** `8` portal route files (`storefront.js`, `adminCatalog.js`, `adminOrders.js`, `adminDashboard.js`, `adminSettings.js`, `adminOperations.js`, `vendorPanel.js`, `resellerPanel.js` — `439` `db.*` calls) remain on the non-production local SQLite bridge while `assertSqliteAllowed()` blocks SQLite in production or when `DB_CLIENT=mysql`.
   - **Data Preservation:** Local `data/pholbazar.db*` files remain untouched and untracked.
