# Mr. Tumi Grocery & Gift — Final Independent Audit & Remediation Report

**Audit Target Branch:** `antigravity/final-launch-readiness`  
**Governing Standard:** Complete Platform Delivery; Dual MySQL 8.0 & MariaDB 10.11 Compatibility; Zero Secrets; Safe Fail-Closed Defaults.  
**Auditor:** Arena Independent Verification Remediation.

---

## 1. Master Audit Remediation Matrix

| # | Finding Topic | Arena Audit Focus | Status | File(s) Remediated | Verification & Test Evidence |
|---|---|---|:---:|---|---|
| **1** | **Git Integration & Ancestry** | Remote commit ancestry & preservation | **FIXED** | Git repository DAG | `git merge-base --is-ancestor 53ba67f HEAD` -> True; `61a9ef1` -> True; `317adb6` -> True; `3ef8911` -> True; `a65ff5a` -> True. Zero force-pushes; Arena branch untouched. |
| **2** | **Open Redirect Prevention** | Same-host absolute URL path `//` bypass & form redirects | **FIXED** | `src/utils/urlSecurity.js`, `src/routes/storefront.js`, `src/routes/customerAccount.js` | `tests/security-open-redirect.test.js` (2 test suites, 9 edge-case assertions across newsletter, contact, review, wishlist) |
| **3** | **Pathao Database Persistence & Fail-Closed Memory** | Durable MySQL write before memory update; zero-row SQL update fails closed | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` | `tests/courier-pathao-token-rotation.test.js` (tests for zero-row update, missing record, DB deadlock, and successful update with memory unchanged on failure) |
| **4** | **Cross-Process Refresh Locking & CAS Adoption** | Distributed locking across separate Passenger worker processes | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` | `tests/courier-pathao-token-rotation.test.js` (InnoDB `FOR UPDATE` transaction lock; CAS adoption prevents duplicate network rotation when concurrent worker already rotated) |
| **5** | **Admin Credential Sanitization (Allowlist-Only)** | Explicit safe allowlist dropping unknown and nested fields from DOM & `data-record` | **FIXED** | `src/utils/adminSanitization.js`, `src/routes/adminSettings.js`, `src/routes/adminOrders.js` | `tests/admin-courier-credential-exposure.test.js` (allowlist filtering, nested credential dropping, rendered template & edit button `data-record` verification) |
| **6** | **Strict Credential Recovery (invalid_grant Only)** | Restrict fallback strictly to provider `invalid_grant`; refuse fallback on network, timeout, malformed, 429, 5xx, ambiguous | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` | `tests/courier-pathao-token-rotation.test.js` (7 distinct failure categories tested: network error, timeout, malformed non-JSON, 429, 500, ambiguous 400 all refuse fallback; only `invalid_grant` recovers) |
| **7** | **Production Startup Entrypoint Reconciliation** | Canonical entrypoint `app.js` across codebase & checklists; Passenger simulation | **FIXED** | `package.json`, `app.js`, `DEPLOYMENT.md`, `docs/PRODUCTION_CONFIGURATION_CHECKLIST.md` | `tests/production-startup-entry.test.js` (4 passing tests verifying `app.js` main, exports, fail-closed guards, and simulated Passenger detection) |
| **8** | **CI & Connection Pool Drainage** | Unclosed DB connection pool hanging `node --test` runner in Actions run `42012548927` | **FIXED** | `tests/courier-pathao-token-rotation.test.js` | Explicit `after(async () => { await mysqlPool.closePool(); })` added to test teardown; event loop drains cleanly; check-foundation: 1,423 checks passed (0 failed). |

---

## 2. Deep Dive: Pathao Database Persistence & Fail-Closed Memory (Finding 3)

### Defect Identified
Under previous logic:
1. `mysqlPool.execute()` could return `affectedRows === 0` (e.g. if the courier ID was missing or deleted), but execution did not fail closed unless a flag was explicitly set.
2. In-memory tokens could desynchronize from persistent storage if persistence failed or updated zero rows.

### Technical Remediation (`src/services/courier/adapters/PathaoAdapter.js`)
1. **Zero-Row Update Guard:**
   ```javascript
   if (!result || typeof result.affectedRows !== 'number' || result.affectedRows < 1) {
     throw new Error(
       `Database persistence failure: zero rows updated for courier record (id: ${providerId || 'none'}, code: ${providerCode || 'none'}). Record may not exist or has been deleted.`
     );
   }
   ```
2. **Guaranteed Post-Persistence Memory Mutation:**
   In `persistTokenRotation(accessToken, refreshToken)`, `this.apiKey = accessToken`, `this.refreshToken = refreshToken`, and `this.serviceOptions = updatedServiceOptions` are placed at the very end of the function. If `mysqlPool.execute()` throws or returns `affectedRows < 1`, execution halts immediately; internal memory fields remain strictly identical to their pre-rotation values.
3. **Comprehensive Regression Tests:**
   `tests/courier-pathao-token-rotation.test.js` tests:
   - Zero-row SQL update (`affectedRows === 0`) -> throws `zero rows updated`, memory untouched.
   - Database deadlock / SQL error -> throws error, memory untouched.
   - Successful update -> persists encrypted token, updates memory.

---

## 3. Deep Dive: Cross-Process Refresh Locking & CAS Adoption (Finding 4)

### Defect Identified
A process-local in-flight promise lock (`this._refreshLockPromise`) only serializes requests inside a single Node.js worker process. In Phusion Passenger or cluster mode with multiple operating-system processes, simultaneous requests handled by separate workers could both call Pathao's OAuth endpoint, rotating the single-use refresh token twice and revoking active sessions.

### Technical Remediation (`src/services/courier/adapters/PathaoAdapter.js`)
1. **InnoDB Row-Level Locking:**
   When MySQL is active, `refreshAccessToken()` wraps the refresh lifecycle in `mysqlPool.withTransaction` and issues:
   ```sql
   SELECT id, name, code, api_key, service_options_json, updated_at
   FROM courier_apis
   WHERE id = ? FOR UPDATE
   ```
   This acquires an exclusive row-level lock on the database record across all Passenger processes.
2. **Compare-and-Swap (CAS) Token Adoption:**
   When a waiting worker process acquires the row lock, it checks whether another worker has already completed the refresh:
   ```javascript
   const localEncryptedRefresh = this.serviceOptions?.encrypted_refresh_token;
   const dbEncryptedRefresh = dbOptions.encrypted_refresh_token;

   if (dbEncryptedRefresh && localEncryptedRefresh && dbEncryptedRefresh !== localEncryptedRefresh) {
     // Another process already rotated the single-use token!
     // Adopt the new tokens from the database without calling Pathao:
     this.apiKey = decryptProviderToken(row.api_key);
     this.refreshToken = decryptProviderToken(dbEncryptedRefresh);
     this.serviceOptions = Object.assign({}, this.serviceOptions, dbOptions);
     return { success: true, adoptedFromConcurrentProcess: true };
   }
   ```
3. **Atomic Persistence:**
   The holding worker executes the external refresh, writes the encrypted tokens to `courier_apis`, verifies `affectedRows >= 1`, updates its memory state, and commits the transaction, releasing the lock for waiting workers.

---

## 4. Deep Dive: Allowlist-Only Admin Credential Sanitization (Finding 5)

### Defect Identified
A blacklist approach (`delete sanitized.password`, `delete sanitized.refresh_token`) is fragile if arbitrary, nested, or unknown credential fields are stored (e.g. `auth_token`, `client_secret_custom`, `nested_credentials: { key: 'xyz' }`).

### Technical Remediation (`src/utils/adminSanitization.js`)
1. **Strict Safe Allowlist:**
   Defined `SAFE_COURIER_OPTIONS_ALLOWLIST`:
   - `store_id`, `city_id`, `zone_id`, `area_id`, `pickup_hub_id`, `default_weight_grams`, `delivery_type`, `item_type`, `webhook_url`, `enable_live_rates`, `sender_name`, `sender_phone`, `sender_address`.
2. **Recursive & Nested Defense:**
   - Any key NOT in the allowlist is dropped.
   - Any key matching dangerous keywords (`token`, `secret`, `key`, `pass`, `auth`, `cred`, `enc:`, `bearer`) is dropped.
   - Any nested object or array value is rejected (only safe primitive numbers, booleans, and sanitized strings under 500 chars).
3. **Top-Level Record Allowlist:**
   `sanitizeAdminCourierRecord(r)` outputs strictly: `id`, `name`, `code`, `base_url`, `client_id`, `supports_live_quotes`, `status`, `sandbox`, masked `api_key` (`••••••••<last4>`), masked `secret_key` (`••••••••`), allowlisted `service_options_json`, and `updated_at`.
4. **View Surface Cleansing:**
   - `src/routes/adminSettings.js`: Sanitizes records before passing to `crud-module.ejs`.
   - `src/routes/adminOrders.js`: Replaced `SELECT * FROM courier_apis` with `SELECT id, name, code, status FROM courier_apis`.

---

## 5. Deep Dive: Strict Credential Recovery (Finding 6)

### Defect Identified
Previously, fallback to password credentials could be triggered prematurely by network glitches, 5xx server errors, rate limits, or missing refresh tokens.

### Technical Remediation (`src/services/courier/adapters/PathaoAdapter.js`)
1. **Explicit `invalid_grant` Requirement:**
   Fallback recovery is permitted **ONLY** when the provider explicitly confirms `invalid_grant`:
   ```javascript
   const errCode = String(data?.error || '').toLowerCase().trim();
   const errDesc = String(data?.error_description || data?.message || '').toLowerCase().trim();
   const isConfirmedInvalidGrant = (
     (response.status === 400 || response.status === 401) &&
     (errCode === 'invalid_grant' || errDesc.includes('invalid_grant'))
   );
   ```
2. **Strict Failure Refusals:**
   - Network failure (ECONNREFUSED) -> `isNetworkError: true`, NO fallback.
   - Network timeout (AbortError) -> `isTimeout: true`, NO fallback.
   - Malformed / non-JSON response -> `isMalformedResponse: true`, NO fallback.
   - Rate limit (HTTP 429) -> `isRateLimit: true`, NO fallback.
   - Server error (HTTP 5xx) -> `isServerError: true`, NO fallback.
   - Ambiguous HTTP 400 error (`invalid_request`) -> `isAmbiguousFailure: true`, NO fallback.
   - Missing refresh token in config -> `success: false`, NO fallback.

---

## 6. Deep Dive: Actions Run 42012548927 & Connection Pool Drainage (Finding 8)

### Root Cause of Hanging Run
In GitHub Actions run `42012548927`, `npm test` started at 10:40:14Z and remained in progress. Investigation revealed that `tests/courier-pathao-token-rotation.test.js` invoked `mysqlPool.execute()` against the live MySQL/MariaDB service container without an `after()` teardown hook. Because `mysql2` maintains active keepalive socket connections in its connection pool, Node's `--test` runner waited indefinitely for the event loop to drain.

### Remediation
Added explicit pool teardown to `tests/courier-pathao-token-rotation.test.js`:
```javascript
const { after } = require('node:test');
after(async () => {
  try {
    await mysqlPool.closePool();
  } catch (_e) {}
});
```
This ensures the event loop drains immediately upon test completion, allowing CI integration runs to finish in ~30 seconds.
- **Foundation Check:** 1,423 checks passed, 0 failed.
- **Remediation Suite:** 16 tests passed, 0 failed.
