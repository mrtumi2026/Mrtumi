# Phase F — Production Readiness Checklist

**Status: NOT READY / BLOCKED.** This checklist defines evidence and acceptance criteria; checking a row requires linked, reviewable evidence and the named owner’s acceptance. A blank box is not approval. Do not put credentials, customer data, tokens, or private contact details in this file.

Companion register: [`PHASE_F_OWNER_DECISIONS.md`](PHASE_F_OWNER_DECISIONS.md). Operational scope and runbooks: [`PHASE_F_OPERATIONS.md`](PHASE_F_OPERATIONS.md).

## A. Owner-approved recovery objectives

| Gate | Current status | Acceptance criteria | Evidence to attach | Decision / limitation |
|---|---|---|---|---|
| Backup cadence | **BLOCKED — owner decision** | Approved schedule and missed-run handling exist for required DB and file data. | Policy approval; scheduler config; dated successful backup history and alerts. | Frequency is intentionally unspecified; do not claim a recovery-point guarantee. |
| Retention and archive handling | **BLOCKED — owner decision** | Duration, archive/deletion rules, legal holds, access and exception authority are approved and configured. | Approved retention policy; provider lifecycle evidence; audit/access review. | Do not delete or expire business/financial/audit records under an assumed policy. |
| RPO | **BLOCKED — owner decision** | Approved data-loss objective is mapped to backup/log coverage and measured in a recovery exercise. | Signed objective; coverage map; measured recovery point and review. | No RPO value is assumed or promised. |
| RTO | **BLOCKED — owner decision** | Approved service-recovery objective is measured in a timed end-to-end restore and application validation. | Signed objective; timed run logs and acceptance. | No RTO value is assumed or promised. |
| Storage/provider and data scope | **BLOCKED — owner decision + host evidence** | Provider, encryption/key custody, separation, access, artifact durability, upload/vendor-document scope and recovery access are approved and verified. | Provider/configuration evidence; access review; checksums/read-back; data inventory. | CI logical DB dump is not off-host backup or file/document protection evidence. |
| Restore-test frequency | **BLOCKED — owner decision** | Frequency, scope, isolated target, participants and success criteria are approved and demonstrated. | Approved plan; dated restore report; follow-up/remediation record. | No production restore is authorized by this checklist. |

## B. Monitoring, response and scheduled jobs

| Gate | Current status | Acceptance criteria | Evidence to attach | Decision / limitation |
|---|---|---|---|---|
| Application/DB health | **PARTIAL — code contract only** | `/health` and `/api/v1/health` are monitored externally; status, TLS and latency alerts are tested. Readiness claims are not based on these endpoints alone. | Exact-SHA test; host/provider probe configuration; successful and failed probe notification evidence. | The endpoints do not verify migration state, jobs, payment, upload durability, COD or settlement. Host/TLS/proxy behavior is not verified here. |
| Alert thresholds | **BLOCKED — owner decision + provider evidence** | Owners approve values/windows/severity and operational rules for application, DB, jobs, payments/COD, backup and security signals; alert delivery is tested. | Approved threshold matrix; provider rule export; delivery and acknowledgment exercise. | No thresholds or notification provider are invented. |
| Escalation / responsible persons | **BLOCKED — owner decision** | Named primary/secondary functional responders, incident authority, coverage and escalation route are recorded in the controlled on-call system. | Approved roster location; test page/notification evidence; exercise outcomes. | No person/team or response time is assumed; this file must not contain private contacts. |
| Job inventory and cadence | **BLOCKED — owner decision + host/provider evidence** | Every required job has approved cadence/window, owner, run-as identity, lateness tolerance, dependencies and independent heartbeat. | Signed inventory; scheduler export; least-privilege identity review; successful run history. | Present command-line scripts do not prove a scheduler is configured. |
| Job failure/retry | **BLOCKED — owner decision + exercise** | Per-job failure, alert, lock, retry, idempotency, stop/recovery and reconciliation rules are approved and failure-tested. | Failure-injection report, run logs, retry/idempotency evidence and owner acceptance. | Do not blindly replay payment, settlement, cleanup or other financial operations. |
| Incident response | **BLOCKED — owner decision + host/provider exercise** | Incident lead, communications, evidence preservation, security/DB/finance escalation and restore authority are approved and exercised. | Approved response plan; tabletop/technical exercise; reviewed action log. | Repository guidance alone does not verify provider escalation or actual response readiness. |

## C. Database permissions and financial controls

