# Mr. Tumi Grocery & Gift — Owner Decisions Required for Production Launch

**Document Purpose:** Authoritative classification and actionable register of business and operational decisions requiring owner determination prior to live public operations.  
**Governing Register:** `docs/OWNER_DECISION_REGISTER.md`  
**Classification Categories:**
1. `Owner approval required` — Code is ready and tested; owner must select a policy option or provide operational authorization.
2. `Already approved with documented evidence` — Formally decided by the owner with historical record.
3. `Not applicable` — Defunct, legacy, or superseded by current architectural baseline.
4. `Blocked pending external configuration` — Technical prerequisite (e.g. host accounts, commercial provider keys, DNS pointing) must be completed before policy can activate.

**Core Rule:** The codebase implements safe fail-closed defaults for all unapproved items. No live money, provider API dispatch, or data destruction will occur without explicit recorded decisions.

---

## 1. Master Classification Matrix (D1 — D12)

| Decision ID | Topic | Current Classification | Recommended Option | Operational Impact of Pending State |
|---|---|:---:|---|---|
| **D1** | Operational-role permission grants | **Owner approval required** | Option B (Super Admin only until specific staff emails and roles are designated) | Non-super-admin staff cannot perform grant-dependent mutations. |
| **D2** | Audit retention, archive, deletion and legal hold | **Owner approval required** | Option A (Retain all records indefinitely; defer purge) | Immutable append-only `audit_logs` are preserved without deletion. |
| **D3** | Vendor/reseller access scope & tenant boundary | **Owner approval required** | Option B (Strict tenant isolation on products/sub-orders) | Vendors fulfill own sub-orders; parent order completed by tracking or admin. |
| **D4** | Production DB account/privilege separation | **Blocked pending external configuration** | Option B (Single cPanel MySQL account in production `.env`) | Awaiting BestWebHostBD cPanel database user creation. |
| **D5** | Perishable inventory lot/batch/expiry/FEFO | **Owner approval required** | Option B (Aggregate stock tracking with low-stock alerts) | Aggregate inventory is active; no lot/batch tracking is enforced on non-designated items. |
| **D6** | Legal copy, customer privacy, and password recovery | **Owner approval required** | Option B for copy (review draft pages); Option A for recovery once SMS/SMTP is live | Draft policy pages display review notice; self-service password recovery is disabled. |
| **D7** | Order cancellation, return/restock, and refund settlement | **Owner approval required** | Keep cancellation within pre-dispatch window; internal refund review only | Returns logged with photo evidence; no automated bank/MFS payout occurs. |
| **D8** | External advertising integrations and Purchase events | **Blocked pending external configuration** | Option A (Keep external dispatch disabled until Pixel IDs provided) | `ANALYTICS_ATTRIBUTION_ENABLED=false`; zero user data shared with third parties. |
| **D9** | Android canonical HTTPS origin & WebView allowlist | **Blocked pending external configuration** | Option B (Defer Android app release until web launch confirmed) | Web application on `https://mrtumi.com` serves all mobile web traffic. |
| **D10** | Android signing key custody & release ownership | **Blocked pending external configuration** | Option A (Owner-held key custody outside source control) | Zero signing keys or certificates are stored in Git. |
| **D11** | Production deployment change request & maintenance window | **Owner approval required** | Option A (Owner schedules deployment window with rollback ready) | No live deployment or DNS pointing is performed autonomously by agents. |
| **D12** | Production hosting facts (BestWebHostBD cPanel & Node.js 22) | **Blocked pending external configuration** | Option A (Verify cPanel runtime via SSH/Terminal before launch) | Awaiting host account login and production `.env` setup by owner. |

---

## 2. Detailed Decision Specifications & Action Items

### Decision D1: Staff Permission Grants (RBAC)
- **Status:** `Owner approval required`
- **Context:** The admin portal supports granular server-side permissions (`orders.manage`, `catalog.manage`, `inventory.manage`, `refunds.review`, `settlements.approve`, `settings.manage`).
- **Current Behavior:** Least-privilege safe mode. Only the authenticated super-admin holds platform-wide rights. Other staff roles cannot access unassigned mutation routes.
- **Action Required from Owner:** Provide the email addresses and requested roles (e.g., Order Manager, Catalog Editor, Customer Support, Finance Officer) for any operational staff members.

---

### Decision D2: Audit Log Retention, Archive & Purge
- **Status:** `Owner approval required`
- **Context:** `audit_logs` records every administrative change, price update, inventory adjustment, return decision, courier override, and financial reversal.
- **Current Behavior:** Append-only indefinite retention with zero purge.
- **Action Required from Owner:** Determine whether to keep records indefinitely (recommended for tax/compliance) or establish a purge/archive window (e.g. 365 days).

