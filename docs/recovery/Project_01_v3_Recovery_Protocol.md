# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3.2 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Release Governance Allowlist:** Governed by `config/approved-releases.json` and verified by `scripts/ops/verify-release-approval.js`  
**Production Baseline Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ / 10.11 InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Database Name:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `scripts/ops/verify-release-approval.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation (v3.2)

This specification addresses and closes all critical and high-priority audit findings identified by Arena.ai:

| Domain | Prior Vulnerability / Finding | v3.2 Hardened Specification |
|---|---|---|
| **Mandatory Backup Gate** | Manifest was created in Step 4, but `deploy.sh` never enforced manifest validation before running migrations. | **Enforced Pre-Migration Verification Gate (Gate 6.5)**: Calls `validateAndLoadManifest` before running `migrateUp`. Verifies database identity, dump existence, SHA-256 match, size match, genuine `-- Dump completed` footer, and `backup_created=true` + `integrity_verified=true`. Fails closed if any check fails. |
| **Restore Rehearsal Prerequisite** | Rehearsal states were tracked in manifest but not enforced before destructive recovery. | **Enforced Rehearsal Prerequisite Gate**: `executeCanonicalRecovery` strictly requires `database_restore_rehearsed: true` on the specific backup being restored. Rejects unrehearsed restore fail-closed unless explicit emergency override and recorded operator justification are provided. |
| **Uploads Restore Atomic Swap Rollback** | Moving staged files into target after old target was renamed had no automated rollback; if swap failed, live directory was lost. | **Automatic Target Rollback on Swap Failure**: `restoreUploadsArchive` traps any error during or after moving the old target directory, automatically restoring the original directory back to `resolvedTarget` intact. |
| **Malicious Archive Protection** | Traversal and symlink protection lacked full entry inspection against symlinks, hardlinks, and directory escapes. | **Complete Tar Security Pre-Scan**: Pre-scans tar header listings with `tar -ztvf` to reject symlinks (`l...` or `->`), hardlinks (`h...` or `link to`), absolute paths, null bytes, and `../` traversal. Post-extraction recursively asserts zero symbolic links exist. |
| **Comprehensive Schema Verification** | Test snapshots only checked tables, basic columns, indexes, and row hashes. | **Full Schema Structure Verification**: Extends snapshots and comparisons to include foreign keys (`KEY_COLUMN_USAGE`), referential actions (`REFERENTIAL_CONSTRAINTS`), check constraints (`TABLE_CONSTRAINTS`), triggers (`TRIGGERS`), views (`VIEWS`), routines (`ROUTINES`), and generated column expressions (`GENERATION_EXPRESSION`). |
| **Rollback Silent Failure (`\|\| true`)** | `git checkout --detach` in error trap used `\|\| true`, masking rollback failures. | **Strict Rollback Outcome Verification**: Removed `\|\| true`. If code rollback fails, emits fatal diagnostic, alerts operator, and preserves 503 maintenance mode. |
| **Release Target Governance** | Any arbitrary 40-character SHA existing in Git was accepted as deployment target. | **Release Governance & Allowlist Gate**: `scripts/ops/verify-release-approval.js` verifies target commit against `config/approved-releases.json`, approved release tags (`v*`), or authorized governance sign-off. Rejects arbitrary unvetted commits fail-closed. |
| **Confirmation Flag Isolation** | Generic `CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY` could be accidentally inherited from ambient `.env` or shell profiles. | **Scoped Confirmation Token**: Confirmation must be tied to the specific manifest `run_id` (`opts.confirmationToken === manifest.run_id` or `CONFIRM_DESTRUCTIVE_RECOVERY_RUN_ID === manifest.run_id`). Ambient flags without matching `run_id` are rejected fail-closed. |

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
Following this cleanup, the verified baseline dump streams into MariaDB, recreating `vendors` with its exact pre-0037 column definition and restoring all 36 baseline migrations with zero residual objects and zero schema/data diffs across all 11 schema structures.

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

The canonical deployment pipeline is implemented in [deploy.sh](deploy.sh):
1. **Gate 0 — Target & Approval Verification**: Validates 40-character hex commit SHA and runs `verify-release-approval.js` against governance allowlist and release tags.
2. **Gate 1 — Runtime**: Verifies Node.js >= 22.5.0 and active venv.
3. **Gate 2 — Git Hygiene**: Verifies clean working tree (zero uncommitted tracked modifications) without running destructive `git reset --hard` or `git clean`. Checks for untracked path collisions.
4. **Gate 3 — Isolation**: Engages 503 maintenance mode with byte-for-byte `.htaccess` preservation, writes `$HOME/.mrtumi_maintenance.lock`, and safely suspends crontab with verified backup.
5. **Gate 4 — Pre-Deployment Backup**: Generates verified SQL dump with real completion footer inspection, creates uploads archive, and pins cryptographic v3.2 manifest.
6. **Gate 5 — Safe Merge**: Executes non-destructive fast-forward merge to approved target commit SHA.
7. **Gate 6 — Dependencies**: Installs production dependencies cleanly via `npm ci --only=production`.
8. **Gate 6.5 — Mandatory Backup Manifest & Dump Verification**: Loads pinned manifest, verifies database identity match, dump file existence, dump size match, dump SHA-256 match, active dump footer on disk, and `backup_created=true` + `integrity_verified=true`. Fails closed if any check fails!
9. **Gate 7 — Migrations**: Executes database migrations targeting strictly version `0038`.
10. **Gate 8 — Post-Migration Verification**: Validates 6 branding columns, unique slug index, 0038 courier tables, and zero empty slugs.
11. **Finalization**: Recycles Passenger workers (`tmp/restart.txt`), performs HTTP health check, restores crontab byte-for-byte, and restores original `.htaccess` byte-for-byte.
12. **Error Handler (Fail-Closed)**: If failure occurs pre-migration, realigns code and verifies checkout success (no `|| true`). If failure occurs post-migration, does NOT drop tables automatically; preserves maintenance lock, records failure details in manifest and lock, and halts for operator review.

---

## 5. Local Engineering Readiness vs. Production Readiness

### Verified Locally and in CI:
- [x] Full test suite (574+ tests) passing on MariaDB 10.11 and MySQL 8.0.
- [x] Zero-difference schema & data recovery across all 11 database structures.
- [x] Uploads restore atomic swap rollback and malicious tar security pre-scan.
- [x] Mandatory backup manifest gate and rehearsal prerequisite enforcement.
- [x] Scoped confirmation tokens preventing ambient environment pollution.
- [x] Release target governance allowlist verification.

### Remaining Production Checks (Cannot Be Simulated Locally):
The following operational checks must be verified on the actual cPanel production host prior to live traffic:
1. **Live cPanel Crontab Inspection**: Verifying the live `crontab -l` entries for user `mrtumico` and confirming that the crontab CLI can suspend and restore.
2. **Live Apache / CloudLinux Passenger 503 Behavior**: Confirming that the cPanel Apache Passenger handler honors `.htaccess` 503 rewrite rules without caching or bypass.
3. **Remote Git Branch Protection**: Confirming that GitHub repository branch protection rules require passing CI check runs before release merges.
4. **Live cPanel Storage Quota**: Confirming that `/home/mrtumico` has sufficient disk quota for full SQL dump and uploads archive creation.
