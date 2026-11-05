# Mr. Tumi Grocery & Gift — Security & Data Integrity Audit Report

**Branch Under Review:** `antigravity/final-launch-readiness`  
**Governing Baseline:** Safe fail-closed defaults; zero unvalidated redirects; immutable financial ledgers; zero credential exposure.

---

## 1. Security Findings Status Matrix

| Finding ID | Security Domain | Finding Description | Status | Affected Files & Functions | Regression Test Suite |
|---|---|---|:---:|---|---|
| **SEC-01** | Open Redirect Vulnerability | Public routes and referrers vulnerable to same-host absolute URLs with `//` paths, backslashes, or CRLF | **FIXED** | `src/utils/urlSecurity.js` (`safeReferrer`), `src/routes/storefront.js`, `src/routes/customerAccount.js` | `tests/security-open-redirect.test.js` (2 test suites, 9 edge case assertions) |
| **SEC-02** | Token Persistence Fail-Closed | Memory state updated before database write, causing desync if DB throws | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` (`persistTokenRotation`) | `tests/courier-pathao-token-rotation.test.js` (DB write first, memory untouched on DB error) |
| **SEC-03** | Concurrent Refresh Race Condition | Multiple simultaneous requests rotating single-use refresh token simultaneously | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` (`refreshAccessToken`) | `tests/courier-pathao-token-rotation.test.js` (10 concurrent requests share single in-flight mutex) |
| **SEC-04** | Plaintext Token Encryption | OAuth refresh tokens stored in plaintext in database `service_options_json` | **FIXED** | `src/utils/providerTokenSecurity.js`, `src/services/courier/adapters/PathaoAdapter.js` | `tests/courier-pathao-token-rotation.test.js` (AES-256-GCM `enc:v1:` authenticated encryption) |
| **SEC-05** | Credential Fallback Boundary | Network, timeout, 429, or 5xx errors triggering dangerous password recovery fallback | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` (`refreshAccessToken`) | `tests/courier-pathao-token-rotation.test.js` (5 failure categories verified: only `invalid_grant` recovers) |
| **SEC-06** | Admin Credential Exposure | Secrets, refresh tokens & passwords exposed in HTML and edit-button `data-record` JSON | **FIXED** | `src/routes/adminSettings.js` (`GET /admin/courierapi/manage`) | `tests/admin-courier-credential-exposure.test.js` (1 test verifying complete absence of secrets) |
| **SEC-07** | Financial Integer-Paisa Safety | Courier and order calculations must strictly avoid IEEE-754 floating point arithmetic | **FIXED** | `src/services/courier/adapters/*.js`, `src/utils/money.js` | `tests/courier-provider-contract-failures.test.js` |

---

## 2. Deep Dive: Open Redirect Remediation (SEC-01)

### Vulnerability Identified
Prior to remediation, public forms in `src/routes/storefront.js` and `src/routes/customerAccount.js` used unvalidated or partially-validated referrers. Specifically, same-host absolute URLs whose extracted path began with `//` (e.g. `https://mrtumi.com//evil.com`) or backslashes (`\`) could trick the router into redirecting to external hosts via protocol-relative path interpretation.

### Technical Remediation (`src/utils/urlSecurity.js`)
1. **Sanitization:** String must not contain `\r`, `\n`, null bytes, or backslashes (`\`).
2. **Path Protocol-Relative Guard:** Any path starting with `//` is immediately rejected.
3. **Same-Host Path Extraction:**
   ```javascript
   if (parsed.host.toLowerCase() === host.toLowerCase()) {
     const safePath = parsed.pathname + (parsed.search || '');
     if (safePath.startsWith('//') || safePath.startsWith('/\\') || safePath.includes('\\')) {
       return fallback;
     }
     return safePath.startsWith('/') ? safePath : fallback;
   }
   ```
4. **Integration:** Applied to:
   - `POST /api/newsletter`
   - `POST /api/contact`
   - `POST /api/review`
   - `POST /customer/account/wishlist/remove`

---

## 3. Deep Dive: Pathao Token Encryption, Persistence & Concurrency (SEC-02, SEC-03, SEC-04, SEC-05)

### Technical Remediation
1. **Authenticated AES-256-GCM Encryption (`src/utils/providerTokenSecurity.js`):**
   - Format: `enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`.
   - Key derivation: HKDF-SHA256 from `VENDOR_PII_KEY` or `SESSION_SECRET` with info `'mr-tumi-provider-token-v1'`.
   - Plaintext `refresh_token` deleted from options JSON; stored securely as `encrypted_refresh_token`.
2. **Durable Persistence First:**
   - `persistTokenRotation()` writes to MySQL (`mysqlPool.execute('UPDATE courier_apis SET api_key = ?, service_options_json = ? WHERE ...')`).
   - Only on success are internal fields (`this.apiKey`, `this.refreshToken`) updated.
   - If DB write fails, memory state is left untouched and the rotation fails closed.
3. **In-Flight Refresh Mutex:**
   - In `PathaoAdapter.refreshAccessToken()`, subsequent calls reuse `this._refreshLockPromise` until the active token refresh resolves.
   - Verified under 10 concurrent requests: exactly 1 network refresh occurs; all 10 return the refreshed token.
4. **Strict Error Classification Matrix:**
   - **Network Timeout (`AbortError`):** Returns `{ success: false, code: 'COURIER_NETWORK_TIMEOUT' }`. NO fallback.
   - **DNS / Fetch Error (`FetchError`):** Returns `{ success: false, code: 'COURIER_NETWORK_ERROR' }`. NO fallback.
   - **Rate Limit (HTTP 429):** Returns `{ success: false, code: 'COURIER_RATE_LIMIT' }`. NO fallback.
   - **Server Error (HTTP 500/502/503):** Returns `{ success: false, code: 'COURIER_PROVIDER_5XX' }`. NO fallback.
   - **Invalid Grant (HTTP 400/401 `invalid_grant`):** Initiates automated credential recovery via password/client_credentials.

---

## 4. Deep Dive: Admin Credential Exposure (SEC-06)

### Technical Remediation
In `src/routes/adminSettings.js`:
- Strips `refresh_token`, `encrypted_refresh_token`, `password`, and `client_secret` from `service_options_json` before rendering.
- Masks `api_key` to `••••••••<last4>` and `secret_key` to `••••••••`.
- Prevents DOM exposure via `data-record='<%- JSON.stringify(r) %>'` on the edit button.
- Verified by `tests/admin-courier-credential-exposure.test.js`.
