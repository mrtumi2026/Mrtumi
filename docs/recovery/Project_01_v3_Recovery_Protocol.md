# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3.1 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Authentic Target Release Commit:** Explicitly supplied as command parameter (e.g. `5285d82e7e233c50561222c419fc163d79d74c5d`)  
**Baseline Production Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ / 10.11 InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Database Name:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation (v3.1)

This specification addresses and closes all independent audit blockers identified by Arena.ai:

| Domain | Legacy / v3 Blocker | v3.1 Hardened Specification |
|---|---|---|
| **Release Target Specification** | Self-referential hardcoded SHA in `deploy.sh` creates circular Git tree hash alteration. | **Verifiable Release Parameter**: `deploy.sh <TARGET_COMMIT_SHA>` or `APPROVED_RELEASE_SHA=<TARGET_COMMIT_SHA>`. Validates 40-character hexadecimal format and commits existence on remote before execution. |
| **Recovery Destructive Safeguards** | Automatic table drop on migration failure risks destructive loss if rollback misfires. | **Approval-Safe Destructive Recovery Gate**: `executeCanonicalRecovery` strictly requires `CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY="I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY"`. Automatic deployment rollback holds code/schema state and keeps maintenance active without destructive drops. |
| **.htaccess Rule Preservation** | Overwriting `.htaccess` wipes pre-existing cPanel Passenger configurations, security headers, and rewrite rules. | **Byte-for-Byte Preservation**: Creates verified byte backup (`.htaccess.pre_maint_backup`) with SHA-256 verification before modifying. Prepends 503 rules between bounded comment markers. Disengaging restores exact bytes, file mode, and verifies SHA-256. |
| **Worker Isolation Coverage** | Only 4 background scripts were guarded, leaving `seed-categories.js` and `migrate.js` ungated. Corrupted lock JSON caused silent failures. | **Complete Worker Inventory & Fail-Closed Lock**: `guardWorkerExecution` added to all 6 production writers. Lock inspection fails closed on unreadable files, corrupt JSON, or stale locks (>24h). Distinguishes production writers from QA runners. |
| **Uploads Archive Restore** | Uploads archive was created but lacked an automated, verified restoration implementation. | **Verified Staged Upload Restore**: Implemented `restoreUploadsArchive` with tar entry pre-scan (rejecting absolute paths and `../` traversal), staged extraction in temporary directory, and safe atomic swap. |
| **Manifest Lifecycle Tracking** | Static manifest lacked runtime lifecycle progression and used hardcoded dump footer assertions. | **4 Discrete Manifest States**: Tracks `backup_created`, `integrity_verified` (actual tail inspection for `-- Dump completed`), `database_restore_rehearsed`, and `uploads_restore_rehearsed` with atomic updates. |
| **Test Fixtures & Real Dumps** | Mock table strings and mock dump fixtures masked DDL foreign-key and checksum nuances. | **Real Disposable Database & mysqldump**: Unique disposable DB (`mrtumi_disp_recov_*`), real migrations 0001–0036 via `migrator.js`, real `mysqldump` baseline, and 0 diff verification across all 5 partial-DDL failure scenarios. |

---

## 2. Exhaustive Schema Recovery Mechanism (MariaDB 10.11 & MySQL 8.0)

### Why standard dump restore alone leaves residual objects:
1. Migration 0038 introduces `vendor_courier_booking_requests` and `vendor_courier_booking_audit_logs`. Because these tables did not exist when the baseline dump was generated, the dump contains **no** `DROP TABLE IF EXISTS` for them.
2. Migration 0037 alters the existing `vendors` table by adding 6 columns (`slug`, `logo_url`, `banner_url`, `tagline`, `description`, `store_status`) and indexes (`uq_vendors_slug`, `idx_vendors_store_status`). If `vendors` is not dropped prior to restore, non-dropping dumps leave these columns intact.

### Validated Solution (`executeCanonicalRecovery`):
```sql
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS vendor_courier_booking_audit_logs;
DROP TABLE IF EXISTS vendor_courier_booking_requests;
DROP TABLE IF EXISTS vendors;
SET FOREIGN_KEY_CHECKS = 1;
```
Following this cleanup, the verified baseline dump streams into MariaDB, recreating `vendors` with its exact pre-0037 column definition and restoring all 36 baseline migrations with zero residual objects and zero data diffs.

---

## 3. Worker and Cron Isolation Inventory

All database-mutating CLI runners and background jobs implement the mandatory maintenance gate:

| Script Path | Scheduled Frequency | Mutated Database Objects | Guard Implementation |
|---|---|---|---|
| `scripts/expire-reservations.js` | Every 5-15 mins | `orders`, `order_reservations` | `guardWorkerExecution('expire-reservations')` |
| `scripts/process-matured-settlements.js` | Daily cron | `partner_settlements`, ledger balance | `guardWorkerExecution('process-matured-settlements')` |
| `scripts/sync-courier-tracking.js` | Hourly cron | `fulfillment_shipments`, `vendor_sub_orders` | `guardWorkerExecution('sync-courier-tracking')` |
| `scripts/apply-approved-business-launch.js` | Manual launch CLI | `products`, `settings` | `guardWorkerExecution('apply-approved-business-launch')` |
| `scripts/seed-categories.js` | Seeding CLI | `categories`, `subcategories` | `guardWorkerExecution('seed-categories')` |
| `scripts/migrate.js` | Schema CLI | `schema_migrations`, DDL objects | `guardWorkerExecution('migrate')` (unless authorized) |
| `HTTP Request Handlers` | Real-time web requests | Orders, checkouts, cart | Blocked at web layer by 503 `.htaccess` rewrite |

---

## 4. Canonical Preflight & Deployment Sequence

The canonical deployment pipeline is implemented in [deploy.sh](file:///C:/Users/Bappi/.gemini/antigravity/scratch/mrtumi-main/deploy.sh):
1. **Gate 0 — Target Verification**: Validates explicit 40-character hex commit SHA from parameter or environment.
2. **Gate 1 — Runtime**: Verifies Node.js >= 22.5.0 and active venv.
3. **Gate 2 — Git Hygiene**: Verifies clean working tree (zero uncommitted tracked modifications) without running destructive `git reset --hard` or `git clean`.
4. **Gate 3 — Isolation**: Engages 503 maintenance mode with byte-for-byte `.htaccess` preservation, writes `$HOME/.mrtumi_maintenance.lock`, and safely suspends crontab with verified backup.
5. **Gate 4 — Pre-Deployment Backup**: Generates verified SQL dump with real completion footer inspection, creates uploads archive, and pins cryptographic v3.1 manifest.
6. **Gate 5 — Safe Merge**: Executes non-destructive fast-forward merge to target commit SHA.
7. **Gate 6 — Dependencies**: Installs production dependencies cleanly via `npm ci --only=production`.
8. **Gate 7 — Migrations**: Executes database migrations targeting strictly version `0038`.
9. **Gate 8 — Post-Migration Verification**: Validates 6 branding columns, unique slug index, 0038 courier tables, and zero empty slugs.
10. **Finalization**: Recycles Passenger workers (`tmp/restart.txt`), performs HTTP health check, restores crontab byte-for-byte, and restores original `.htaccess` byte-for-byte.
11. **Error Handler (Fail-Closed)**: If failure occurs pre-migration, safely realigns code. If failure occurs post-migration, does NOT drop tables automatically; preserves maintenance lock, records failure details in manifest and lock, and halts for operator review.
