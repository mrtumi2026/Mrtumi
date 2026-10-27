# SYSTEM ARCHITECTURE SPECIFICATION — Mr. Tumi Grocery & Gift
**Status:** **FINALIZED FOR PHASE 02** (Node.js + Express + EJS Modular Monolith + Production MySQL)  
**Last Updated:** 2026-10-25 (`Asia/Dhaka`)  

---

## 1. Architecture Decision Summary

Based on BestWebHostBD support confirmation (**Node.js supported**, **SSH available**, **MySQL is the only supported database**) and our audit of `/home/user/Mrtumi`:

1. **Application Architecture:** **Retain and harden the existing Node.js + Express + EJS Modular Monolith.**
   - Preserves all 4 existing portals (`Storefront`, `Admin Panel`, `Vendor Portal`, `Reseller Portal`), all `48` server-rendered EJS templates, and all Phase 01 requirements without introducing unnecessary SPA frameworks (React/Next/Vue) or microservices.
   - Keeps memory consumption (~`65–110 MB` RSS) and `node_modules` inode count (~`1,200–1,800` files) well within cPanel/CloudLinux LVE quotas.
2. **Production Database:** **MySQL (`InnoDB`, `utf8mb4` / `utf8mb4_unicode_ci`)** via the pure-JavaScript **`mysql2/promise`** driver.
   - **SQLite is strictly prohibited in production.**
   - Existing prototype SQLite files (`src/db/database.js`, `data/pholbazar.db`) are preserved non-destructively during Phase 02 and replaced at the runtime boundary in Phase 03 per [`docs/MYSQL_MIGRATION_PLAN.md`](MYSQL_MIGRATION_PLAN.md).

---

## 2. Core Technical Specifications (13 Architectural Pillars)

### 2.1 Supported Node.js Runtime Requirement
- **Current repository contract:** `package.json` declares **Node.js `>=22.5.0`**. The production host must use a maintained runtime meeting this contract, verified on the actual process-manager binary; do not infer Node 18/20 compatibility from the MySQL driver alone.
- **Compatibility change gate:** Node 18/20 may only be considered after a deliberate update to `engines`, audit of runtime APIs/dependencies (including the local SQLite adapter), and exact-runtime CI/staging tests. The installed sandbox runtime is not proof of host availability. See `U-01` in `docs/CPANEL_COMPATIBILITY.md`.

### 2.2 MySQL Version & Required Engine Features
- **Server Version Status:** Exact BestWebHostBD MySQL/MariaDB version is currently `UNVERIFIED` (`U-02`).
- **Required Baseline Features:**
  - Storage engine: **`InnoDB`** (mandatory for ACID transactions, row-level locking `SELECT ... FOR UPDATE`, and foreign-key enforcement).
  - Character set & collation: **`utf8mb4` / `utf8mb4_unicode_ci`** (mandatory for full Bangla Unicode script, `৳` symbol, and emojis without 3-byte `utf8` truncation).
  - SQL Mode: `STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`.
- **Compatibility Guardrail:** All Phase 03+ migrations avoid MySQL-8.0.16-only or MariaDB-only syntax (no expression column defaults like `DEFAULT (CURRENT_DATE)`, no reliance on `CHECK` constraints for business safety without server-side validation, and `LONGTEXT` with application JSON validation rather than version-fragile `JSON` column defaults), guaranteeing compatibility across **MySQL 5.7+, MySQL 8.0+, and MariaDB 10.3+**.

### 2.3 Database Connection & Pooling Strategy
- Managed via a singleton **`mysql2/promise` pool** (`src/db/mysqlPool.js` in Phase 03):
  - `connectionLimit`: Default `10` (configurable via `DB_CONNECTION_LIMIT`, sized conservatively for shared cPanel `max_user_connections` limits of `20–50`).
  - `waitForConnections: true`, `queueLimit: 50`, `connectTimeout: 10000`, `enableKeepAlive: true`.
  - `timezone: '+00:00'` (stores UTC `DATETIME` consistently; formatted to `Asia/Dhaka` at presentation boundary).
  - `supportBigNumbers: true`, `bigNumberStrings: false` (safe integer handling up to JS `Number.MAX_SAFE_INTEGER` `9,007,199,254,740,991` paisa ≈ `৳90 trillion`, or `BigInt` where needed).
  - Graceful `SIGTERM`/`SIGINT` pool shutdown hook (`pool.end()`).

