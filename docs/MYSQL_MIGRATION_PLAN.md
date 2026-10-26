# SQLITE TO MYSQL MIGRATION & SCHEMA ARCHITECTURE PLAN
**Project:** Mr. Tumi Grocery & Gift  
**Target Production Engine:** **MySQL (`InnoDB`, `utf8mb4_unicode_ci`)** on BestWebHostBD  
**Plan Status:** **IMPLEMENTED FOUNDATION + STAGED FEATURE MIGRATION — see Phase 06 `0004` additive migration and current SQLite caller map**
**Non-Destructive Guarantee:** Existing prototype files (`src/db/database.js`, `data/pholbazar.db`) are **preserved untouched** in Phase 02. No destructive migration or production database change has been executed.

---

## 0. Codebase SQL Compatibility Audit (Current Baseline Findings)

A static scan of `/home/user/Mrtumi/src/` identified **50 existing SQLite tables** (`49` in `src/db/database.js` + `web_sessions` in `src/middleware/sessionManager.js`) and the following SQLite-specific constructs that Phase 03 must replace cleanly:

| SQLite Construct Found in `src/` | Count & Locations | Why Incompatible / Risky in MySQL | Phase 03 MySQL Replacement |
|---|---|---|---|
| **Synchronous `node:sqlite` (`DatabaseSync`)** | `db.get`, `db.all`, `db.run`, `db.exec` across all `9` routers + `2` middlewares | `mysql2/promise` is asynchronous (`Promise`-based); Node `18`/`20` lacks `node:sqlite` | Async repository/query layer (`await db.queryOne()`, `await db.queryAll()`, `await db.execute()`, `await db.withTransaction()`) + Express `asyncHandler()` wrapper |
| **`PRAGMA journal_mode / foreign_keys / busy_timeout`** | `3` in `src/db/database.js` | SQLite-only pragmas | `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` + session `sql_mode` & `time_zone='+00:00'` |
| **`INTEGER PRIMARY KEY AUTOINCREMENT`** | `48` tables in `src/db/database.js` | Invalid MySQL syntax (`AUTOINCREMENT` vs `AUTO_INCREMENT`) | `id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| **`REAL` Floating-Point Money Columns** | `39` columns across `21` tables (`products`, `orders`, `vendors`, `resellers`, `salaries`, `expenses`, etc.) | IEEE-754 float rounding errors corrupt BDT discounts, commissions, and ledger reconciliations | **`BIGINT` storing integer `paisa` (`৳1.00 = 100 paisa`)**; percentages stored as `INT UNSIGNED` basis points (`1000 = 10.00%`) |
| **`DEFAULT (datetime('now', 'localtime'))`** | `33` columns in `database.js` + `2` in `sessionManager.js` | SQLite function syntax | `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` (UTC in DB; formatted to `Asia/Dhaka` in app) |
| **`DEFAULT (date('now', 'localtime'))`** | `5` columns (`purchase_date`, `paid_at`, `bonus_date`, `tx_date`, `expense_date`) | `DEFAULT (CURRENT_DATE)` requires MySQL `>= 8.0.13` and **fails on MySQL 5.7 / older MariaDB** | `DATE NOT NULL` populated explicitly by server helper `currentDhakaDateString()` (`YYYY-MM-DD`) |
| **`ON CONFLICT(...) DO UPDATE SET ... = excluded.*`** | `2` (`database.js:643` `settings`, `sessionManager.js:125` `web_sessions`) | PostgreSQL/SQLite upsert syntax | `INSERT INTO ... VALUES (...) ON DUPLICATE KEY UPDATE col = VALUES(col)` |
| **`INSERT OR IGNORE INTO ...`** | `1` (`sessionManager.js:86` `web_sessions`) | SQLite conflict clause | `INSERT IGNORE INTO ...` |
| **`result.lastInsertRowid`** | `10` occurrences (`database.js`, `adminOrders.js`, `resellerPanel.js`, `storefront.js`, `vendorPanel.js`) | `mysql2` returns `[ResultSetHeader]` with `.insertId` | Unified `{ insertId: Number(res.insertId), affectedRows: res.affectedRows }` return contract |
| **Unversioned `try { exec('ALTER TABLE ...') }`** | `4` occurrences (`database.js:596-605`) | Silent error swallowing, untraceable schema state | Tracked, checksum-verified `schema_migrations` SQL files |
| **Reserved Word Column ``settings.key``** | `1` (`settings(key, value)`) | `KEY` is a reserved keyword in MySQL DDL/DML | Rename to `setting_key VARCHAR(128) PRIMARY KEY`, `setting_value LONGTEXT` (mapped transparently in `getSettings()`/`setSetting()`) |

---

## 1. Schema Mapping & Version-Portable MySQL DDL

### 1.1 MySQL Version Portability Rules (`MySQL 5.7+` / `MySQL 8.0+` / `MariaDB 10.3+`)
Because BestWebHostBD's exact MySQL/MariaDB server version is currently `UNVERIFIED`:
1. Every table explicitly declares `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.
2. Indexed `VARCHAR` columns are capped at **`VARCHAR(191)`** where unique/composite indexes could ever encounter older `InnoDB` 767-byte key-prefix configurations, or `VARCHAR(255)` on standard modern `innodb_large_prefix=ON` setups (using `191` on `email`, `slug`, `code`, `invoice_id`, `sid`, `setting_key` guarantees 100% compatibility on **every** MySQL 5.7/8.0 and MariaDB 10.x installation!).
3. `LONGTEXT` is used for JSON payloads (`permissions_json`, `gallery_json`, `before_json`, `after_json`) with strict server-side `JSON.parse`/`JSON.stringify` validation, avoiding MySQL 5.7 vs MariaDB `JSON` column type discrepancies.
4. No MySQL-8.0.13+ expression defaults or MySQL-8.0.16+ `CHECK` constraints are required for correctness; invariants are enforced by server validators + transactions.

