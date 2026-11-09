# Release Validation — Migration 0030 & Pre-Launch QA Fixes

**Date:** 2026-11-09 (Asia/Dhaka)  
**Base commit:** `56bc9c113a9c8fded655ef2741fcf4017d9568f7` (`main`)  
**Verification branch:** `arena/b73fcbd6-mrtumi`  
**Disposition:** Code-complete and locally verified. Database execution is delegated to the repository's disposable MySQL 8.0 / MariaDB 10.11 CI, because this sandbox has no MySQL/MariaDB service and no target database credentials.

---

## 1. Premise correction (read first)

The release instruction referred to a migration `0030` containing a `payment_pending` enum and verification-status enhancements, plus `npm run migrate` and `scripts/run-migration-0030.js`. None of these exist in this repository:

| Referenced item | Actual repository state |
|---|---|
| `0030` = payment pending / verification status | `0030_multivendor_commerce_engine` — commission rules, vendor sub-orders, wallets, ledger, payout requests, gateway config |
| `payment_pending` enum/column | No occurrence anywhere in SQL, JS, EJS, or docs |
| `npm run migrate` | Not defined. Canonical entry points are `npm run migrate:status`, `migrate:up`, `migrate:down` |
| `scripts/run-migration-0030.js` | Does not exist and was deliberately **not** added; a second migration path would bypass checksum/ordering/lock guarantees |
| Target database | No MySQL/MariaDB binary, container runtime, or `DB_*` credentials in the sandbox. `npm run migrate:status` fails closed with `Missing or invalid MySQL configuration variables: DB_NAME, DB_USER` |

No fake `payment_pending` state, column, or migration was invented. Any such state must come from an approved product specification.

---

## 2. Release-blocking findings and fixes

### 2.1 Migration 0030 crashed on MySQL 8.0 (ER_PARSE_ERROR)

The `main` CI run for `56bc9c1` failed at the migration-diagnosis step with:

```
Failed applying "0030_multivendor_commerce_engine.up.sql" at statement #3:
... syntax ... near 'IF NOT EXISTS `vendor_order_id` ...'
mysqlCode: ER_PARSE_ERROR
```

`ALTER TABLE ... ADD/DROP ... IF [NOT] EXISTS` and `CREATE INDEX IF NOT EXISTS` are MariaDB extensions. MySQL 8.0's `ALTER TABLE` grammar has no such clauses. The same construct appeared in migrations `0030`, `0032`, `0033`, `0034`, `0035`, and `0036` (the MariaDB CI job passed, which masked the defect).

**Fix:** rewrote the affected clauses as portable plain DDL, preserving the exact same column/index definitions and order. Added a permanent foundation check that rejects MariaDB-only `ALTER ... IF [NOT] EXISTS` / `CREATE INDEX IF NOT EXISTS` syntax in any `.up.sql` or `.down.sql`.

Removing the silent `IF NOT EXISTS` then exposed a second latent defect that MariaDB had been masking: `0030` re-added `payment_gateways.gateway_type`, which has existed since migration `0003`. On MySQL this is `ER_DUP_FIELDNAME` (`Duplicate column name 'gateway_type'`, confirmed in CI run for this branch). The redundant add — and its rollback drop — were removed; `gateway_type` remains owned by `0003`. A new migration test simulates the ordered schema and fails on any future duplicate `ADD COLUMN`.

### 2.2 Migration 0033 deleted live gateway rows

`0033_dynamic_mfs_payment_gateways.up.sql` began with `DELETE FROM payment_gateways WHERE code NOT IN (...)`, permanently destroying operator-configured gateway rows and credentials.

**Fix:** the migration now adds its columns first and then **deactivates** non-canonical rows (`status=0, is_active=0`). No row or credential is deleted. Checkout filters on `(status=1 AND is_active=1)`, so retired channels disappear from checkout while remaining available for audit and reconciliation.

### 2.3 Migration 0030 rollback referenced a constraint it never created

The down migration ran `DROP FOREIGN KEY IF EXISTS fk_order_items_vendor_order`, but the up migration only adds a nullable column and an index. With portable syntax that would fail on MySQL.