| Gate | Current status | Acceptance criteria | Evidence to attach | Decision / limitation |
|---|---|---|---|---|
| Runtime DB principal | **BLOCKED — DBA verification** | Dedicated application principal has only DBA-approved runtime privileges on the intended schema; effective direct/inherited grants and account-host matching are reviewed. | Redacted grants and active-role analysis for target version; `npm run db:privileges:check`; negative tests; DBA approval. | The checker is intentionally incomplete; a green result is not proof of effective privileges. No production DB identity was inspected. |
| Migration/backup/restore principals | **BLOCKED — DBA verification** | Separate accounts, scoped privileges, operator controls, expiry/rotation and target boundaries are approved and verified. | Version-specific grants/role expansion; isolated execution evidence; access audit and DBA sign-off. | No global DDL/admin/backup grants are presumed. Production DB operations remain outside this task’s authorization. |
| COD reconciliation | **BLOCKED — finance/business owner decision** | Source documents, matching keys, timing, discrepancy classes, dual review, correction authority and escalation are approved; record preservation is demonstrated. | Approved SOP; synthetic test; immutable ledger/audit validation; owner acceptance. | Unit tests are not real remittance reconciliation. Do not auto-clear discrepancies, alter ledger, mark reconciled or release funds. |
| Payment/financial exceptions and settlement | **BLOCKED — finance/business owner decision** | Handling of pending/failed/unmatched/duplicate/late events, refunds/reversals, payout verification, settlement exceptions and independent approval is documented and tested without real funds. | Approved exception matrix; synthetic cases; audit/ledger checks; segregation-of-duties evidence; owner approval. | Do not invent commission, hold, refund, payout or settlement policy. No live payment/refund/payout was tested. |

## D. Technical evidence and launch gate

| Gate | Current status | Acceptance criteria | Evidence to attach | Decision / limitation |
|---|---|---|---|---|
| Migration sequence and database CI | **BLOCKED** | No duplicate migration versions; fresh install, supported upgrade, rollback/reapply and application integration tests pass on MySQL 8.0 and MariaDB 10.11 where supported. | Exact-SHA CI artifacts/logs for both engines and migration status; reviewed migration sequence. | Active Arena branch has duplicate `0028`; current DB CI cannot be accepted as PASS. Do not bypass/ignore migration failure. |
| Full application verification | **BLOCKED** | Exact-SHA `npm run verify` passes with failures/skips explained; required security and regression tests are reviewed. | Exact-SHA workflow/test artifacts and triaged skip list. | Previous run has migration-collision failures; focused Phase F tests are not a substitute. |
| Browser E2E / workflows | **BLOCKED** | Customer, Admin, Vendor and other required workflows pass on both supported disposable DB engines; screenshots/logs reviewed and cleanup confirmed. | Exact-SHA Browser E2E artifacts per engine; review sign-off. | Current browser journeys stop before running due migration collision. No production user data or live provider action is permitted for the rehearsal. |
| Backup/restore rehearsal | **BLOCKED — not executed on engines** | On disposable MySQL 8.0 and MariaDB 10.11 schemas, backup and restore both complete; schema objects, essential records, row-content hashes and integrity checks match; failure cases never produce PASS. | Per-engine artifact with server/client versions, checksums, row/schema comparison, integrity results and test logs. | CI step is configured but skipped when migration prerequisites fail. The harness is destructive to its explicitly guarded disposable schema only. |
| Monitoring/host acceptance | **NOT VERIFIED — host/provider-only** | Independent monitors, tested alert routing, provider/host recovery access, scheduler/cron, TLS/proxy/process behavior and log access meet approved decisions. | Host/provider config exports, alerts/exercise logs, host-specific staging report and owner sign-off. | Cannot be established by repository code or green CI alone. |
| Release identity and approval | **BLOCKED — owner decision** | The exact release SHA, all accepted evidence, remaining risks/expiry and accountable technical/operations/security/DB/finance/business approvals are recorded. | Signed release record linking immutable artifacts and risk acceptance. | No CI result alone authorizes production deployment or operation. |

## E. Final approval

Launch may be considered only after every applicable gate above is accepted with evidence, owner decisions in [`PHASE_F_OWNER_DECISIONS.md`](PHASE_F_OWNER_DECISIONS.md) are recorded, and any exception has an accountable approver and review/expiry date. No exceptions are pre-approved here.

- Technical owner acceptance: **NOT RECORDED**
- Operations/recovery owner acceptance: **NOT RECORDED**
- Security/DBA acceptance: **NOT RECORDED**
- Finance/business acceptance: **NOT RECORDED**
- Exact accepted release SHA: **NOT RECORDED**
- Production readiness: **NOT READY / BLOCKED**
