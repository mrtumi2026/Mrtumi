# Owner Checklist — Verify the Real cPanel Host Contract

**Purpose:** collect non-secret facts for Phase 20 staging preparation. This is not a deployment authorization or release-readiness sign-off. Do not paste credentials, session secrets, customer data, screenshots containing secrets, or unredacted environment dumps into chat or Git.

## A. cPanel / CloudLinux application interface

- [ ] Provider, plan/account type and staging target confirmed by owner.
- [ ] Exact cPanel and CloudLinux versions/build recorded.
- [ ] Confirm whether **Setup Node.js App** (or equivalent) exists in this account; record its displayed application mode/integration and link to the provider's instructions.
- [ ] Confirm application root may be outside `public_html`; record the allowed root path class, not an account secret.
- [ ] Record startup-file field semantics. Repository candidates are `app.js` (deployment wrapper) and `server.js` (Express app/listener); do not select either until the interface contract is known.
- [ ] Record whether the app manager supplies `PORT`, uses a socket, or requires a different listener contract; record whether `HOST` is accepted/required. Do not assume Passenger defaults.
- [ ] Record how the panel supplies environment variables, starts/stops/restarts the process, and captures stdout/stderr logs. Do not assume `tmp/restart.txt` or a particular Passenger global.

## B. Runtime and dependency installation

- [ ] In the selected application runtime, record output of `node -v` and `npm -v`; requested host runtime target is **Node.js 22.23.4**. Project engine is `>=22.5.0`; any different host release needs owner confirmation and compatibility review.
- [ ] Confirm the selected Node binary used by the panel/Passenger is the same one used for SSH/CLI migration tasks.
- [ ] Verify lockfile installation in an isolated staging app root with `npm ci --omit=dev --no-audit --no-fund`; record command exit code and sanitized version output only.
- [ ] Confirm runtime support for lockfile v3 and `mysql2`; do not run `npm install` during app start.

## C. Runtime environment, HTTPS, sessions and CSRF

- [ ] Confirm protected environment-variable facility and whether panel values override `.env` (repository process environment takes precedence).
- [ ] In staging only, provide `NODE_ENV=production`, `DB_CLIENT=mysql`, staging-only DB fields, approved HTTPS `APP_URL`, distinct random `SESSION_SECRET` and `CSRF_SECRET`, explicit `TRUST_PROXY`, and an absolute `UPLOAD_DIR` outside the application root.
- [ ] Keep staging secrets out of Git/chat/logs; do not reuse production credentials.
- [ ] Confirm TLS termination, canonical HTTPS origin, forwarding headers and exact trusted proxy-hop topology. Test secure cookie attributes (`Secure`, `HttpOnly`, `SameSite=Lax`) and CSRF rejection over the real staging HTTPS path.
- [ ] Never disable CSRF or secure cookies to compensate for an unknown proxy configuration.

## D. Database dialect and staging isolation

- [ ] Determine actual offered database engine and exact server/version. Read-only identification query on a designated test/staging DB: `SELECT VERSION(), @@version_comment, @@sql_mode;`.
- [ ] Confirm InnoDB availability, `utf8mb4`, collation, timezone behavior, connection cap, network host/port and allowed connection settings.
- [ ] MySQL 8.0 and MariaDB 10.11 have separate migration/integration CI jobs, both passed in run [`40666166310`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40666166310) on Node.js 22.23.4 at SHA `8486479496bbf1d2f6cf32ba805db903ffbae4d4`. This does not establish the real host engine/version/settings; compare the target and repeat isolated staging validation.
- [ ] Create a new empty disposable staging schema and a staging-only DB user. Do not import production/customer data. Keep runtime and migration credentials separate where the panel allows.
- [ ] Apply/check migrations only on that disposable schema. Never run `migrate:down`, import, restore or migration commands against production under this checklist.

## E. Persistent files, logs, scheduled jobs and recovery

- [ ] Record a staging upload directory outside the release root; verify directory owner/group, least permissions, quota, durability and approved static URL mapping. Test a non-sensitive raster upload, read-back at `/uploads/custom/`, and persistence after a staging restart.
- [ ] Confirm log location, access controls, rotation/retention and failure-alert path; verify logs do not include secrets or customer payloads.
- [ ] If scheduled work is required, confirm cPanel Cron Jobs availability, minimum interval, run-as user, absolute Node path, working directory, environment source, locking and logs. Do not configure the absent `scripts/cron-runner.js`; reservation expiry is a separate one-shot CLI.
- [ ] Confirm host backup features and coverage for the staging database, uploads and configuration; document tool, destination, encryption/access controls and restore operator.
- [ ] Define retention/RPO/RTO with the owner; do not invent values. Rehearse restore only into a disposable staging target, never production.

## F. Owner-provided evidence to return

Return only sanitized facts: panel/CloudLinux version; Node/npm versions; startup-file and port contract; app-root rule; environment and restart/log behavior; exact database engine/version and relevant non-secret settings; TLS/proxy hops; upload path class/permissions; cron availability; backup/restore facility; and staging smoke-test outcomes. Mark each unknown explicitly. No credentials are requested by this checklist.

**Gate:** until these items are evidenced on the actual target, cPanel compatibility remains `UNVERIFIED`, Phase 20 remains `IN PROGRESS`, and no production deployment/migration/DNS/data/provider action is authorized.
