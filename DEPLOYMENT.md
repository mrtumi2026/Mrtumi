# Production Hosting & Deployment Runbook — Preparation Only

**Project:** Mr. Tumi Grocery & Gift
**Status:** **NOT READY / NOT AUTHORIZED.** This is a conditional preparation runbook, not deployment approval. No production cPanel account, domain, database or customer data was accessed. No production code upload, DNS change, migration, provider operation or destructive command was performed.
**Canonical phase:** Hosting and release gates are tracked under **Phase 20** (`P20-03`), not Phase 19. The master backlog defines Phase 19 as the customer/admin Android WebView apps; it remains `NOT STARTED`.
**Repository runtime contract:** Node.js `>=22.5.0` (`package.json`). The requested host target is Node.js `22.23.4`; CI now pins this exact version for both MySQL 8.0 and a separate MariaDB 10.11 compatibility job. The local preparation environment is Node `22.22.3` / npm `10.9.8`, not the requested patch; the actual host runtime is unknown. The project does not pin an npm engine/version, and `package-lock.json` is lockfile v3. Production persistence is MySQL/InnoDB; SQLite is non-production only. See [`docs/CPANEL_HOST_VERIFICATION_CHECKLIST.md`](docs/CPANEL_HOST_VERIFICATION_CHECKLIST.md) for owner evidence collection.
**Secrets:** never commit, paste into chat, log, or place production secrets in this document.

## 1. Verified project facts versus hosting facts still unknown

**Owner-provided capability claims** recorded in `docs/CPANEL_COMPATIBILITY.md`: BestWebHostBD support was reported to offer Node.js, SSH and MySQL. These claims do not establish the customer's plan, control-panel build, features, runtime selector, startup lifecycle or limits.

**Verified from repository source:** `server.js` constructs the Express/EJS app and `startServer()` listens using configured `HOST`/`PORT` (defaults `0.0.0.0:3000`). `app.js` is the candidate deployment wrapper and exports the Express app; its direct/Passenger-indicated startup calls `startServer()` only after production config validation. Direct `server.js` development startup is rejected; `scripts/dev-server.js` is the explicit local development entry. `package.json` has `main: server.js`, `start: node --no-warnings app.js`, `dev: node --no-warnings scripts/dev-server.js`, and Node `>=22.5.0`. The startup script no longer installs packages. `package-lock.json` uses lockfile version 3. A non-production regression test exercises `app.js` with an assigned host/port and an external persistent upload root. These are code facts, not proof that a particular cPanel account launches the app in this way.

**Not verified on the host:** cPanel/CloudLinux version; whether “Setup Node.js App” is present and which Passenger/LiteSpeed integration it uses; supported Node/npm binaries; startup-file field semantics; port/socket injection; environment editor; application-root restrictions; restart/log behavior; MariaDB availability; database version, SQL mode, connection cap and grants; HTTPS/proxy topology; cron; storage/symlinks; backup/restore and resource limits. Obtain the actual cPanel screen/version and non-secret runtime output from the owner/host before selecting final settings. Do not infer these details from provider name or generic Passenger examples.

| Required fact | Non-destructive evidence to record before staging/release |
|---|---|
| Provider, plan, target account and cPanel/CloudLinux version | Owner-confirmed plan plus exact control-panel version/features; staging target identified |
| Node and npm | `node -v`, `npm -v` from the same selected application runtime; requested Node target is `22.23.4` (repository engine minimum `>=22.5.0`); CI exact-version results are separate from actual host verification |
| Startup/process manager | Exact panel option and startup-file behavior; assigned port or socket, environment injection, restart and log behavior |
| Database dialect | `SELECT VERSION()`, InnoDB, `utf8mb4`, collation/SQL mode, connection limit and host/network reachability |
| Domain, TLS, proxy | Approved HTTPS origin, TLS termination, exact trusted proxy-hop topology and forwarding headers |
| App/storage paths | Application-root location, writable durable upload path, URL mapping/permissions/quota and backup coverage |
| Operations | Cron availability/minimum interval/run-as user; process, memory, inode/storage limits; logging/alerts |
| Recovery | Backup tool/destination/access separation, owner-approved retention/RPO/RTO and an isolated restore rehearsal |

