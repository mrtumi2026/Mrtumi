# Mr. Tumi Grocery & Gift — Security & Data Integrity Audit Report

**Branch Under Review:** `antigravity/final-launch-readiness`  
**Governing Baseline:** Safe fail-closed defaults; zero unvalidated redirects; immutable financial ledgers; zero credential exposure.

---

## 1. Security Findings Status Matrix

| Finding ID | Security Domain | Finding Description | Status | Affected Files & Functions | Regression Test Suite |
|---|---|---|:---:|---|---|
| **SEC-01** | Open Redirect Vulnerability | Public routes and referrers vulnerable to same-host absolute URLs with `//` paths, backslashes, or CRLF | **FIXED** | `src/utils/urlSecurity.js` (`safeReferrer`), `src/routes/storefront.js`, `src/routes/customerAccount.js` | `tests/security-open-redirect.test.js` (2 test suites, 9 edge case assertions) |
| **SEC-02** | Token Persistence Fail-Closed | Zero-row SQL update on token rotation or DB failure leaves memory state desynchronized | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` (`persistTokenRotation`) | `tests/courier-pathao-token-rotation.test.js` (zero-row SQL failure & DB deadlock verified fail-closed, memory untouched) |
| **SEC-03** | Cross-Process Concurrent Refresh | Multiple Passenger worker processes rotating single-use refresh token simultaneously | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` (`refreshAccessToken`, `_refreshWithCrossProcessDbLock`) | `tests/courier-pathao-token-rotation.test.js` (InnoDB `FOR UPDATE` transaction lock + CAS token adoption across workers) |
| **SEC-04** | Plaintext Token Encryption | OAuth refresh tokens stored in plaintext in database `service_options_json` | **FIXED** | `src/utils/providerTokenSecurity.js`, `src/services/courier/adapters/PathaoAdapter.js` | `tests/courier-pathao-token-rotation.test.js` (AES-256-GCM `enc:v1:` authenticated encryption) |
| **SEC-05** | Credential Fallback Boundary | Network, timeout, malformed, 429, or 5xx errors triggering dangerous password recovery fallback | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` (`_executeTokenRefreshNetworkOnly`) | `tests/courier-pathao-token-rotation.test.js` (7 failure categories verified: only provider-confirmed `invalid_grant` recovers) |
| **SEC-06** | Admin Credential Exposure (Allowlist) | Secrets, refresh tokens, passwords, and unknown nested fields exposed in HTML & `data-record` | **FIXED** | `src/utils/adminSanitization.js`, `src/routes/adminSettings.js`, `src/routes/adminOrders.js` | `tests/admin-courier-credential-exposure.test.js` (allowlist enforcement, nested secret dropping, DOM/data-record absence) |
| **SEC-07** | Financial Integer-Paisa Safety | Courier and order calculations must strictly avoid IEEE-754 floating point arithmetic | **FIXED** | `src/services/courier/adapters/*.js`, `src/utils/money.js` | `tests/courier-provider-contract-failures.test.js` |

---

## 2. Technical Remediation Highlights

### 1. Allowlist-Only Admin Serialization (`src/utils/adminSanitization.js`)
- Enforces `SAFE_COURIER_OPTIONS_ALLOWLIST`: drops all non-allowlisted properties.
- Recursively rejects nested objects, arrays, and strings matching dangerous patterns (`token`, `secret`, `key`, `pass`, `auth`, `cred`, `enc:`, `bearer`).
- Top-level database row fields are strictly allowlisted; `api_key` and `secret_key` are masked.
- Verified in `tests/admin-courier-credential-exposure.test.js`.

### 2. Cross-Process Refresh Locking & CAS Adoption (`PathaoAdapter.js`)
- Wraps token refresh in MySQL InnoDB transaction with `SELECT ... FOR UPDATE` row lock.
- Serializes separate Phusion Passenger worker processes trying to refresh the single-use token simultaneously.
- When waiting processes acquire the lock, they detect whether the token in the database was already rotated (`dbEncryptedRefresh !== currentEncryptedRefresh`), adopt the fresh token, and exit without making duplicate network requests.

### 3. Strict Provider-Confirmed `invalid_grant` Boundary
- Restricts fallback recovery strictly to HTTP 400/401 responses with explicit `invalid_grant`.
- All other failure modes fail closed without attempting password recovery:
  - Network failure (ECONNREFUSED) -> `isNetworkError: true`
  - Timeout (AbortError) -> `isTimeout: true`
  - Malformed response (non-JSON body, HTML error) -> `isMalformedResponse: true`
  - Rate limit (HTTP 429) -> `isRateLimit: true`
  - Server error (HTTP 5xx) -> `isServerError: true`
  - Ambiguous 400 error (`invalid_request`) -> `isAmbiguousFailure: true`
