# Phase F — Production Operations and Recovery Controls

**Status:** implementation guidance and disposable-database rehearsal tooling. This document is not evidence of production readiness. No production database, host, credential, customer data, payment, courier, or deployment was used. Thresholds and policies marked **OWNER DECISION** are deliberately not invented.

## 1. Owner decisions required before launch

Record and approve, without placing secrets in this document:

- **RPO, RTO, backup frequency, retention duration, archive/deletion policy, and restore-point approval.** No values are proposed here.
- Named primary and secondary incident/restore approvers, escalation contacts, coverage hours, and communication channel.
- Monitoring/alert provider, destinations, severity routing, alert thresholds, maintenance windows, and acknowledgment/escalation time.
- Production database endpoint/version, exact runtime/migration/backup accounts, grants, secret storage/rotation, TLS requirements, and recovery access.
- Which scheduled jobs are required, expected cadence, maximum tolerated lateness, and the owner for each job.
- Financial control owners and thresholds for failed payment, unsettled COD, discrepancies, duplicate/late reconciliation, and settlement exceptions. Do not auto-correct or silently rewrite financial records.
- Whether backup archives include uploads and vendor documents, where encryption keys are held, geographic separation, and access policy.

Until these are decided and rehearsed in host-specific staging, backup, alerting, access control, and financial operations are launch blockers.

## 2. Backup and restore rehearsal (disposable databases only)

`node scripts/backup-restore-rehearsal.js` performs a logical `mysqldump` followed by restore into the **same** database. The restore uses `DROP TABLE IF EXISTS`; it is destructive to the target database. It requires `BACKUP_RESTORE_REHEARSAL=YES_I_AM_USING_A_DISPOSABLE_DATABASE` and restricts the database name to `mrtumi_test`, `mrtumi_backup_test`, or `test_*`. Never weaken this guard or point it at production/staging/customer data.