## 2. Conditional cPanel configuration (confirm interface first)

If the target account actually provides cPanel **Setup Node.js App** (or its documented equivalent), evaluate these values in the real panel only after confirming its version and behavior:

- **Application root:** use a private directory outside `public_html` when supported, for example a non-public home-directory release path. Keep `.env`, `node_modules`, source, logs and backups out of the document root. Do not assume a symlink or alias is permitted.
- **Startup file:** source identifies `app.js` as the deployment wrapper; it requires `NODE_ENV=production` and valid production configuration before listening. `server.js` contains Express setup and exports `startServer()`. Select `app.js` only if the actual panel expects a Node entry file with these semantics; verify the panel's contract first. `package.json` `main` remains `server.js` and `npm start` invokes `app.js`.
- **Runtime:** target Node.js `22.23.4` as requested, then record `node -v` and `npm -v` in the selected app runtime. The repository engine minimum is `>=22.5.0`, but that does not verify the host patch release. CI pins both database jobs to `22.23.4`; local preparation is `22.22.3` / npm `10.9.8`, so it does not substitute for host proof. The repo does not set an npm engine/version. The lockfile is version 3, so prove `npm ci` works in the actual host runtime; do not guess an npm major version.
- **Port and host:** app code reads `PORT` and `HOST`, defaulting to `3000` and `0.0.0.0`. Do not assume cPanel assigns `PORT`, expects a TCP listener, injects a Passenger global, or accepts these defaults. Confirm the panel contract; test the configured listener and restart on isolated staging.
- **Environment:** provide `NODE_ENV=production` and required settings through the panel's protected environment mechanism where available. If only a root `.env` is supported, keep it outside `public_html`, owner-controlled, mode `0600`, and outside tracked releases where feasible; the dotenv loader gives process environment precedence. Never place secrets in source, logs, URLs or a public path.
- **Restart:** use only the panel-documented graceful restart/redeploy method after verifying it. Do not assume `tmp/restart.txt`, Passenger commands, SSH process managers or a restart button without confirming the installed integration.

`app.js` has a guard against ordinary development startup; it allows test-mode import for tests, with explicit opt-in required if a test process actually starts it. Production entry starts only after configuration validation. This protects against silently treating an unset/default development mode as a production startup through `app.js`; it does not prove the panel selects `app.js` correctly.

## 3. Dependency installation and application configuration

Install from the repository root using the same Node/npm runtime selected for the application:

```sh
node -v                 # must be >= 22.5.0
npm -v                  # record actual version; no npm engine is declared
npm ci --omit=dev --no-audit --no-fund
```

Use the committed lockfile; do not run `npm install` in a production release or rely on automatic installation at app startup. For local development use `npm ci` then `npm run dev`; `npm start` runs the deployment entry `app.js` and is not a substitute for setting production configuration.

The production validator now fails before serving when required or unsafe settings are missing. It reports variable names only, not supplied values. Required production configuration:

- `NODE_ENV=production`; `DB_CLIENT=mysql` explicitly (production SQLite is prohibited).
- `APP_URL` must be the approved HTTPS origin, not localhost or a path-bearing URL.
- `DB_HOST`, `DB_PORT` (integer 1–65535), `DB_NAME`, `DB_USER`, and non-placeholder `DB_PASSWORD` must be explicitly supplied. Charset defaults to `utf8mb4`; timezone defaults to `+00:00`. Set `DB_CONNECTION_LIMIT` conservatively from the verified host cap (repository default is 10; pool is capped at 50).
- `SESSION_SECRET` and `CSRF_SECRET`: distinct random secrets, each at least 32 characters; provide both explicitly. Never expose values in diagnostics.
- `TRUST_PROXY`: explicit non-negative integer matching the verified proxy hops/topology. No host topology is assumed.
- `UPLOAD_DIR`: absolute path outside the application root; uploaded files are written to `<UPLOAD_DIR>/custom` and served at `/uploads/custom/`. Provide a durable writable location and verify its URL/read behavior, permissions, quota and backup coverage on staging.
- `TZ=Asia/Dhaka`, `DEFAULT_LOCALE=bn`, `SUPPORTED_LOCALES=bn,en`, `CURRENCY_CODE=BDT`, `CURRENCY_SYMBOL=৳` as project defaults/configuration.
- `ALLOW_PRODUCTION_DEMO_SEED=false`; keep demo/bootstrap data disabled. Keep `ANALYTICS_ATTRIBUTION_ENABLED=false` unless the relevant owner decisions are recorded. Do not set unapproved provider credentials.

Other values in `.env.example` are templates, not host facts or credentials. The repository's cookie middleware uses `HttpOnly`, `SameSite=Lax` and `Secure` in production. Confirm HTTPS is enforced at the edge and that Express `trust proxy` is set only to the verified proxy configuration; CSRF remains required for admin/customer state-changing requests. Do not disable CSRF or secure-cookie behavior to work around proxy misconfiguration.

## 4. MySQL/MariaDB and migrations

- MySQL 8.0 remains the project's production database contract; its CI job does not prove MariaDB compatibility. A separate CI job now targets MariaDB 10.11 and runs the individual migration diagnostic, complete up/status/down/reapply lifecycle, and automated application test suite on the disposable service, pinned to Node.js 22.23.4. Its exact-final-SHA result is pending until the workflow completes; even a pass is evidence for the CI MariaDB image/configuration only, not the cPanel host. If the host offers MariaDB, record its exact version/settings, compare them with the tested 10.11 service, run the full lifecycle and relevant integration suite in isolated staging, inspect SQL differences, and obtain owner acceptance before treating it as supported.
- Do not lower engine/database requirements based on a generic cPanel label. If the actual account cannot provide a verified compatible MySQL target, deployment remains blocked; obtain owner authorization for another host or an explicit compatibility project.
- Use separate accounts where the service supports it: narrowly scoped runtime DML/SELECT account, a controlled migration account with only reviewed schema privileges, and a separate backup operator/account. Derive exact grants from actual queries/session storage on a disposable DB; do not grant global privileges or use the migration account for web traffic.
- Use `npm run migrate:status` for inspection. `npm run migrate:up` is only for reviewed non-production/staging or an explicitly approved production change. `npm run migrate:down` can destroy schema/data; never use it as a routine production rollback. No production migration or data access is authorized here.

## 5. Sessions, health, logs, storage and scheduled tasks

- Sessions are persisted in the application database (`web_sessions`), not an in-memory process store. Production session cookies are `HttpOnly`, `Secure`, `SameSite=Lax`; session and CSRF secrets are validated. Verify proxy-aware HTTPS and login/session renewal on staging. Health responses report operational status but no secrets; `/health` and `/api/v1/health` check database reachability, not full business readiness or external integrations.
- Express serves `public/` static assets. The configured `UPLOAD_DIR/custom` root has an explicit `/uploads/custom/` static fallback so an external durable upload root can be used without requiring the upload files to live in a disposable release. Test upload-write then HTTP-read on staging; ensure uploads are not exposed through an unintended broader directory mapping.
- Structured, redacted application logs are emitted to stdout/stderr. Confirm where the selected cPanel/process integration captures them, access controls, rotation, retention, and alerts. Never log env values or customer payloads. No production log destination or retention is verified.
- `scripts/cron-runner.js` and `scripts/backup.sh` are absent. Do not configure either nonexistent command. `npm run reservations:expire` is a separate one-shot CLI, dry-run by default; it has not been scheduled or run against production. Before relying on reservation cleanup or scheduled backup, implement and verify a dedicated idempotent runner/backup procedure, then confirm cron availability, minimum interval, working directory, absolute Node path, run-as account, locking, logs and failure alerts. Do not add in-memory timers to a Passenger-managed web process.
- Backups must include MySQL data, durable uploads, and owner-controlled configuration needed for recovery, stored encrypted/access-controlled outside the web root. No backup script, backup service, restore drill, retention period, RPO/RTO or provider capability is verified. Those policies require owner input; do not invent them. Restore rehearsal must target an isolated disposable database/storage location and prove the documented restore/health procedure before release.