**Fix:** removed the phantom FK drop; the rollback now drops the index and then the column, in that order, using plain DDL.

### 2.4 Missing Phase B fulfillment repository functions (runtime TypeError)

Five routes called repository functions that did not exist:

- `POST /admin/fulfillment/sub-orders/:id/delivery-mode`
- `POST /admin/fulfillment/sub-orders/:id/booking-result`
- `POST /admin/fulfillment/sub-orders/:id/handover`
- `POST /vendor/sub-orders/:id/booking-result`
- `POST /vendor/sub-orders/:id/handover`

`courierIntegrationRepository` also called a non-existent `vendorOrderRepository.syncParentStatus`.

**Fix:** implemented `setDeliveryMode`, `recordBookingResult`, `recordPhysicalHandover`, and `syncParentStatus` in `src/repositories/vendorOrderRepository.js` against migration `0027`'s `fulfillment_shipment_events` and `delivery_mode`/`booking_status` schema:

- Booking is recorded separately from physical pickup. Booking never changes sub-order status and never sets `picked_up_at`.
- Physical handover requires a successful booking, sets `in_transit` + `picked_up_at`, and writes an immutable `physical_handover` event.
- Platform-managed shipments are booked/handed over only by an authorized platform administrator.
- Failed delivery closes that shipment; a retry opens a new shipment row and preserves the original.
- Parent order advances to `shipped` when every non-cancelled sub-order is handed over, and to `delivered` only when every applicable sub-order is delivered.
- Vendor transition map is forward-only at preparation: `ready_for_pickup` no longer permits self-declared transit. `in_transit`/`delivered`/`failed_delivery` require a recorded platform administrator event (`Only an authorized platform administrator may confirm this shipment event.`).

### 2.5 Startup guard regression hung every CI test run

`server.js` had lost its `NODE_ENV=test` startup guard. The test `spawnSync(node server.js)` therefore started a real listener and never returned; the MariaDB CI job was still `in_progress` after 5+ hours, and a local `npm test` exceeded 30 minutes.

**Fix:** restored fail-closed development/test guards and the Passenger-compatible primary export contract (`module.exports = app` plus `.app`/`.startServer`). The full suite now exits in ~24 seconds.

### 2.6 Private return evidence could be served by static middleware

The `/uploads/custom` evidence guard was missing, and the public static middleware was registered before the uploads handler.

**Fix:** restored a guard above `express.static(public)` that refuses any registered `customer_return_requests.evidence_path` with HTTP 404, on both SQLite and MySQL, failing closed if the registry cannot be consulted.

### 2.7 RBAC policy gaps

- `GET /admin/api/analytics/visitors` had no legacy policy and fell through to the fail-closed "unmapped" 403, so the dashboard widget could never load. It is now mapped to `dashboard.view`.
- `/admin/courierapi/*` routes had lost their explicit `settings.manage` + CSRF guards. Restored on list/create/update/toggle/delete, and the middleware policy now agrees on `settings.manage` instead of requiring a second, undocumented permission.

### 2.8 OTP-mode checkout failed with DB_QUERY_FAILED (TDZ `ReferenceError`)

`checkoutRepository.createOrder` consulted `customerId` in the OTP-verification branch *before* its `let customerId` declaration. That is a temporal-dead-zone `ReferenceError`; `mysqlPool.withTransaction` sanitized the non-operational error to `DB_QUERY_FAILED (MYSQL_ERROR)`, so **every checkout while `otp_mode='on'` returned HTTP 500** instead of the OTP prompt. The live MySQL/MariaDB suite that exercises this path had a stale expectation (`CONFLICT`) and had never executed, because CI aborted earlier at migration diagnosis.

**Fix:** resolve and validate the session customer id before the OTP policy block, then reuse it for both the verified-phone bypass and the ownership check. The live test now asserts the documented `VALIDATION_ERROR` and the customer-facing OTP message, and its helper prints the driver code on failure.

### 2.9 Deactivated gateways stayed selectable (`OR` instead of `AND`)