### 1.2 Complete Inventory Mapping (50 Existing Tables + Phase 03–18 Mandatory Additions)

| Domain | Existing SQLite Tables Mapped (`50`) | New Mandatory Master Plan Tables Added Across Phases 03–18 |
|---|---|---|
| **Core & Security** | `users`, `roles`, `permissions`, `settings`, `web_sessions`, `error_logs`, `ip_blocks` | `schema_migrations`, `role_permissions`, `audit_logs`, `idempotency_keys`, `rate_limits` |
| **Catalogue & Inventory** | `categories`, `subcategories`, `childcategories`, `brands`, `colors`, `sizes`, `products`, `suppliers`, `purchases`, `reviews` | `product_variants`, `stock_ledger`, `stock_reservations`, `purchase_items` |
| **Customers & Checkout** | `customers`, `incomplete_orders`, `coupons`, `delivery_locations` | `customer_addresses`, `password_resets`, `carts`, `cart_items` |
| **Orders & Payments** | `order_statuses`, `orders`, `order_items`, `refunds`, `payment_gateways` | `order_status_history`, `order_otps`, `order_payments` |
| **Couriers & Fraud** | `courier_apis`, `delivery_boys`, `delivery_withdrawals` | `courier_shipments`, `courier_webhook_logs`, `fraud_checks` |
| **Partners (B2B/Vendor/Reseller)** | `vendors`, `vendor_withdrawals`, `resellers`, `reseller_transactions` | `wholesale_applications`, `wholesale_tiers`, `vendor_ledger` |
| **Marketing, CMS & SMS** | `campaigns`, `banners`, `blogs`, `cms_pages`, `features`, `social_links`, `sms_logs`, `newsletter_subscribers` | `campaign_products` (multi-product landing pages), `notification_queue`, `visitor_events` |
| **POS, CRM, HRM & Finance** | `complaints`, `contact_messages`, `employees`, `attendances`, `leaves`, `salaries`, `bonuses`, `fund_transactions`, `expenses` | `pos_shifts`, `customer_notes`, `hrm_departments`, `employee_documents`, `fund_accounts`, `expense_categories` |

