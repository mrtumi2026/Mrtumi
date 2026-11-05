# Mr. Tumi Grocery & Gift — Security & Data Integrity Audit Report

**Branch Under Review:** `antigravity/final-launch-readiness`  
**Governing Baseline:** Safe fail-closed defaults; zero unvalidated redirects; immutable financial ledgers.

---

## 1. Security Findings Status Matrix

| Finding ID | Security Domain | Finding Description | Status | Affected Files & Functions | Regression Test Suite |
|---|---|---|:---:|---|---|
| **SEC-01** | Open Redirect Vulnerability | Public `/api/contact` and `/api/newsletter` routes redirected directly to unvalidated `Referer` headers | **FIXED** | `src/utils/urlSecurity.js` (`safeReferrer`), `src/routes/storefront.js`, `src/routes/customerAccount.js` | `tests/security-open-redirect.test.js` (2 passing tests) |
| **SEC-02** | Credential Persistence & Rotation | Pathao OAuth refresh token rotation only updated in-memory state; failed to persist rotated tokens to DB or recover from stale tokens | **FIXED** | `src/services/courier/adapters/PathaoAdapter.js` (`persistTokenRotation`, `refreshAccessToken`) | `tests/courier-pathao-token-rotation.test.js` (4 passing tests) |
| **SEC-03** | Financial Integer-Paisa Safety | Courier and order calculations must strictly avoid IEEE-754 floating point arithmetic | **FIXED** | `src/services/courier/adapters/*.js`, `src/utils/money.js` | `tests/courier-provider-contract-failures.test.js` |
| **SEC-04** | PII & Secret Redaction | Credentials, API tokens, and customer NID/PII must never appear in error logs or responses | **FIXED** | `src/services/courier/CourierBaseAdapter.js` (`sanitize`), `src/utils/vendorPii.js` | `tests/courier-provider-contract-failures.test.js` |

---

## 2. Deep Dive: Open Redirect Remediation (SEC-01)

### Vulnerability Identified
Prior to remediation, public forms in `src/routes/storefront.js` handled browser redirects via:
```javascript
// VULNERABLE CODE (lines 1702, 1708, 1722):
return res.redirect(req.get('Referrer') || '/contact');
return res.redirect(req.get('Referrer') || '/');
```
If an attacker supplied `Referer: https://evil.com/phishing` or protocol-relative `Referer: //evil.com`, unauthenticated victims would be redirected outside `mrtumi.com`.

### Technical Remediation
Implemented [`src/utils/urlSecurity.js`](file:///C:/Users/Bappi/.gemini/antigravity/scratch/mrtumi-git/src/utils/urlSecurity.js) with `safeReferrer(req, fallback)`:
1. Rejects CR (`\r`), LF (`\n`), null bytes, and backslashes (`\`) to eliminate CRLF response splitting.
2. Rejects protocol-relative URLs (`//`).
3. Validates relative paths by parsing against internal dummy base and confirming identical origin.
4. If an absolute URL is provided, validates that `parsed.host.toLowerCase() === req.get('host').toLowerCase()`; extracts and returns only the local `pathname` and `search` query.
5. All external or malformed candidates fail closed to the designated safe local fallback (`/contact` or `/`).

### Regression Verification
Executed `tests/security-open-redirect.test.js`:
- Unit tests against external domains, protocol-relative evasion, backslash tricks, CRLF injection, and matching Host absolute URLs.
- HTTP integration tests verifying 302 responses on `POST /api/newsletter` and `POST /api/contact`.
- **Result:** 2 tests passed, 0 failed.

---

## 3. Deep Dive: Pathao OAuth Refresh-Token Persistence & Recovery (SEC-02)

### Defect Identified
Pathao Courier uses OAuth 2.0 with refresh token rotation. Under this specification:
1. Every token refresh invalidates the previously issued refresh token and returns a new refresh token.
2. In-memory updates in `PathaoAdapter.js` did not write back to `courier_apis` in MySQL.
3. Upon server restart or multi-process execution, stale refresh tokens caused `invalid_grant` rejections.
4. No automatic recovery path existed if the refresh token expired.

### Technical Remediation
Updated [`src/services/courier/adapters/PathaoAdapter.js`](file:///C:/Users/Bappi/.gemini/antigravity/scratch/mrtumi-git/src/services/courier/adapters/PathaoAdapter.js):
1. **Secure Persistence (`persistTokenRotation`):**
   - Updates `this.apiKey`, `this.refreshToken`, and `this.serviceOptions.refresh_token`.
   - Executes parameterized MySQL update against `courier_apis`:
     ```sql
     UPDATE courier_apis
     SET api_key = ?, service_options_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? (or code = ?)
     ```
   - Triggers `onTokenRotated` hook for external listeners.
2. **Automated Credential Recovery:**
   - If `refresh_token` grant fails with HTTP 400 (`invalid_grant`), automatically initiates credential recovery using stored merchant password grant or client credentials.
   - Automatically stores the recovered token pair to the database.

### Regression Verification
Executed `tests/courier-pathao-token-rotation.test.js`:
- `Pathao OAuth: sandbox token refresh and persistence`
- `Pathao OAuth: successful refresh-token rotation and persistence`
- `Pathao OAuth: automatic recovery via credentials when refresh_token is invalid`
- `Pathao OAuth: 401 on booking triggers authenticatedFetch refresh, rotation and transparent retry`
- **Result:** 4 tests passed, 0 failed.