### 2.4 Versioned, Reversible Schema Migrations
- Stored in `src/db/migrations/` as sequential pairs (`0001_initial_core.up.sql` / `0001_initial_core.down.sql`, etc.).
- Tracked in MySQL table `schema_migrations` (`version VARCHAR(64) PRIMARY KEY`, `name VARCHAR(255)`, `checksum CHAR(64)`, `applied_at DATETIME`, `execution_ms INT UNSIGNED`).
- Executed via CLI (`npm run migrate:up`, `npm run migrate:down`, `npm run migrate:status`) over SSH before restarting the Passenger Node process. Checksum verification blocks accidental editing of already-applied migrations.

### 2.5 Transaction Strategy (Orders, Stock, Payments, Refunds & Settlements)
- Every multi-table state transition executes inside an explicit helper `withTransaction(async (tx) => { ... })`:
  1. Acquires a dedicated connection (`conn = await pool.getConnection()`).
  2. Executes `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` (or default `REPEATABLE READ`) + `START TRANSACTION`.
  3. Acquires deterministic row locks (`SELECT ... FROM products WHERE id IN (...) ORDER BY id ASC FOR UPDATE`) to eliminate overselling and AB-BA deadlocks across concurrent Storefront, POS, Landing Page, and Reseller checkouts.
  4. Writes immutable ledger rows (`stock_ledger`, `order_payments`, `fund_transactions`, `reseller_transactions`, `vendor_ledger`, `audit_logs`) in the **same transaction** as cached balance/stock updates.
  5. Commits atomically (`COMMIT`) or rolls back completely (`ROLLBACK`) on any error, always releasing `conn` in `finally`.

### 2.6 Integer Minor-Unit Money Representation (`BDT` / `Paisa`)
- **Zero floating-point (`FLOAT`/`DOUBLE`/`REAL`) monetary columns.**
- All monetary values (prices, costs, shipping fees, coupon discounts, advance payments, COD balances, wallet balances, salaries, expenses, fund balances) are stored in MySQL as **`BIGINT` in minor units (`paisa`, where `৳1.00 = 100 paisa`)**.
- Server-side `Money` utility (`src/utils/money.js` in Phase 03) handles `bdtToPaisa()`, `paisaToBdtString()`, deterministic half-up integer percentage calculation (`Math.round((amountPaisa * rateBps) / 10000)`), and strict invariant checks (`subtotal_paisa - discount_paisa + shipping_paisa === total_paisa` and `advance_paid_paisa + cod_due_paisa === total_paisa`).

### 2.7 Authentication & Granular Role-Based Authorization (RBAC)
- **Four Strictly Isolated Session Scopes:**
  1. `Staff / Admin` (`users` + `roles` + `role_permissions` + `permissions`)
  2. `Customer` (`customers`)
  3. `Vendor` (`vendors` — isolated strictly to `vendor_id = req.vendor.id` queries)
  4. `Reseller` (`resellers` — isolated strictly to `reseller_id = req.reseller.id` queries)