### 1.3 Representative Core MySQL DDL (Phase 03 Initial Migration Excerpt)

```sql
-- Migration Tracking Table
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version` VARCHAR(64) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `checksum` CHAR(64) NOT NULL,
  `execution_ms` INT UNSIGNED NOT NULL DEFAULT 0,
  `applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Products (All prices in integer paisa: 1 BDT = 100 paisa)
CREATE TABLE IF NOT EXISTS `products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sku` VARCHAR(64) NOT NULL,
  `barcode` VARCHAR(64) DEFAULT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `name_bn` VARCHAR(255) NOT NULL,
  `name_en` VARCHAR(255) NOT NULL DEFAULT '',
  `category_id` BIGINT UNSIGNED DEFAULT NULL,
  `subcategory_id` BIGINT UNSIGNED DEFAULT NULL,
  `childcategory_id` BIGINT UNSIGNED DEFAULT NULL,
  `brand_id` BIGINT UNSIGNED DEFAULT NULL,
  `vendor_id` BIGINT UNSIGNED DEFAULT NULL,
  `regular_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `sale_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `cost_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `wholesale_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `wholesale_min_qty` INT UNSIGNED NOT NULL DEFAULT 10,
  `stock_on_hand` INT NOT NULL DEFAULT 0,
  `stock_reserved` INT NOT NULL DEFAULT 0,
  `low_stock_threshold` INT UNSIGNED NOT NULL DEFAULT 10,
  `sold_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `unit_label` VARCHAR(50) NOT NULL DEFAULT '1 pc',
  `image_url` VARCHAR(500) NOT NULL DEFAULT '',
  `gallery_json` LONGTEXT DEFAULT NULL,
  `short_desc_bn` TEXT DEFAULT NULL,
  `short_desc_en` TEXT DEFAULT NULL,
  `description_bn` LONGTEXT DEFAULT NULL,
  `description_en` LONGTEXT DEFAULT NULL,
  `is_flash_sale` TINYINT(1) NOT NULL DEFAULT 0,
  `is_hot_deal` TINYINT(1) NOT NULL DEFAULT 0,
  `is_wholesale` TINYINT(1) NOT NULL DEFAULT 0,
  `is_gift_eligible` TINYINT(1) NOT NULL DEFAULT 0,
  `approval_status` VARCHAR(32) NOT NULL DEFAULT 'approved',
  `is_archived` TINYINT(1) NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_products_sku` (`sku`),
  UNIQUE KEY `uq_products_slug` (`slug`),
  KEY `idx_products_barcode` (`barcode`),
  KEY `idx_products_category_status` (`category_id`, `status`, `is_archived`),
  KEY `idx_products_vendor_approval` (`vendor_id`, `approval_status`),
  CONSTRAINT `fk_products_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable Stock Ledger (Warehouse vs Vendor Stock Ownership)
CREATE TABLE IF NOT EXISTS `stock_ledger` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `variant_id` BIGINT UNSIGNED DEFAULT NULL,
  `stock_Pool` VARCHAR(24) NOT NULL DEFAULT 'warehouse', -- 'warehouse' | 'vendor'
  `vendor_id` BIGINT UNSIGNED DEFAULT NULL,
  `movement_type` VARCHAR(40) NOT NULL, -- 'purchase_receive','order_reserve','order_deduct','order_release','return_restock','pos_sale','manual_adjust','damage_writeoff'
  `qty_delta` INT NOT NULL,
  `balance_after` INT NOT NULL,
  `reference_type` VARCHAR(40) DEFAULT NULL,
  `reference_id` BIGINT UNSIGNED DEFAULT NULL,
  `reason` VARCHAR(255) NOT NULL DEFAULT '',
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_stock_ledger_product_created` (`product_id`, `created_at`),
  KEY `idx_stock_ledger_ref` (`reference_type`, `reference_id`),
  CONSTRAINT `fk_stock_ledger_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Orders (Supports OTP, Configurable Advance Payment + COD Due Balance, Attribution)
