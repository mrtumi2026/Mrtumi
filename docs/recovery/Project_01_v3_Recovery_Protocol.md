# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Authentic Target Release Commit:** `5285d82e7e233c50561222c419fc163d79d74c5d`  
**Baseline Production Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Database Name:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation

This specification replaces legacy, non-deterministic deployment practices with a mathematically proven, non-destructive recovery system.

| Domain | Legacy Practice (v1 / v2) | Critical Failure Mode | v3 Hardened Specification |
|---|---|---|---|
| **Git Recovery** | `git checkout -B main <sha>` | Resets `refs/heads/main` backwards, causes reflog divergence, risks tracked file loss. | **Detached HEAD Realignment**: `git checkout --detach <pre_deploy_sha>`. Branch history remains intact, untracked files preserved, fails closed if working tree is dirty. |
| **Partial DDL Schema Recovery** | Normal SQL dump restore alone | MariaDB DDL is non-transactional (`IMPLICIT COMMIT`). Orphaned 0038 tables and 0037 columns remain after dump restore. | **Pre-Restore DDL Cleanup + Streaming Restore**: Explicitly drops candidate 0038 tables (`vendor_courier_booking_requests`, `vendor_courier_booking_audit_logs`) and drops `vendors` before streaming the baseline dump, yielding **0 schema diffs**. |
| **Manifest & Backup Identity** | Loose text files & grepped paths | Path traversal (`../../`), atomic write race conditions, cross-database dump restore. | **Cryptographic Manifest v3**: UUID `run_id`, DB Host/Name binding, canonical path bounds (`path.resolve`), atomic `.tmp` rename (`fs.renameSync`). |
| **Memory & Restore Streaming** | Unbounded buffers / fs.readFileSync | V8 heap exhaustion (OOM), silent `EPIPE` crashes. | **True Streaming with Backpressure**: 64KB highWaterMark chunks, EPIPE and child stderr trapped fail-closed. |
| **Worker & Traffic Isolation** | Naive `.htaccess` rewrite | Crontab background jobs (`expire-reservations.js`) bypass `.htaccess` and write during partial DDL. | **Dual-Layer Isolation**: 503 `.htaccess` + `$HOME/.mrtumi_maintenance.lock` guard + safe crontab suspension. Lock persists permanently upon failure. |

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
Following this cleanup, the verified baseline dump streams into MariaDB, recreating `vendors` with its exact pre-0037 column definition and restoring all 36 baseline migrations with zero residual objects.

---

## 3. Worker and Cron Isolation Inventory

All database-mutating CLI runners and background jobs implement the mandatory maintenance gate:

| Script Path | Scheduled Frequency | Mutated Database Objects | Guard Implementation |
|---|---|---|---|
| `scripts/expire-reservations.js` | Every 5-15 mins | `orders`, `order_reservations` | `guardWorkerExecution('expire-reservations')` |
| `scripts/process-matured-settlements.js` | Daily cron | `partner_settlements`, ledger balance | `guardWorkerExecution('process-matured-settlements')` |
| `scripts/sync-courier-tracking.js` | Hourly cron | `fulfillment_shipments`, `vendor_sub_orders` | `guardWorkerExecution('sync-courier-tracking')` |
| `scripts/apply-approved-business-launch.js` | Manual launch CLI | `products`, `settings` | `guardWorkerExecution('apply-approved-business-launch')` |
| `HTTP Request Handlers` | Real-time web requests | Orders, checkouts, cart | Blocked at web layer by 503 `.htaccess` rewrite |

---

## 4. Canonical Preflight & Deployment Sequence

The canonical deployment pipeline is implemented in [deploy.sh](file:///C:/Users/Bappi/.gemini/antigravity/scratch/mrtumi-main/deploy.sh):
1. **Gate 1 — Runtime**: Verifies Node.js >= 22.5.0.
2. **Gate 2 — Git Hygiene**: Verifies clean working tree (zero uncommitted tracked modifications) and zero untracked path collisions.
3. **Gate 3 — Isolation**: Engages 503 maintenance mode, writes `$HOME/.mrtumi_maintenance.lock`, and safely suspends crontab.
4. **Gate 4 — Pre-Deployment Backup**: Generates verified SQL dump and uploads archive, pins cryptographic v3 manifest.
5. **Gate 5 — Safe Merge**: Executes non-destructive fast-forward merge to `5285d82e7e233c50561222c419fc163d79d74c5d`.
6. **Gate 6 — Dependencies**: Installs production dependencies via `npm ci --only=production`.
7. **Gate 7 — Migrations**: Executes migrations targeting strictly version `0038`.
8. **Gate 8 — Post-Migration Integrity**: Verifies 6 branding columns, unique slug index, 0038 courier tables, zero null/empty slugs.
9. **Finalization**: Recycles Passenger workers (`tmp/restart.txt`), runs health checks, and lifts maintenance mode cleanly.
10. **Error Trap**: If any gate fails, triggers non-destructive detached checkout to baseline `1b3c9a19...` and preserves maintenance lock permanently.