## 6. Staging smoke tests and release/rollback gates

Use the linked [`docs/CPANEL_HOST_VERIFICATION_CHECKLIST.md`](docs/CPANEL_HOST_VERIFICATION_CHECKLIST.md) with the owner to establish the actual interface before interface-specific configuration. On isolated staging only, with non-production secrets and disposable MySQL data:

1. The owner creates a new, empty staging schema and staging-only credentials; confirm the target hostname/schema explicitly before any command. Never import, copy, or synthesize from customer/production data. Keep a separate staging uploads directory and separate staging secrets; do not reuse production credentials.
2. Record `node -v`, `npm -v`, host/cPanel version, startup settings, actual process port behavior, database `SELECT VERSION()`, storage path and proxy topology. Verify `npm ci --omit=dev --no-audit --no-fund` from the lockfile.
3. Run `npm run migrate:status`; review and apply migrations only to the isolated staging database. Verify the resulting schema and application startup; do not use production data.
4. Check `/health` and `/api/v1/health` return healthy database status; verify app logs contain no secrets. Confirm process restart/redeploy and failure/recovery behavior via the actual host UI.
5. Verify canonical HTTPS/TLS, secure session cookie flags, login/logout/session renewal, CSRF rejection and admin RBAC denial. Verify Bangla default and English switch, product/category pages, cart stock cap and customer/admin route boundaries.
6. Test a non-sensitive raster upload to the configured durable path, HTTP read-back through `/uploads/custom/`, and persistence across an app restart/release replacement. Do not upload real customer content during preparation.
7. Exercise only mock/no-op payment, courier, SMS and notification behavior. No live provider calls, payments, refunds, bookings or sends.
8. Rehearse backup and restore into isolated disposable targets; verify checksums, migration state, upload read-back and health. Define and approve monitoring thresholds and go/no-go owner before any production plan.

A release requires an exact commit SHA, clean worktree, passing exact-SHA CI with MySQL 8.0 (and MariaDB CI if MariaDB is proposed), security/dependency review, all owner-dependent policies, host-specific staging evidence, tested backup/restore, and action-specific written approval. Deploy only via the confirmed cPanel/process procedure with versioned code and a verified rollback plan. Prefer reverting code to a prior verified release when schema-compatible; never overwrite a newer database with an old backup or run destructive down-migrations without separate scoped authorization.

## 7. Outstanding inputs and no-deploy gate

Before cPanel staging can be configured, provide/record (without credentials): exact provider plan and cPanel/CloudLinux version; screenshots or documentation for its Node app UI/startup field; selected Node/npm versions; assigned port/start command/environment mechanism/restart/log behavior; exact MySQL or MariaDB server/version and limits; canonical HTTPS origin and proxy-hop count; persistent upload path and URL mapping; cron facts; backup/restore facilities and owner-approved retention/RPO/RTO; monitoring destination/resource limits; and named staging approver.

All production targets, credentials, migrations, DNS, customer data, provider integrations and irreversible operations remain unauthorized. Phase 20 remains `IN PROGRESS` until these facts and every end-to-end/security/recovery gate are independently evidenced and owner-approved. Phase 19 remains the separate Android WebView phase and `NOT STARTED`.
