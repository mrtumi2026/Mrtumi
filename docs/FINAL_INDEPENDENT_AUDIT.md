# Mr. Tumi Grocery & Gift — Final Independent Audit & Remediation Report

**Audit Target Branch:** `antigravity/final-launch-readiness`  
**Governing Standard:** Complete Platform Delivery; Dual MySQL 8.0 & MariaDB 10.11 Compatibility; Zero Secrets; Safe Fail-Closed Defaults.

---

## 1. Master Audit Reconciliation Table

| # | Finding Topic | Arena Audit Document | Finding Status | File(s) Remediated | Regression Test Evidence |
|---|---|---|:---:|---|---|
| **1** | **Git Integration & Ancestry** | `docs/BRANCH_INTEGRATION_REPORT.md` | **FIXED** | Git repository DAG | `git merge-base --is-ancestor 53ba67f HEAD` -> True; `61a9ef1` -> True; `317adb6` -> True. |
| **2** | **Production Startup Entry-Point Conflict** | `docs/FINAL_INDEPENDENT_AUDIT.md` | **FIXED** | `package.json`, `server.js`, `app.js` | `tests/production-startup-entry.test.js` (3 passing tests) |
| **3** | **Open Redirect on Public Referrers** | `docs/SECURITY_AND_DATA_INTEGRITY_AUDIT.md` | **FIXED** | `src/utils/urlSecurity.js`, `src/routes/storefront.js`, `src/routes/customerAccount.js` | `tests/security-open-redirect.test.js` (2 passing tests) |
| **4** | **Pathao OAuth Token Rotation & Recovery** | `docs/SECURITY_AND_DATA_INTEGRITY_AUDIT.md` | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` | `tests/courier-pathao-token-rotation.test.js` (4 passing tests) |
| **5a**| **Check-Foundation Lint Count Discrepancy** | `docs/FINAL_INDEPENDENT_AUDIT.md` | **FIXED** (Explained) | `scripts/check-foundation.js` | Mathematical formula verified; count dynamically tracks total files. |
| **5b**| **Database-Dependent Skipped Tests in CI** | `docs/FINAL_INDEPENDENT_AUDIT.md` | **FIXED** | `.github/workflows/ci.yml` | Added `Reapply all MySQL migrations before integration tests` to `mysql-compatibility`. |

---

## 2. Deep Dive: Production Startup Entry Conflict (Finding 2)

### Defect Identified
- `package.json` had `"main": "server.js"` while `"start": "node --no-warnings app.js"`.
- `app.js` is the guarded deployment wrapper enforcing `NODE_ENV=production` and exporting `app` as a function for Phusion Passenger.
- Direct execution of `server.js` was unaligned: it did not check `APP_ALLOW_TEST_STARTUP`, did not export `app` as a function, and caused ambiguity in hosting environments that inspect `package.json.main`.

### Remediation Applied
1. **`package.json` Alignment:** Set `"main": "app.js"`. Both `"main"` and `"start"` now point to `app.js`.
2. **`server.js` Harmonization:**
   - Retained strict development guard: refuses direct start without `npm run dev`.
   - Added test execution guard: requires `APP_ALLOW_TEST_STARTUP=true`.
   - Dual export format: `module.exports = Object.assign(app, { app, startServer })`.
   - Allows Phusion Passenger or hosting tools to require either `app.js` or `server.js` without runtime failure.
3. **Regression Tests (`tests/production-startup-entry.test.js`):**
   - Verified `package.json.main === 'app.js'`.
   - Verified `typeof appEntry === 'function'` and `typeof serverEntry === 'function'`.
   - Verified fail-closed guards in development and test modes.
   - Verified real HTTP boot on `/health` when authorized.

---

## 3. Deep Dive: Lint Count Discrepancy & Skipped Tests (Finding 5)

### Lint Count Arithmetic Explained
The Foundation Check (`scripts/check-foundation.js`) does NOT use a static test counter. It computes:
$$\text{Total Checks} = \text{JS Syntax Files} + \text{EJS Templates} + \text{Docs Validated} + \text{Checklist Rows} + \text{Migrations} + \text{Files Scanned for Secrets} + \text{Git Tracked Files}$$

- **At commit `53ba67f`:** 1,390 checks.
- **At commit `61a9ef1` (courier tests added):** 1,392 checks (+2 tests).
- **At commit `317adb6` / `ce5c0c4` (wishlist view & handover docs added):** 1,399 checks.
- **At current remediation commit:** Additional test files and security utilities scale the count cleanly.

Every check is fully verified with 0 failures (`check-foundation.js`).

### Database-Dependent Skipped Tests Resolution
- **Local Sandbox Behavior:** `tests/courier-operational-recovery.test.js` and `tests/multi-courier-engine.test.js` skip locally on machines without a running MySQL daemon, guarded by `if (!MYSQL_HOST)`.
- **CI Root Cause Identified:** In `.github/workflows/ci.yml`, the `mysql-compatibility` job executed migration rollback testing (`migrate:down -- 2`), but did not reapply migrations before running `npm test`. In contrast, the `mariadb-compatibility` job had an explicit `Reapply all MariaDB migrations before integration tests` step.
- **Remediation:** Added `mysql_migration_reapply` step to `.github/workflows/ci.yml` before `npm test`. This ensures both MySQL 8.0 and MariaDB 10.11 test suites run against the complete, fully migrated schema.