CREATE TABLE IF NOT EXISTS `orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `invoice_no` VARCHAR(40) NOT NULL,
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `customer_id` BIGINT UNSIGNED DEFAULT NULL,
  `reseller_id` BIGINT UNSIGNED DEFAULT NULL,
  `customer_name` VARCHAR(191) NOT NULL,
  `customer_phone` VARCHAR(32) NOT NULL,
  `shipping_address` TEXT NOT NULL,
  `division` VARCHAR(80) DEFAULT '',
  `district` VARCHAR(80) DEFAULT '',
  `upazila` VARCHAR(80) DEFAULT '',
  `shipping_zone` VARCHAR(80) NOT NULL DEFAULT 'Inside Dhaka',
  `subtotal_paisa` BIGINT NOT NULL DEFAULT 0,
  `discount_paisa` BIGINT NOT NULL DEFAULT 0,
  `shipping_paisa` BIGINT NOT NULL DEFAULT 0,
  `total_paisa` BIGINT NOT NULL DEFAULT 0,
  `advance_required_paisa` BIGINT NOT NULL DEFAULT 0,
  `paid_paisa` BIGINT NOT NULL DEFAULT 0,
  `cod_due_paisa` BIGINT NOT NULL DEFAULT 0,
  `reseller_margin_paisa` BIGINT NOT NULL DEFAULT 0,
  `coupon_code` VARCHAR(64) DEFAULT '',
  `payment_method` VARCHAR(40) NOT NULL DEFAULT 'cod',
  `payment_status` VARCHAR(32) NOT NULL DEFAULT 'unpaid', -- 'unpaid','advance_pending','partially_paid','paid','refunded'
  `otp_status` VARCHAR(24) NOT NULL DEFAULT 'not_required', -- 'not_required','pending','verified','expired'
  `order_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `order_channel` VARCHAR(32) NOT NULL DEFAULT 'storefront', -- 'storefront','landing_page','pos','reseller','wholesale'
  `traffic_source` VARCHAR(64) NOT NULL DEFAULT 'Direct',
  `utm_source` VARCHAR(100) DEFAULT '',
  `utm_medium` VARCHAR(100) DEFAULT '',
  `utm_campaign` VARCHAR(150) DEFAULT '',
  `courier_code` VARCHAR(32) DEFAULT '',
  `courier_tracking_id` VARCHAR(100) DEFAULT '',
  `delivery_boy_id` BIGINT UNSIGNED DEFAULT NULL,
  `client_ip` VARCHAR(64) DEFAULT '',
  `customer_note` TEXT DEFAULT NULL,
  `admin_note` TEXT DEFAULT NULL,
  `consent_accepted_at` DATETIME DEFAULT NULL,
  `is_seen` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orders_invoice_no` (`invoice_no`),
  UNIQUE KEY `uq_orders_idempotency` (`idempotency_key`),
  KEY `idx_orders_status_created` (`order_status`, `created_at`),
  KEY `idx_orders_phone_created` (`customer_phone`, `created_at`),
  KEY `idx_orders_customer` (`customer_id`),
  KEY `idx_orders_reseller` (`reseller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 2. Versioned Migration Runner Architecture

1. **File Naming Convention:**
   - `src/db/migrations/0001_core_auth_settings.up.sql`
   - `src/db/migrations/0001_core_auth_settings.down.sql`
   - `src/db/migrations/0002_catalog_inventory_purchases.up.sql`
   - `src/db/migrations/0002_catalog_inventory_purchases.down.sql`
   - *(Incremental migrations added per phase up to Phase 18)*
