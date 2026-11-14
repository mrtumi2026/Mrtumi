# Mr. Tumi Platform — Operational Rollback Runbook (OPS-05)

This runbook establishes a deterministic, non-destructive procedure to revert code or handle production deployment regressions on cPanel / Phusion Passenger without losing customer data, backups, or custom server scripts.

---

## 1. Safety Guarantees & Constraints

1. **Zero Data Loss:** Never run `git reset --hard`, `git clean -fd`, or drop databases during a rollback.
2. **Preserve Backups:** All files matching `*.zip`, `~/safe_cpanel_backups/`, and custom admin scripts (`scripts/create-admin.js`) must remain untouched outside Git.
3. **Additive Migrations:** Production database migrations (up to `0034`) are strictly additive. Code rollbacks to recent commits (`c3038c0`, `2418537`, `d37b4a5`) operate on the same backwards-compatible database schema without requiring destructive database rollbacks.

---

## 2. Fast Rollback Procedure (Code-Level Regression)

If a newly deployed commit introduces an application regression:

### Step 1: Identify Target Stable Commit
Review recent release commits:
- Current verified fix commit: `d37b4a5` (Customer recovery fix)
- Previous stable commits: `c3038c0` (Migration checksum compatibility)

### Step 2: Checkout / Revert Target Commit
In the cPanel terminal (`~/mrtumi`):
```bash
cd ~/mrtumi

# Fetch latest branch state
git fetch origin

# Option A: Fast-forward or checkout specific verified commit
git checkout <TARGET_STABLE_COMMIT_SHA>

# Verify HEAD
git rev-parse --short HEAD
```

### Step 3: Reload Passenger Worker
Signal Phusion Passenger to gracefully reload the worker process with the target commit:
```bash
mkdir -p tmp && touch tmp/restart.txt
```

### Step 4: Run Post-Rollback Smoke Health Check
Run the automated deployment health runner:
```bash
npm run deploy:verify
```
Verify all 4 critical endpoints (`/`, `/customer/login`, `/customer/recovery`, `/customer/recovery/reset`) respond with HTTP 200 and security headers.

---

## 3. Database Migration Rollback Criteria

> [!WARNING]
> Only consider rolling back a database migration if the migration itself caused an active blocking failure. Never run `migrate:down` on migrations containing irreversible customer data.

1. **Inspect Status:**
   ```bash
   CONFIRM_PRODUCTION_MIGRATION=true npm run migrate:status
   ```
2. **Verify Down Migration Safety:**
   Inspect the corresponding `*.down.sql` file in `src/db/migrations/`. Confirm whether the rollback drops empty tables only or risks existing production customer orders/accounts.
3. **Execute Single Down Step (If Authorized):**
   ```bash
   CONFIRM_PRODUCTION_MIGRATION=true npm run migrate:down
   ```
4. **Restart Application:**
   ```bash
   touch tmp/restart.txt
   ```

---

## 4. Post-Incident Review Protocol

1. Record the incident in `docs/INCIDENT_LOG.md`.
2. Capture sanitised error stack traces from Passenger logs without revealing customer credentials or session IDs.
3. Add a reproducible regression test in `tests/` before preparing the replacement fix commit on a feature branch.