---

### Decision D3: Vendor & Reseller Access Scope
- **Status:** `Owner approval required`
- **Context:** Multi-vendor orders create sub-orders (`vendor_sub_orders`). Each vendor prepares their package, compares courier quotes, and executes physical courier handover.
- **Current Behavior:** Strict tenant isolation. Vendors can only inspect and act upon their own order lines. A vendor cannot transition another vendor's sub-order or the parent order.
- **Action Required from Owner:** Formally confirm the sub-order fulfillment architecture where automated tracking sync or platform administration triggers final parent order delivery.

---

### Decision D4: Production DB Account Separation
- **Status:** `Blocked pending external configuration`
- **Context:** Separation of least-privilege DML user (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) from migration DDL user (`CREATE TABLE`, `ALTER`, `DROP`).
- **Current Behavior:** Single application user configured in `DB_USER` in `.env`.
- **Action Required from Owner:** In BestWebHostBD cPanel, decide whether to provision two separate MySQL users or use the single cPanel MySQL user credentials.

---

### Decision D5: Perishable Grocery Lot/Expiry Rules (FEFO)
- **Status:** `Owner approval required`
- **Context:** Mr. Tumi sells both shelf-stable grocery/gifts and perishable fresh items.
- **Current Behavior:** Aggregate stock tracking with unit-cost ledger and low-stock warnings.
- **Action Required from Owner:** Specify if any specific product classes (e.g., fresh dairy, bakery) require individual lot/batch tracking and First-Expired-First-Out (FEFO) write-offs.

---

### Decision D6: Legal, Privacy Copy & Password Recovery
- **Status:** `Owner approval required`
- **Context:** Public policy pages (`/privacy-policy`, `/faq`, `/contact`) contain draft terms with `copyReview` notices. Customer account password recovery requires an authorized, verified delivery channel (SMS or SMTP email).
- **Current Behavior:** Public policies display draft notices. Self-service password recovery route returns HTTP 503 ("Service Temporarily Unavailable") to prevent unauthorized account takeover.
- **Action Required from Owner:**
  1. Review and approve the final bilingual terms of service and privacy text for `mrtumi.com`.
  2. Authorize BulkSMSBD OTP or transactional SMTP as the verified delivery channel for account recovery.

---

### Decision D7: Order Cancellation, Returns & Refund Payouts
- **Status:** `Owner approval required`
- **Context:** Customer portal allows pre-dispatch cancellation requests, itemized return submissions with photo evidence, and refund request logging.
- **Current Behavior:**
  - Cancellations permitted only prior to shipment.
  - Return requests are logged for administrative inspection; item dispositions (`restock`, `damaged_writeoff`, `vendor_return`) are recorded with audit evidence.
  - Refund requests record the requested amount in paisa without automatic banking transfer.
- **Action Required from Owner:**
  1. Confirm cancellation window deadline (e.g., up to status `processing` / prior to courier booking).
  2. Establish offline/online refund payout workflow (e.g., finance team manual bKash/Nagad transfer against recorded refund request).

---

### Decision D8: External Advertising Pixels & CAPI
- **Status:** `Blocked pending external configuration`
- **Context:** Meta Pixel, Conversions API (CAPI), TikTok Pixel, and Google Tag Manager code paths exist in the application.
- **Current Behavior:** Disabled by default (`ANALYTICS_ATTRIBUTION_ENABLED=false`).
- **Action Required from Owner:** Supply verified Pixel IDs and authorize data-sharing consent terms before enabling.

---

### Decisions D9 & D10: Android Mobile Application
- **Status:** `Blocked pending external configuration`
- **Context:** Android WebView project structure is available for mobile publishing.
- **Current Behavior:** Source code available; release builds and signing disabled.
- **Action Required from Owner:** Confirm web domain is live on HTTPS and manage signing keystores securely outside source control.

---

### Decision D11: Production Deployment Change Request
- **Status:** `Owner approval required`
- **Context:** Deployment of branch `antigravity/final-launch-readiness` to live BestWebHostBD cPanel hosting.
- **Current Behavior:** Codebase is fully verified in CI; zero live production access has been performed.
- **Action Required from Owner:** Schedule deployment change window, take full hosting backup, and execute release.

---

### Decision D12: Production Hosting Runtime Facts
- **Status:** `Blocked pending external configuration`
- **Context:** BestWebHostBD cPanel interface, Node.js 22 virtualenv path, MySQL host/port/database strings.
- **Current Behavior:** Tested against identical Linux Node 22.23.4, MySQL 8.0, and MariaDB 10.11 engines in CI.
- **Action Required from Owner:** Input the exact server facts into `/home/username/mrtumi/.env`.