2. **Concurrency & Integrity Guarantees:**
   - Acquires MySQL advisory lock `SELECT GET_LOCK('mrtumi_schema_migration', 15)` before inspecting `schema_migrations`, preventing race conditions if two SSH/deploy shells run simultaneously.
   - Computes `SHA-256` checksum of each `.up.sql` file; fails fast if an already-applied migration file was altered retroactively.
   - Note on MySQL DDL Implicit Commit: In MySQL, `CREATE TABLE` / `ALTER TABLE` causes an implicit commit. Therefore, each migration file groups cohesive DDL statements cleanly and ensures its `.down.sql` drops/reverts objects in reverse foreign-key dependency order (`DROP TABLE IF EXISTS child; DROP TABLE IF EXISTS parent;`).

---

## 3. Data Types & Money Representation Rules

| Data Category | SQLite Prototype Type | MySQL Production Type | Conversion & Precision Rule |
|---|---|---|---|
| **Primary / Foreign Keys** | `INTEGER` | `BIGINT UNSIGNED` | Auto-increment `1..2^64-1`; exact match required between parent PK and child FK for `InnoDB` constraints |
| **BDT Monetary Amounts** (`39+` columns) | `REAL` (float) | **`BIGINT` (`*_paisa`)** | `1 BDT = 100 paisa` (`৳1,300.50` → `130050`). Zero floating-point representation error |
| **Percentages / Commissions** | `REAL` | `INT UNSIGNED` (`*_bps`) | Basis points (`10% = 1000 bps`, `2.5% = 250 bps`) |
| **Booleans / Flags** | `INTEGER` (`0`/`1`) | `TINYINT(1) NOT NULL` | `0` = false, `1` = true |
| **Timestamps** | `TEXT` (`localtime`) | `DATETIME NOT NULL` | Stored in **UTC** (`+00:00`); formatted to `Asia/Dhaka` (`UTC+06:00`) in UI/exports |
| **Business Calendar Dates** (Attendance, Payroll, Expense, Purchase) | `TEXT` | `DATE NOT NULL` | Stored as `Asia/Dhaka` local calendar date (`YYYY-MM-DD`) |
| **Short Identifiers / Slugs / Phones** | `TEXT` | `VARCHAR(32..191)` | Indexed safely across all `InnoDB` row formats |
| **Rich Descriptions / JSON Snapshots** | `TEXT` | `LONGTEXT` | Full UTF-8 (`utf8mb4`) Bangla + English content |

---

## 4. Foreign Keys, Unique Constraints & Index Strategy

1. **Referential Integrity Rules (`ON DELETE` Policy):**
   - **Financial & Order History (`orders`, `order_items`, `stock_ledger`, `order_payments`, `purchases`, `salaries`):** `ON DELETE RESTRICT` — products, suppliers, vendors, resellers, and employees referenced by historical transactions can **never** be hard-deleted (`is_archived = 1` / `status = 0` soft-deactivation is used instead).
   - **Optional Catalog Taxonomy (`products.brand_id`, `products.category_id`):** `ON DELETE SET NULL`.
   - **Pure Child Records (`customer_addresses`, `cart_items`, `role_permissions`):** `ON DELETE CASCADE`.
2. **Mandatory Unique Constraints:**
   - `users.email`, `customers.phone` (normalized `01XXXXXXXXX`), `vendors.phone`, `resellers.phone`
   - `products.sku`, `products.slug`, `categories.slug`, `blogs.slug`, `cms_pages.slug`, `campaigns.slug`
   - `orders.invoice_no`, `orders.idempotency_key`, `coupons.code`
   - `order_payments(gateway_code, provider_trx_id)` (prevents double-crediting the same bKash/ShurjoPay/UddoktaPay callback!)
   - `courier_shipments(order_id, active_flag)` (prevents duplicate courier booking on double-click!)
3. **High-Traffic Composite Indexes:**
   - `orders(order_status, created_at DESC)` — Admin order tabs & dashboard counts
   - `orders(traffic_source, created_at DESC)` — Dashboard attribution card
   - `products(status, is_archived, is_flash_sale, is_hot_deal)` — Storefront homepage queries
   - `stock_ledger(product_id, created_at DESC)` — Stock movement audit & reconciliation
   - `audit_logs(entity_type, entity_id, created_at DESC)` — Security & compliance review

