# Phase F — Application Operational Observability Audit

**Scope and evidence:** source/configuration review of Arena branch `b4df7b1` plus the non-courier change in this audit. No production database, hosting account, deployment, customer data, payment, or live service was accessed. `Verified` means directly present in the reviewed repository; it does not imply an actual host is configured. `Partial` means source provides only some of the needed behavior. `Missing` means no implementation/configuration was found in the reviewed repository. `Needs host verification` means repository evidence cannot establish real-provider behavior.

## 1. Background jobs, schedules and queues

The workflows currently in `.github/workflows/` run on push/pull-request triggers; no scheduled GitHub Actions workflow or production cron configuration is in the repository. No queue framework/worker process was found. The admin “Cron Jobs” settings surface is a UI/legacy route, not evidence of a scheduler.

| Job / queue-like mechanism | Status | Trigger and frequency | Owner | Failure and retry behavior | Evidence / operational caveat |
|---|---|---|---|---|---|
| Reservation expiry — `npm run reservations:expire` | **Verified** as one-shot CLI; **Needs host verification** for scheduling | Manual CLI invocation only in repository evidence. Dry-run by default; mutation requires `--apply`. Default candidate limit 100; configurable 1–1,000. No cadence is specified. | No operational owner recorded; owner decision required. | Sequential per-order transactions. A later failure can leave earlier orders committed. Process prints a message and sets a failing exit code; no in-run retry/backoff. Re-running queries only still-active expired reservations, so it is designed to be repeatable, but an interruption/re-run test on both DB engines is not established by this audit. | `scripts/expire-reservations.js`, `src/repositories/phase08Repository.js`. No scheduler, lock or external heartbeat is configured. |
| Matured settlement processor — `npm run settlements:process` | **Verified** as one-shot CLI; **Needs host verification** for scheduling | Manual invocation only in repository evidence. Dry-run by default; `--apply` required. Code default `returnWindowDays=7`; this is an implementation fallback, **not an owner-approved business policy**. Candidate query is capped at 500. No cadence is specified. | No operational owner recorded; finance/business owner decision required. | Applied run wraps the batch in one transaction; a raised failure aborts the transaction. No in-process retry/backoff or scheduling. Ledger idempotency keys protect repeat processing in source. Runner supplies a system actor; no administrator actor is passed. Do not infer that all desired operational audit/approval evidence exists from this. | `scripts/process-matured-settlements.js`, `src/repositories/partnerSettlementRepository.js`. Do not schedule or apply until return-window and financial controls are owner-approved. |
| Expired-session cleanup | **Partial** | Called opportunistically on approximately 1% of requests; this is request-sampling, not a time-based frequency/guarantee. | Application middleware; operational owner not recorded. | Asynchronous `purgeExpiredSessions(now).catch(() => {})` swallows failure; no retry or failure metric. Cleanup may be delayed indefinitely at low/no traffic. | `src/middleware/sessionManager.js`, `src/repositories/sessionRepository.js`. Table is DB-backed in MySQL; cleanup is best-effort. |
| `notification_queue` table | **Missing** consumer/worker | Schema has a queued status and `next_attempt_at`; no producer/consumer/worker SQL use was found outside the migration. No processing cadence. | None recorded. | No claim of retry or delivery can be made; no consumer or queue failure handling found. | `src/db/migrations/0003_orders_payments_and_operations.up.sql`; repository search found no queue worker/processor. Treat rows as unprocessed until implementation and evidence exist. |
| Vendor OTP SMS | **Verified** synchronous request, not a background job | Invoked during request flow only when explicitly enabled/configured; one outbound request with an 8-second default timeout, clamped to at most 15 seconds. | Vendor onboarding application path; operations owner not recorded. | Timeout/provider refusal returns a generic conflict. No background retry queue or durable dispatch/reconciliation was found. The generic failure path does not emit a dedicated operational metric/alert. | `src/services/vendorOtpDelivery.js`. No live provider request was made; provider/host egress is **Needs host verification**. |
| Migrations, category seeding, backup rehearsal, DB privilege check, browser E2E | **Verified** manual/CI tools, not production schedulers | Invoked explicitly by operator or CI; no schedule in repository. | Operator/CI; production owner not recorded. | Individual command behavior varies; CI failures should remain visible. These tools are not recurring background workers. | `package.json`, `scripts/`, `.github/workflows/`. |