After 0033 added `is_active` (default `1`) alongside the legacy `status` column, checkout's gateway lookup accepted a row when **either** flag was set. Disabling a channel with `UPDATE payment_gateways SET status=0` — what the legacy admin screen does — therefore left it fully selectable, including manual MFS channels. The live MySQL suite caught it once earlier failures were cleared.

**Fix:** both checkout queries now require `status=1 AND is_active=1`. Legacy `status` remains authoritative for deactivation, and `is_active` can only narrow the set further — fail-closed in both directions. Both columns are already written together by the current admin repository, so no UI behavior regresses.

### 2.10 Stale migration-count test

`tests/phase03-foundation.test.js` hard-coded 29 migration pairs. It now derives the contiguous `0001`–`0036` expectation, so the assertion still fails on gaps or duplicates without blocking approved additive migrations.

---

## 3. Compatibility and invariants

- **No destructive UP migration:** no `DROP TABLE`, `DROP COLUMN`, or `DELETE` of business rows in any forward migration. 0033's deletion was converted to deactivation.
- **Order lifecycle:** no parent order status, primary key, or checkout transaction was changed. Vendor sub-order transitions were tightened to the documented Phase B contract.
- **Checksums:** only migrations `0030`–`0036` changed. They cannot have been applied by MySQL (0030 failed at statement #3) and are pre-launch; if any MariaDB scratch database recorded them, recreate that disposable database before applying this branch. Production must apply via `npm run migrate:up` after a verified backup.
- **Backward compatibility:** all altered columns keep their names, types, defaults, nullability, and comments; only the non-portable `IF [NOT] EXISTS` tokens and the 0033 deletion changed.

---

## 4. Verification evidence (this sandbox)

| Gate | Command | Result |
|---|---|---|
| Foundation lint (syntax, EJS, i18n, migrations, secrets) | `npm run lint` | **1714 passed, 0 failed** |
| Full unit/portal suite | `npm test` | **412 tests, 380 passed, 0 failed, 32 skipped** (DB-gated suites) |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| MySQL-dialect syntax parse of 0030–0036 | `node-sql-parser` (MySQL grammar) | **72/72 statements parsed** |
| Phase B lifecycle simulation | SQLite transaction shim over the real repository | **PASS** — booking/handover separation, conflicts, admin gate, retry shipment, parent `shipped`/`delivered`, event actor types |
| Migration execution | `npm run migrate:status` | Blocked: no MySQL/MariaDB service or credentials in sandbox |
| CI migration diagnosis (MySQL 8.0) | GitHub Actions `Diagnose MySQL migrations individually on a fresh schema` | **PASS** (all 36 pairs) |
| CI migrator round-trip (MySQL 8.0) | `up -> status -> reversible down/up` + full reapply | **PASS** |
| CI backup/restore rehearsal (MySQL 8.0) | Disposable schema logical dump/restore | **PASS** |
| CI migration diagnosis + round-trip (MariaDB 10.11) | Diagnose, `0028`–`0029` up/down/reapply, `0025`–`0024` rollback, full reapply, backup/restore | **PASS** |

**Not executable here:** applying DDL to a live MySQL 8.0/MariaDB 10.11 instance, live-provider calls, and production deployment. The repository's own CI (`Diagnose migrations`, migrator up/down/reapply, live MySQL/MariaDB integration suites) is the authoritative database gate for this change.

---

## 5. Deployment order (owner/operator)

1. Take and verify a restorable backup of the target database.
2. On staging (same engine version as production): `npm run migrate:status` → confirm `0001`–`0029` applied and `0030`–`0036` pending.
3. Apply: `npm run migrate:up` (production additionally requires `CONFIRM_PRODUCTION_MIGRATION=true`).
4. Re-run `npm run migrate:status`; expect every version `APPLIED` with the checksums from this branch.
5. Rehearse rollback on staging if required: `npm run migrate:down 1` repeatedly, in reverse order, then re-apply.
6. Start the app via `app.js`, verify `/health`, then exercise vendor booking/handover and admin fulfillment in staging before production traffic.