---

## 5. Transaction-Safe Order & Inventory Execution Sequence

Every order placement (Storefront, Landing Page, POS, Reseller, Wholesale) will execute in a single MySQL `InnoDB` transaction:

1. `START TRANSACTION;`
2. Check `idempotency_keys` (`INSERT INTO idempotency_keys ...`); if duplicate key exists, return cached order result immediately.
3. Sort requested `product_id` (and `variant_id`) ascending and execute:
   `SELECT id, vendor_id, stock_on_hand, stock_reserved, sale_price_paisa, wholesale_price_paisa, approval_status, status FROM products WHERE id IN (...) ORDER BY id ASC FOR UPDATE;`
4. Determine stock pool per Approved Business Rule (`ADR-006`):
   - **In-house & Reseller items:** Validate `warehouse` available stock (`stock_on_hand - stock_reserved >= qty`).
   - **Vendor items:** Validate `approval_status = 'approved'` and separate `vendor` available stock (`>= qty`).
5. Compute line totals, coupon discount, zone shipping fee, `advance_required_paisa`, and `cod_due_paisa` strictly in server-side integer `paisa`.
6. Insert `orders` + `order_items` + `order_status_history`.
7. Update `products` (`stock_reserved` or `stock_on_hand` depending on OTP/payment hold state) and insert matching immutable rows into `stock_ledger`.
8. Insert `audit_logs` / `notification_queue` entries as needed.
9. `COMMIT;` (or `ROLLBACK;` on any validation/stock error).

---

## 6. Data Migration & Validation Strategy (If Prototype Data Is Migrated)

- **Clean Production Start (Recommended Default for Launch):** Production BestWebHostBD MySQL starts cleanly from versioned migrations + Mr. Tumi master settings/roles/permissions/delivery-locations bootstrap (zero demo lychee products or demo orders).
- **Optional Non-Destructive Prototype Data Migration (`scripts/migrate-sqlite-to-mysql.js` in Phase 03):**
  1. Make a read-only copy of `data/pholbazar.db` (`cp data/pholbazar.db backups/pre_migration_sqlite.db`) — **never modify or delete the source SQLite file**.
  2. Apply all MySQL `.up.sql` migrations to an empty target MySQL schema.
  3. Read tables in topological parent-first order (`roles` → `users` → `categories` → `vendors` → `resellers` → `products` → `customers` → `orders` → `order_items` → ...), converting `REAL` BDT columns via `Math.round(Number(value || 0) * 100)` into `*_paisa` `BIGINT` columns and local timestamps to UTC `DATETIME`.
  4. Preserve explicit primary key IDs during import, then set `ALTER TABLE <tbl> AUTO_INCREMENT = <max_id + 1>`.

---

## 7. Backup & Rollback Procedures

### 7.1 Pre-Migration / Pre-Release Backup
```bash
mkdir -p ~/mrtumi_storage/backups
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
mysqldump --single-transaction --quick --routines --triggers \
  --default-character-set=utf8mb4 \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" \
  | gzip -9 > "~/mrtumi_storage/backups/mysql_${DB_NAME}_${TIMESTAMP}.sql.gz"
```

### 7.2 Rollback Procedure
1. **Single-Step Schema Rollback (if latest migration fails validation before live traffic):**
   - Run `npm run migrate:down` to execute the paired `.down.sql` script and remove its row from `schema_migrations`.
2. **Full Snapshot Restore (if data-transforming migration requires full revert):**
   - Put app in maintenance mode → restore the pre-migration `.sql.gz` dump into MySQL (`gunzip < backup.sql.gz | mysql ...`) → checkout previous verified Git commit → `touch tmp/restart.txt`.