**Inventory conclusion:** there is no general-purpose scheduler, queue worker, retry service or production job registration in the reviewed repository. No job cadence, operator identity, job lock, alert, last-success heartbeat or host-side schedule has been verified.

## 2. Health and dependency checks

| Finding | Status | Audit result |
|---|---|---|
| `/health` and `/api/v1/health` | **Verified** | Both are unauthenticated endpoints. Return application name, environment, timezone/locale/currency, process uptime, database client/status/latency; DB unhealthy response is HTTP 503. No secret values are returned in the response contract reviewed. |
| MySQL ping | **Verified / Partial** | `pingPool()` does `SELECT 1` with a five-second race timeout and sanitized DB error classes. It checks connectivity, not migrations, session-table readiness, schema correctness, pool saturation trend or application data invariants. Timeout does not cancel the underlying pool query; this remains a limitation. This audit also fixes clearing the timeout timer on both success and failure. |
| SQLite health path | **Verified** for local/dev/test code | Uses `SELECT 1`; production config prohibits SQLite. Not evidence of production health. |
| External dependencies | **Missing** from health/readiness | No payment gateway, SMS, mail, upload storage, queue, scheduler, backup archive, COD or settlement health probes were found in health endpoints. Do not add mutating provider checks to liveness. |
| Readiness separation | **Missing** | No distinct readiness endpoint that checks required schema/job freshness/dependency policy was found. Current health endpoint is liveness + DB ping, not a complete readiness signal. |
| Host monitoring/probe delivery | **Needs host verification** | No deployed probe, uptime monitor, alert provider, route, threshold or successful notification evidence is in this repository. |

## 3. Logging and error handling

| Finding | Status | Audit result |
|---|---|---|
| Structured application logs | **Verified / Needs host verification** | `src/utils/logger.js` emits timestamped JSON to stdout/stderr, redacts common secret-key fields and masks Bangladesh phone patterns. Where the actual host stores, rotates, restricts and alerts on these streams is **Needs host verification**. |
| HTTP 5xx errors | **Verified / Partial** | Central error handler logs request ID, method, original URL, code and error; DB errors log safe code/context plus DB driver message. Persistent `error_logs` write is best effort. Failure is swallowed in `.catch(() => {})`, so DB error-log persistence can silently fail; stdout/stderr log is the remaining path if host capture works. |
| Sensitive-data risk in error metadata | **Partial / Needs review** | Key-based redaction and phone masking are implemented, but `originalUrl` may contain query parameters, and free-form error messages/DB driver messages are not a general PII/token scrubber. No production log samples/config were inspected. Avoid secrets/PII in URLs and exception messages; use a host log access/retention review. |
| Operational 4xx | **Verified** | Logged as warnings with request ID/method/path/status/code, without full exception object. They are not necessarily alert-worthy and no threshold/router is configured. |
| Background-job failures | **Partial** | Reservation/settlement CLIs print error messages to stderr and set nonzero exit status. No structured job run ID, duration, start/finish heartbeat, persisted job result, retry counter or alert exists. Raw CLI argument values may be included in unknown-argument errors; do not pass secrets as arguments. |
| Session persistence/cleanup failures | **Partial** | Main save/render/json/redirect paths propagate errors to request handling, but `res.end` persistence fallback and sampled expired-session purge use empty catches. These failures can disappear without a dedicated metric/log. |
| Payment/COD failure monitoring | **Missing** as operational alerting | Business records/reconciliation paths exist, but no independent failure/age metrics, alert thresholds, dashboards or reconciliation-job heartbeat were found. No real payment/COD was tested. |
| Error process events | **Missing** explicit application handlers | No app-level `uncaughtException`, `unhandledRejection`, process-fatal reporting or restart policy implementation found. Runtime default behavior is not a verified alert/recovery strategy. Do not install handlers that swallow fatal errors. |

