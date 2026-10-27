# Production Hosting & Deployment Runbook (Preparation Only)

**Project:** Mr. Tumi Grocery & Gift
**Status:** deployment is **NOT READY / NOT AUTHORIZED**. This document is a conditional runbook, not a deployment instruction executed against a live system. Phase 20 acceptance, disposable backup/restore rehearsal, target facts, and action-specific owner approval remain outstanding.
**Repository runtime contract:** `package.json` currently requires Node.js `>=22.5.0`; use a supported maintained Node release that satisfies this engine range and verify native/runtime compatibility on the selected host before release. Do not rely on older `18.x`/`20.x` assumptions in historical docs.
**Database contract:** production MySQL/InnoDB only; SQLite is prohibited.
**Secrets:** never commit, paste into chat, or place production values in this document.

---

## 1. What is known—and what is not

Prior owner-provided information recorded in `docs/CPANEL_COMPATIBILITY.md` says BestWebHostBD supports Node.js, SSH, and MySQL. This does **not** verify a particular account/plan, Node selector version, MySQL server version, Passenger/LiteSpeed mode, domain, TLS termination, backup retention, or available resource limits. No target hosting account was accessed during this work.

Before choosing the release procedure, record these facts and evidence (without sharing secrets):

| Fact | Required evidence before deployment |
|---|---|
| Provider, plan, account owner, staging/production targets | Owner-confirmed service/account details and approved target names |
| Node executable and version | `node -v`, `npm -v`, cPanel selector/runtime or service unit; verify Node `>=22.5.0` |
| Process manager/startup behavior | Confirm cPanel Passenger/LiteSpeed, or approved VPS systemd/reverse-proxy design; identify assigned port and restart/log behavior |
| MySQL server/version and limits | `SELECT VERSION()`, InnoDB/utf8mb4 availability, connection cap, database host/network policy |
| Domain and TLS | Exact canonical HTTPS origin, certificate/renewal operator, proxy path and trusted proxy-hop count |
| Persistent uploads | Writable durable path, symlink/alias rules, static URL mapping, quota and backup coverage |
| Cron/scheduled tasks | Availability, minimum interval, run-as user, working directory, absolute Node path, log destination |
| Resource/operations | RAM, CPU/process/entry-process, inode, storage and transfer limits; maintenance window and contacts |
| Backup and restore | Backup destination/access separation, retention/RPO/RTO decisions, restore destination and tested procedure |

Do not assume cPanel or Passenger merely from the provider name. The two supported deployment patterns below are options pending these facts.

## 2. Hosting patterns to evaluate

### Option A — Managed cPanel/CloudLinux Node application

Use only if this account confirms the Node selector supports the package engine and confirms the startup mechanism. `app.js` is the repository's Passenger/LiteSpeed-oriented entry point, but the actual panel configuration and process lifecycle must be verified. Preserve `public/` static serving; map custom uploads to durable storage using the host's confirmed symlink/alias support. Do not assume the default port or `tmp/restart.txt` behavior until confirmed.

### Option B — VPS/container with a reverse proxy

Use only if the owner selects and operates this platform. Run the app as a dedicated unprivileged service account, bind Node only to a private interface/socket behind a maintained HTTPS proxy, keep MySQL private, and use a supervised service manager. The exact proxy, service unit, firewall, certificates, backup destination, and monitoring are host-specific and are not created here.

If neither option is confirmed to meet the runtime and database contract, deployment remains blocked; select an alternate Node `>=22.5.0` + MySQL host through the owner rather than lowering the engine requirement or adding SQLite fallback.

## 3. Release configuration inventory

Set environment values through the host's protected environment facility where available. If a root `.env` file is the only supported mechanism, keep it outside tracked releases when possible, owner-controlled, mode `0600`, unreadable by the web root, and never copy it into a public directory. The repository's dotenv loader reads the application-root `.env`; process environment takes precedence.

Required/important production values from `src/config/env.js` and `.env.example`:

- `NODE_ENV=production`
- `APP_URL=https://<owner-approved-canonical-origin>` — the exact origin is currently unknown; do not use localhost or a placeholder in a release.
- `HOST` and `PORT` according to the confirmed process manager. The app defaults to `0.0.0.0:3000`; Passenger/VPS may require a host-assigned port or private bind.
- `DB_CLIENT=mysql`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_CHARSET=utf8mb4`, `DB_TIMEZONE=+00:00`, and a conservatively sized `DB_CONNECTION_LIMIT` based on the host's actual user-connection cap.
- `SESSION_SECRET`: independently generated random value, at least 32 characters. `CSRF_SECRET`: explicitly set to a separate random value of at least 32 characters (the application can derive one from the session secret when absent, but production provisioning should set both separately).
- `TRUST_PROXY`: explicitly set to the verified number/topology of trusted proxy hops. The current default is `1`; do not retain it without verifying that the app is only reachable through that trusted proxy.
- `UPLOAD_DIR`: absolute durable storage base outside disposable release directories. The upload middleware writes under `<UPLOAD_DIR>/custom`; confirm a safe mapping from `public/uploads/custom` to that durable directory before enabling uploads. Do not store customer uploads in a release directory.
- `TZ=Asia/Dhaka`, `DEFAULT_LOCALE=bn`, `SUPPORTED_LOCALES=bn,en`, `CURRENCY_CODE=BDT`, `CURRENCY_SYMBOL=৳`.
- `ALLOW_PRODUCTION_DEMO_SEED=false` (production seed guard); do not enable demo/bootstrap data for a live shop.
- `ANALYTICS_ATTRIBUTION_ENABLED=false` unless D6/D8 approvals are separately recorded; provider secrets/IDs stay unset until approved and integrated.
- Configure only approved integrations. Empty/unconfigured provider values must remain fail-closed; do not copy sample credentials from `.env.example`.

Production configuration validation must be performed without echoing environment values or secrets. Confirm session cookies are `Secure`, `HttpOnly`, and correctly proxy-aware over HTTPS. Bangla remains the default locale; verify the English toggle separately.

## 4. Database and privilege plan (not executed)

1. Provision an empty **staging/disposable** MySQL database matching the verified production dialect, charset/collation, SQL mode, and InnoDB requirements. Confirm grants and connection limits in that disposable target first.
2. Separate principals where supported:
   - **Runtime account:** only required DML/SELECT privileges on the application's own schema; no global privileges, user creation, or routine administrative access. Derive and test exact privileges from repository queries and session-storage behavior before any production grant.
   - **Migration account:** temporary, owner-controlled schema DDL/index/trigger privileges needed for the reviewed migration set; never use it as the web process account. Revoke/disable after a migration if the host's controls allow.
   - **Backup account/operator:** read/backup privileges only, isolated from the web process and protected backup storage.
3. Run the complete migration up/status/down/re-apply lifecycle only on disposable CI/staging data. Review the exact pending migrations and checksums before release. Production migration requires its own explicit approval and backup/recovery plan; this runbook does not authorize it.
4. Never use destructive production `migrate:down` as a routine code rollback: down migrations can remove schema/data. Prefer backward-compatible expand/release/contract changes. Any restore or destructive schema operation requires explicit scoped approval and a tested, isolated rehearsal.

## 5. Conditional release procedure (owner approval required for every production change)

1. **Release candidate:** use an exact commit SHA, clean tree, exact-SHA passing GitHub Actions (including MySQL 8.0 suite), dependency/security checks, reviewed diff, and named approver. Do not deploy an Arena work branch directly unless the owner explicitly authorizes that exact target/commit; normal release branch/PR policy remains in force.
2. **Staging first:** configure staging with non-production secrets and isolated MySQL. Apply reviewed migrations there, verify migration status, run smoke/regression checks, test login/session/CSRF, storefront locale and representative cart/checkout (without a live payment provider), admin RBAC, uploads, logs, and restart behavior.
3. **Pre-release recovery point:** take a dated, access-controlled MySQL backup using a host-approved tool, and archive persistent uploads/configuration needed for recovery. Use encrypted storage and verify the file is readable/non-empty and checksum it. Do not put backups in Git or in a public web directory. Retention/RPO are still owner decisions; do not invent durations.
4. **Deploy code:** create a versioned release directory or atomic release pointer where the host supports it; install lockfile dependencies with `npm ci --omit=dev` under the correct Node runtime; protect environment configuration; keep writable uploads and logs outside disposable releases. Do not run `npm install` without the lockfile in production.
5. **Migration gate:** only after separate explicit authorization for the exact database and reviewed migration set, execute the repository's guarded migrator under the migration principal, then verify `migrate:status`. No migration was run as part of preparing this document.
6. **Restart and observe:** use the confirmed manager's graceful restart. Check process health, database reachability, startup/runtime logs, memory/process/connection limits, and host error logs. Never expose secrets or customer data in diagnostics.
7. **Smoke tests:** `/health` and `/api/v1/health` must return healthy MySQL status; check HTTPS redirect/canonical origin, certificate, secure session cookies, CSRF rejection, Bangla default + English switch, product/category pages, cart update/stock cap, customer/account boundaries, admin permission denial, and safe error responses. Place no live provider, payment, SMS, courier or refund calls during smoke tests.
8. **Go/no-go:** monitor error rates, DB pool saturation, latency, process restarts and upload write/read behavior against owner-approved thresholds. No thresholds or alert destination are currently supplied, so an operator must define these before production go-live.

## 6. Logs, health checks, uploads, cron and backup readiness

- The application emits structured, PII-redacting logs to stdout/stderr. Verify where the selected process manager captures them, log access controls, rotation, retention and alerting. No production log sink/retention choice is verified.
- Health endpoints are implemented; they check database health and report the configured client. External provider health and end-to-end business readiness are not implied by a healthy database result.
- `public/` is served by Express. Uploads are written under the configured `UPLOAD_DIR/custom`; validate the URL mapping, permissions, backup coverage, quota and malware/content handling on staging.
- Checkout inventory was rechecked on 2026-10-27: `scripts/cron-runner.js` and `scripts/backup.sh` are absent. Do not configure those nonexistent commands. `npm run reservations:expire` is a separate one-shot CLI, dry-run by default; its expected output, batch/partial-commit behavior, failure recovery and manual monitoring guidance are in [`docs/PHASE_08_ORDER_LIFECYCLE_OTP_ADVANCE.md`](docs/PHASE_08_ORDER_LIFECYCLE_OTP_ADVANCE.md). It has not been scheduled or run against production. Before relying on reservation/recovery cleanup or scheduled backups, implement and verify the needed runner/backup tooling, then confirm the host's cron facility and service account. No target hosting account, cron capability or backup service was accessed or verified for this review.
- No automated restore drill, backup script, production monitoring destination, or target-host smoke test is currently verified. These are Phase 20 release blockers.

## 7. Rollback and recovery (not a destructive database recipe)

- If code-only regression occurs and schema changes are backward compatible, switch/redeploy to the previous exact, verified release and restart using the confirmed manager; preserve logs and the failed release for diagnosis.
- If a schema/data incompatibility occurs, stop writes only under the approved incident procedure. Do not blindly run down migrations or restore an old database over new orders. Recovery must be based on the specific approved RPO/RTO, backup point, data reconciliation/loss analysis, and exact owner authorization.
- Restore rehearsals must use an isolated disposable destination first, verify schema/data counts and application health, and demonstrate the actual runbook. Production restore is a separately approved operation.

## 8. Owner inputs needed to convert this plan to deployment-ready

Provide/record, without sharing credentials: exact provider and plan/account; staging and production target; Node runtime >=22.5.0; MySQL flavor/version/charset/limits; process manager/startup/restart and proxy hop count; canonical HTTPS domain/TLS operator; durable upload path/URL mapping; cron availability and schedule limits; log/alert destination; backup storage/retention/RPO/RTO and restore operator; least-privilege account provisioning capability; migration window/approver; and explicit approval for each production operation. Until then, deployment preparation is complete only at the documentation level and **no live deployment is authorized or performed**.