3. **Prototype Safety:** Because `data/pholbazar.db` is never deleted in Phase 02 or Phase 03, local fallback inspection remains available until the owner explicitly retires prototype artifacts.

---

## 8. Test Database Setup Strategy (Phase 03 Onward)

1. **GitHub Actions CI (`.github/workflows/ci.yml` in Phase 03):**
   - Adds an official **MySQL `8.0` service container** (`--character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci`) alongside Node 22 so every push/PR runs:
     - `migrate:up` → `migrate:down` → `migrate:up` round-trip verification
     - Transactional stock/order/money reconciliation tests against **real MySQL `InnoDB`**.
2. **Local Sandbox Execution (When Local MySQL Daemon Is Absent):**
   - Because this Cloud/Arena coding sandbox does not have a local `mysqld` binary installed, Phase 03's database adapter will support running unit/integration tests against an isolated test harness while running full MySQL `InnoDB` verification in GitHub Actions CI and BestWebHostBD staging!

---

## 9. Post-Migration Verification Queries (Row Counts & Financial Totals)

Whenever data is migrated between environments or restored from backup, cutover is blocked unless **100% of the following automated assertions pass with zero delta**:

1. **Exact Per-Table Row Count Parity:**
   - Compare `SELECT COUNT(*) FROM <table>` across all migrated tables (`users`, `categories`, `products`, `vendors`, `resellers`, `customers`, `orders`, `order_items`, `purchases`, `expenses`, `fund_transactions`, `salaries`, `refunds`).
2. **Order & Line-Item Financial Reconciliation:**
   - `SUM(orders.subtotal_paisa) == Math.round(SUM_SQLITE(orders.subtotal) * 100)`
   - `SUM(orders.discount_paisa) == Math.round(SUM_SQLITE(orders.discount) * 100)`
   - `SUM(orders.shipping_paisa) == Math.round(SUM_SQLITE(orders.shipping_charge) * 100)`
   - `SUM(orders.total_paisa) == Math.round(SUM_SQLITE(orders.amount) * 100)`
   - Verify row-level equation on all orders: `SELECT COUNT(*) FROM orders WHERE (subtotal_paisa - discount_paisa + shipping_paisa) <> total_paisa` (any pre-existing legacy rounding discrepancies flagged in migration report).
3. **Inventory & Stock Ledger Parity:**
   - `SUM(products.stock_on_hand) == SUM(stock_ledger.qty_delta)` per product (`0` drift).
4. **Wallet & Finance Ledger Parity:**
   - Exact sum parity on `vendors.balance_paisa`, `resellers.balance_paisa`, `resellers.deposit_paisa`, `fund_transactions.amount_paisa`, `expenses.amount_paisa`, and `salaries.net_salary_paisa`.

---

## 10. Phase 03 Implementation Status (`2026-10-25`)

- **Implemented & Verified in Phase 03:**
  - `src/db/mysqlPool.js`: `mysql2/promise` connection pool, `STRICT_TRANS_TABLES`, `utf8mb4`, UTC `+00:00`, `withTransaction`, and ascending `lockRowsById` (`SELECT ... FOR UPDATE`).
  - `src/db/migrator.js` & `scripts/migrate.js`: Reversible `.up.sql` / `.down.sql` runner with `schema_migrations`, `SHA-256` checksum verification, `GET_LOCK` advisory locking, and `CONFIRM_PRODUCTION_MIGRATION=true` CLI safety guard.
  - `src/db/migrations/0001..0003`: `71` `InnoDB` `utf8mb4_unicode_ci` tables (`11` + `18` + `42`) with `BIGINT` `*_paisa` money columns and explicit foreign keys.
  - **Staged Caller Conversion:** Phase 03 core infrastructure callers (`sessionManager.js`, `auth.js`, `adminAuth.js`, `server.js` error logging, `/health`) now run via `src/repositories/*`; the 8 portal feature route files (`439` `db.*` calls) are tracked in `docs/PHASE_03_DB_TRANSITION.md` for conversion in Phases 05–18.