## 4. Shutdown, interruption and recovery

| Finding | Status | Audit result |
|---|---|---|
| HTTP graceful shutdown | **Missing** | `startServer()` returns the Node HTTP server, but no SIGTERM/SIGINT handler calls `server.close()` or stops accepting work. The web process does not explicitly close the MySQL pool on graceful termination. Host/process-manager draining and kill timing are **Needs host verification**. |
| One-shot CLI pool cleanup | **Verified / Partial** | Migration, seed, reservation and settlement scripts call `closePool()` in `finally` (or equivalent). This helps normal completion; forced termination can still interrupt work. |
| Reservation job interruption | **Partial** | Each candidate order is committed independently. A crash can leave a partially processed batch; the next manual run reselects active expired reservations. No schedule/lock/heartbeat or formal two-engine interruption test is present. |
| Settlement job interruption | **Partial** | Processing occurs inside one DB transaction. Normal errors roll back, but process/connection termination outcome depends on DB connection/transaction cleanup; no recovery drill exists. Re-running is designed around idempotency keys, but operator restart procedure is not configured. |
| Session cleanup interruption/failure | **Partial** | Best-effort request-triggered cleanup can be skipped without affecting request outcome; no indication/alert exists. |
| Notification queue recovery | **Missing** | There is no consumer, retry state transition, stale-item alert or replay procedure found. |
| Host restart behavior | **Needs host verification** | No specific process manager, signal delivery, restart limits/backoff, health restart policy, log drain or kill timeout has been observed on the target host. |

## 5. Monitoring and alerting: actual state

**Verified in source:** limited process uptime + DB `SELECT 1` health response, centralized request 5xx logging, and command exit codes for two one-shot jobs.

**Missing in repository:** metrics/telemetry exporter, job heartbeat/run ledger, scheduler/queue worker, queue consumer, alert rules/destinations, payment/COD/settlement exception thresholds, backup freshness reporting, dependency/readiness checks, process lifecycle hooks, and operational dashboards.

**Needs host verification:** external HTTP/TLS probes, process manager restart and signal behavior, stdout/stderr capture and rotation, database host/pool limits, cron availability/run-as/working directory/environment, provider alert routing, persistent upload/log/backup storage, and contact/escalation response. No production host or alert channel was accessed.

## 6. Owner decisions and operational gates

Read alongside [`PHASE_F_OWNER_DECISIONS.md`](PHASE_F_OWNER_DECISIONS.md), [`PHASE_F_OPERATIONS.md`](PHASE_F_OPERATIONS.md), and [`PHASE_F_PRODUCTION_READINESS_CHECKLIST.md`](PHASE_F_PRODUCTION_READINESS_CHECKLIST.md).

- Owner decisions remain required for cadence/retention/RPO/RTO, monitoring thresholds and responders, required job inventory/cadence/retry, runtime/migration/backup DB identities, and financial exception/COD handling.
- Before a job is scheduled: name the business/technical owner; approve cadence and impact window; specify idempotent behavior, locking/concurrency, retry/stop policy, exit/heartbeat evidence, alert route and a disposable interruption test. These fields are not filled by this audit.
- Before treating logs/health as monitoring: configure the actual host/provider destination and external probes; test both success and failure notification; review redaction, access, rotation and retention with the owner.
- Until independently verified, operational controls are **Partial**, **Missing**, or **Needs host verification** as assigned above; no owner decisions or production readiness are inferred.