- **Password Security:** `bcryptjs` (cost factor `12` in production), password-reset tokens stored as `SHA-256` hashes with short TTL (`15–30 min`), session regeneration on privilege change/login.
- **Server-Side RBAC Middleware (`requirePermission('orders.edit')`):** Enforced on **every** controller/route handler—never just hiding sidebar links. Every sensitive action records an immutable row in `audit_logs` (`actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `before_json`, `after_json`, `ip_address`, `user_agent`, `created_at`).

### 2.8 External Provider Adapter Architecture
- Located under `src/integrations/{couriers,payments,fraud,sms,pixels}/`.
- Common contract per domain:
  - `Couriers` (`SteadfastAdapter`, `PathaoAdapter`, `RedXAdapter`): `getStatus()`, `createShipment()`, `getTrackingStatus()`, `verifyWebhook()`, `parseSettlement()`.
  - `Payments` (`BkashAdapter`, `ShurjoPayAdapter`, `UddoktaPayAdapter`, `ManualPaymentAdapter`, `CodAdapter`): `initiatePayment()`, `verifyCallbackServerToServer()`, `processRefund()`.
  - `Fraud` (`BdCourierAdapter`): `checkPhoneHistory()` with cached TTL & graceful fallback to manual-review queue if provider times out.
  - `SMS` (`BulkSmsBdAdapter`): `sendSms()`, `getBalance()` backed by `notification_queue` retry table.
- When credentials are unconfigured, adapters return typed `{ state: 'NOT_CONFIGURED' }` results—never fabricated live tracking IDs or fake payment approvals.

### 2.9 Logging, Validation, CSRF, Rate Limiting & Error Handling
- **Validation:** Schema-driven server-side input sanitizer/validator on all `POST`/`PUT`/`PATCH`/`DELETE` and query filters; parameterized SQL placeholders (`?`) exclusively.
- **CSRF Protection:** Synchronizer token (`_csrf` hidden input / `X-CSRF-Token` header) on all browser session state-changing routes; HMAC signature verification on incoming courier/payment webhooks.
- **Rate Limiting:** MySQL/memory-backed sliding-window limiters on `/admin/login`, `/customer/login`, `/vendor/login`, `/reseller/login`, `/checkout`, OTP send/verify, and fraud check—aware of Bangladesh mobile carrier CGNAT (`ADR-007`).
- **Logging:** Structured JSON/line logger redacting `password`, `token`, `secret`, `authorization`, `cookie`, and masking phone numbers (`017****78`) in logs.

### 2.10 File Upload & Persistent Storage Strategy
- Validated via `multer` + magic-byte signature inspection (`JPEG`, `PNG`, `WEBP`, `GIF` only; executable `.php`, `.js`, `.html`, `.svg` user uploads rejected; random UUID/timestamp filenames preventing path traversal).
- Stored in `env.uploadDir`: defaults to `./public/uploads` locally and points to `/home/<cpanel_user>/mrtumi_storage/uploads` (outside Git release directory, symlinked to `public/uploads/custom`) on BestWebHostBD so uploaded product/banner images survive every Git deployment.

### 2.11 Scheduled Jobs & Background Tasks (cPanel-Compatible)
- Some cPanel Passenger environments may suspend idle Node.js processes; production background work must not rely solely on `setInterval()`.
- **Implementation status:** this checkout has a one-shot reservation-expiry CLI (`npm run reservations:expire`) with a dry-run default and explicit apply flag. It is not a general queue processor or scheduler and has not been scheduled in production. `scripts/cron-runner.js`, `scripts/backup.sh`, a MySQL `GET_LOCK('mrtumi_cron', 0)` mutex, and persistent worker queues for OTP cleanup, incomplete-checkout sweeps, SMS dispatch/retry or courier polling are not implemented. Do not configure commands that are absent. Any future scheduler/queue/backup tooling requires its own design, MySQL 8.0 tests, verified host capability and owner approval.

### 2.12 Local Development, Test & Production Configuration (`src/config/env.js`)
- **`development`:** Reads local untracked `.env`; supports local MySQL (`DB_CLIENT=mysql`) or local sandbox preview (`DB_CLIENT=sqlite` during transition before Phase 03 cutover).
- **`test`:** Isolated test database (`mrtumi_test` on MySQL in CI/staging, plus fast ephemeral harness where applicable); deterministic seeds; zero external network calls.
- **`production`:** Enforces `DB_CLIENT=mysql`, mandatory `>=32`-char `SESSION_SECRET` & `CSRF_SECRET`, `SEED_DEMO_DATA=false`, secure `HttpOnly` cookies over HTTPS (`TRUST_PROXY=1`), and disabled stack traces in HTTP error responses.

### 2.13 GitHub-Based Deployment Workflow (SSH + cPanel)
1. Develop & test on `arena/8689c974-mrtumi` → verify GitHub Actions CI passes (`npm run lint && npm test`).
2. Merge owner-approved release PR to `main` (only when authorized in Phase 20).
3. On BestWebHostBD via SSH (never deploying directly inside `public_html`):
   ```bash
   cd ~/mrtumi_app
   bash scripts/backup-mysql.sh          # Pre-deploy MySQL snapshot
   git fetch origin && git checkout <approved-tag-or-commit>
   source ~/nodevenv/mrtumi_app/<node_ver>/bin/activate
   npm ci --omit=dev --no-audit --no-fund
   npm run migrate:up                    # Apply versioned MySQL migrations
   mkdir -p tmp && touch tmp/restart.txt # Graceful Phusion Passenger / lsnode reload
   ```