Required environment: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_CLIENT=mysql`, and the explicit acknowledgment above. Install compatible `mysqldump` and `mysql` CLI tools. Credentials are passed to child processes through `MYSQL_PWD`; use disposable, short-lived CI credentials only. The script removes its temporary SQL artifact after completion and prints checksums, not rows.

The rehearsal verifies:

1. Expected essential tables exist: migration ledger, users, customers, products, orders, audit logs.
2. Before and after restore, all base-table names/counts and a deterministic hash of row contents match.
3. Column metadata, indexes, constraints, triggers, and views match by digest.
4. All base tables use InnoDB.
5. MySQL/MariaDB server and dump-client versions are recorded in output.

This is a logical backup drill, not a point-in-time recovery test, encrypted off-site backup, upload/document backup, binary-log recovery, restore-time SLA, or production-host validation. Large datasets may exceed the script's explicit test-oriented process buffer; this harness is for disposable CI schemas only. Production backup solutions must be selected and tested independently after owner decisions.

For manual inspection, first verify the target name and environment from a disposable service; do not copy production data. Then run `npm run backup:restore:rehearsal` with the acknowledgment. A failure means the disposable schema may be partially restored; discard and recreate that disposable schema through its CI/service lifecycle before retrying.

## 3. Application health and monitoring requirements

Existing `/health` and `/api/v1/health` endpoints execute a bounded database ping and report process uptime, DB status, latency, and a safe error code. They are liveness checks, not full readiness checks: they do not validate migrations, queue/job freshness, payment provider health, upload durability, COD balance, or settlement integrity.

Monitor externally; do not add a timer inside the web process as a substitute for an independent scheduler:

| Signal | Minimum observation | Alert/action |
|---|---|---|
| HTTP availability | Poll both health URLs from outside the application host; record status/latency and TLS validity. | Alert on sustained failures per owner-approved threshold; check process, proxy, and DB. |
| Database | Health endpoint plus DB connection errors/latency and pool exhaustion from redacted app logs/metrics. | Page on sustained outage; use outage runbook. Never expose credentials or SQL payloads in alerts. |
| Application errors | Structured error logs, uncaught exceptions/rejections, HTTP 5xx, process restarts, memory/disk pressure. | Route severity to named on-call; correlate request ID and exact release SHA. |
| Background jobs | External scheduler records job name, start/end, exit code, duration, last-success timestamp, and non-sensitive run ID. Alert on failure and stale/missing heartbeat using owner-approved cadence. | Check scheduler, lock contention, DB access, and idempotent retry safety. Never infer success from a running process alone. |
| Payments | Pending/failed callback and reconciliation counts/age, provider rejection/timeout/error rate, unmatched references. | Route to payments owner; reconcile using immutable evidence. Never trigger duplicate charges/refunds automatically. |
| COD | Pending collections, discrepancies, unreconciled age and courier remittance variance. | Route to finance owner. Do not mark reconciled, alter balances, or release funds automatically to clear an alert. |
| Backups | Latest successful completion, artifact checksum, archive accessibility, age vs owner policy, restore-test result. | Alert to backup owner; retain prior known-good artifacts while investigating. |
| Security | Authentication/authorization denials, CSRF failures, unusual admin activity, dependency/security alerts. | Preserve audit records; escalate suspected compromise to incident response. |

Metrics and logs must avoid passwords, session/CSRF tokens, payment secrets, full recipient/customer data, and unnecessary financial details. Use access control, retention, and redaction policies approved by owners.

## 4. Database least privilege and permission matrix

Create separate principals for separate duties. Do not reuse a privileged migration or backup identity for web requests.

| Principal | Required scope and capability | Explicitly prohibited / notes |
|---|---|---|
| Runtime application | One application schema only; `SELECT`, `INSERT`, `UPDATE`, `DELETE`. Triggers execute under their definer; grant runtime `TRIGGER` only if a tested platform constraint proves it necessary and owner approves. | No global grants; no `ALL`; no schema DDL (`CREATE`, `ALTER`, `DROP`, `INDEX`), user/role administration, `FILE`, `PROCESS`, `SUPER`/admin, `GRANT OPTION`, replication, or backup privilege. |
| Migration operator | One target schema; only reviewed DDL/DML needed by the migration set (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `INDEX`, `REFERENCES`, `CREATE ROUTINE`, `ALTER ROUTINE`, `EXECUTE`, `TRIGGER` as required by actual migrations). | Human/controlled CI use only; no global privileges; never configure as application `DB_USER`. Some server versions require a separately reviewed server-level setting for deterministic trigger/function creation—do not solve this with broad application grants. |
| Backup operator | Read-only access to one schema plus only the metadata/trigger/view/routine/event privileges required by the chosen backup tool/version (often `SELECT`, `SHOW VIEW`, `TRIGGER`, `EVENT`; tool-specific lock/flush privileges must be proven). | No application writes or DDL. Prefer a managed backup identity/tool. Do not grant global `RELOAD`/`LOCK TABLES` by default; verify exact tool needs. |
| Restore operator | Time-limited, controlled identity for an isolated restore target; required schema DDL and data load privileges. | Never give this identity to the application; production restore requires separate owner approval and documented impact review. |
| Monitoring probe | Prefer existing unauthenticated, rate-limited health endpoint; if direct DB probing is unavoidable, narrowly scoped read-only probe. | No customer table scans, writes, DDL, or broad metadata access. |

Automated check: `npm run db:privileges:check` connects with the configured account and rejects global grants (except global `USAGE`), schema privileges beyond DML, `WITH GRANT OPTION`, and unparsed grants/role assignments. It is intentionally conservative. It does not resolve active/inherited/mandatory roles, proxy privileges, authentication plugins, dynamic privileges unknown to its allowlist, host-matching precedence, or grants on individual tables/routines/views; it checks the account returned by `CURRENT_USER()` and its `SHOW GRANTS` output only. Treat an `ok` result as a narrow static screen, **not a complete effective-privilege proof**. A DBA must review role activation/inheritance and exact effective privileges using the target engine/version, repeat the check for all relevant hosts/accounts, and assess migration and backup accounts separately. Do not put credentials on the command line or commit them.

## 5. Operational runbooks

### Backup failure

1. Acknowledge and record alert ID, UTC/local timestamps, release SHA, backup job/run ID, and affected target without recording secrets or customer data.
2. Do not delete or overwrite the last known-good archive. Restrict access to failed artifacts and logs.
3. Check scheduler status, storage capacity/availability, DB connectivity, backup tool exit code/version, permissions, archive checksum, and redacted logs.
4. If the failure is transient, retry only through the approved idempotent process after confirming it will create a new uniquely named artifact. Do not change retention or erase older backups to make room without owner approval.
5. Notify the named backup owner if a required recovery point is missed. Record missing interval and residual risk. Resume only after a verified artifact and restore-test plan are in place.

### Database outage

1. Confirm alert from independent probe and application health endpoint; capture time, error class, release SHA, and impact scope.
2. Check DB provider status/connectivity, host/DNS/TLS, connection limits, disk, recent approved changes, and application pool saturation. Do not print credentials or query customer records for diagnosis.
3. Do not run migrations, destructive SQL, failover, credential rotation, or restore without the designated owner/DBA authorization and a recovery/rollback plan.
4. Preserve application and DB logs; communicate degraded checkout/payment/admin behavior to the incident owner. Avoid replaying payments or financial actions until idempotency/reconciliation is verified.
5. After service recovers, verify health and migration status read-only, monitor errors, and reconcile payment/COD/settlement exceptions using existing immutable evidence. Document start/end and owner sign-off.

### Restore (production is not authorized by this runbook)

1. Identify the incident, target, approved recovery point, expected impact, and named approvers. Confirm owner-approved RPO/RTO and retention policy exist; otherwise stop and escalate.
2. Confirm artifact authenticity/checksum, encryption/access, database engine/version compatibility, required keys, and compatible application release. Verify upload/document artifacts separately.
3. Rehearse on an isolated disposable schema/storage target using the matching engine. Verify schema objects, essential rows, referential integrity, row counts/checksums, migration ledger, and application health.
4. For any proposed production restore, obtain explicit scoped approval, maintenance/traffic controls, pre-restore backup, recovery plan, and communication approval. No production restore is authorized by this project task.
5. After approved recovery, validate health and critical customer/admin workflows without real payment/courier actions. Finance owners reconcile any in-flight payments, COD, refunds, and settlements; retain discrepancies and audit evidence.

### Application outage

1. Confirm external HTTP/TLS and `/health`; identify whether outage is process, proxy, DB, storage, or dependency-related. Record request IDs and release SHA.
2. Check process manager status, restart loop, resource limits, disk, logs, and recent approved release. Do not expose stack traces publicly or disable CSRF/RBAC/session protections to restore service.
3. If a code rollback is approved, verify database schema compatibility first; prefer a previously verified code release. Do not run down migrations or restore an older DB as a routine code rollback.
4. After recovery, run smoke checks for storefront, authentication, admin access denial/RBAC, cart and order reads using non-production accounts/data, and ensure monitoring is stable.

### Security / data incident response

1. Declare incident through owner-approved channel; preserve logs, append-only audit evidence, and timestamps. Restrict access only under approved incident authority.
2. Do not delete, rewrite, or heuristically classify business/financial/audit records. Do not copy customer data into tickets or chat.
3. Have authorized security/DB owners assess scope, access logs, credentials, affected releases, and applicable notification/legal obligations. Rotate/revoke secrets only through the approved secret-management process.
4. Contain using least-disruptive approved controls. Record every action/actor/reason. Restore only from a verified clean artifact after the incident lead approves.
5. Reconcile payment/COD/settlement ledgers independently; do not issue refunds/payouts or edit balances as an incident shortcut. Preserve evidence and produce a reviewed post-incident report.

## 6. Repository-verifiable work vs host/provider-only verification

| Can be checked in this repository/CI | Cannot be established without approved host/provider configuration |
|---|---|
| Health handler contract and redaction; backup script safety and failure classification; grant analyzer unit cases; migrations/tests on disposable CI engines; workflow reporting and test results. | Production DB version/hostname/TLS/grants; cloud/host backup scheduling, encryption, archive durability and restore access; upload/vendor-document backup; actual restore duration and RPO/RTO; alert delivery/escalation; process manager/proxy/TLS behavior; cron availability, cadence and identity; provider-specific monitoring/backup APIs; production financial/payment/COD reconciliation. |

The right column is **NOT VERIFIED** until an owner authorizes and an operator records evidence from the real target or a provider-equivalent isolated staging setup. CI success cannot change that classification. Never substitute production data or credentials for the disposable tests.

## 7. Launch gates and evidence

Require exact-SHA `npm run verify`, MySQL 8.0 and MariaDB 10.11 migration/integration evidence where supported, Browser E2E, successful disposable restore drill on both engines, reviewed grants for all service accounts, tested monitoring/alerts and job heartbeats, and owner-approved decisions above. CI passing does not prove provider-specific hosting, off-site backup, alert delivery, legal retention, financial reconciliation, or production readiness.
