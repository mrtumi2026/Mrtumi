# Project 01 — Reseller Portal Autonomous Audit, Bug Fix & Consolidated Delivery Report

**Baseline Release:** `9556570` (Admin & Vendor Platform Consolidation)  
**Catalog Release:** `b1acb31` (Product Management Consolidation)  
**Audit & Delivery Date:** 2026-11-14  
**Audit Scope:** End-to-end Reseller Portal menus, submenus, templates, controllers, repositories, database ledgers, tenant isolation, and security.

---

## 1. Inspected Reseller Menus, Submenus, Forms & Workflows

| Menu / Surface | URL / Path | Template / Controller | Workflow Verified |
| :--- | :--- | :--- | :--- |
| **Reseller Auth** | `/reseller/login`<br>`/reseller/register` | `views/reseller/login.ejs`<br>`views/reseller/register.ejs` | Account registration, Bcrypt hashing, pre-auth session rotation, brute-force throttling, and verified partner badge tracking. |
| **Dashboard & Analytics** | `/reseller/dashboard` | `views/reseller/dashboard.ejs`<br>`resellerPanel.js` | Partner status badge, real wallet balance card, pending balance, delivered order profits, and popular wholesale catalog with direct order buttons. |
| **Wholesale Catalog** | `/reseller/products` | `views/reseller/products.ejs`<br>`resellerPortalRepository.js` | Approved product browsing, official vs. reseller pricing modes, live stock visibility across warehouse and vendor stock pools. |
| **Dropship Order Builder** | `/reseller/orders/create` | `views/reseller/order-create.ejs`<br>`resellerOrderRepository.js` | Dynamic variant & pricing quotes (`/reseller/orders/quote`), immutable price snapshots, customer shipping validation (inside/outside Dhaka), idempotency request keys, stock reservation. |
| **Reseller Order History** | `/reseller/orders` | `views/reseller/orders.ejs`<br>`resellerPortalRepository.js` | Tenant-isolated order listing, status filter, keyword search, invoice deep-links, integer paisa amounts, and courier & tracking ID visibility. |
| **Order Details & Self-Cancel** | `/reseller/orders/:id`<br>`/reseller/orders/:id/cancel` | `views/reseller/order-detail.ejs`<br>`resellerPanel.js` | Item breakdown with variant labels, delivery address, courier tracking badge, recorded reseller margin, and self-service order cancellation for pending orders with automatic inventory restoration. |
| **Wallet & Withdrawals** | `/reseller/withdrawals`<br>`/reseller/withdrawals/create` | `views/reseller/wallet.ejs`<br>`partnerWithdrawalRepository.js` | Available and pending wallet balances, minimum ৳100 payout limit, bKash/Nagad/Rocket account submission, transactional balance reservation, and CSRF protection. |
| **Transaction History** | `/reseller/transactions` | `views/reseller/wallet.ejs` (`mode: 'history'`) | Paginated ledger history with `amount_paisa` format, tx_type filter, and status badges. |
| **Shop Profile Settings** | `/reseller/profile` | `views/reseller/profile.ejs`<br>`resellerPanel.js` | Shop profile updates, email verification, password rotation requiring current password, and cross-session revocation. |

---

## 2. Findings, Verified Features & Discovered Defects

### Verified Features
1. **Tenant Isolation:** Resellers can only inspect and mutate their own orders, items, and transactions (`WHERE reseller_id = ?`).
2. **Deterministic Dropship Margins:** `resellerOrderRepository.create` records immutable price snapshots (`order_price_snapshots`) preserving vendor entitlement, reseller margin, and marketplace fees without floating-point drift.
3. **Inventory Isolation:** Order placement reserves inventory from the specific owner (marketplace warehouse vs. vendor stock pool) with row-level locks (`FOR UPDATE`).
4. **Partner Settlements:** Delivered sub-orders mature into `partner_wallets.pending_balance` and transfer atomically to `available_balance` and `resellers.balance_paisa` upon settlement maturity.

### Discovered Defects & Completed Fixes
1. **Defect (High): Canonical Wallet Locked by Inaccurate Notice Banner**
   - *Issue:* In MySQL mode (`canonicalWallet: true`), `views/reseller/wallet.ejs` displayed a static notice stating that balances and financial requests were disabled, hiding the withdrawal form even though `POST /reseller/withdrawals/create` and `partnerWithdrawalRepository.requestResellerWithdrawal` were fully operational.
   - *Fix:* Re-structured `views/reseller/wallet.ejs` to render the live available and pending balances and active withdrawal form for `mode === 'withdrawal'`, an informational policy notice for `mode === 'deposit'`, and a clean ledger overview for `mode === 'history'`.
2. **Defect (High): Reseller Navigation Links Artificially Suppressed**
   - *Issue:* `router.use('/reseller')` set `res.locals.allowOrderCreation = false; res.locals.allowFinancialMutations = false;`, which caused the sidebar in `layout-top.ejs` to hide the "Place Reseller Order" link and replace the wallet links with a history-only link. Similarly, `orders.ejs` and `dashboard.ejs` hid their "+ নতুন অর্ডার" buttons when `canonicalOrders` was true.
   - *Fix:* Enabled `allowOrderCreation = true` and `allowFinancialMutations = true` in `src/routes/resellerPanel.js`, and updated `dashboard.ejs`, `orders.ejs`, and `layout-top.ejs` so action buttons are accessible.
3. **Defect (Medium): Topbar & Dashboard Balances Unlinked from `partner_wallets`**
   - *Issue:* `resellerPortalRepository.getProfile` and `authRepository.findResellerById` only selected `balance_paisa` from the `resellers` table, failing to include `partner_wallets.available_balance` and `partner_wallets.pending_balance`.
   - *Fix:* Joined `partner_wallets` in both queries, returning normalized `available_balance`, `pending_balance`, `balance`, and `deposit_amount` in BDT and integer paisa.
4. **Defect (Medium): Courier & Tracking ID Missing in Order Detail View**
   - *Issue:* `getOrderDetails` in `resellerPortalRepository.js` omitted `courier_code`, `courier_tracking_id`, and `reseller_margin_paisa`.
   - *Fix:* Added `courier_code`, `courier_tracking_id`, and `reseller_margin_paisa` to the query and rendered them clearly on `order-detail.ejs` and `orders.ejs`.
5. **Defect (Medium): No Self-Service Pending Order Cancellation**
   - *Issue:* Resellers had no mechanism to cancel an errant pending order before dispatch.
   - *Fix:* Mounted `POST /reseller/orders/:id/cancel` protected with CSRF and owner validation. Calling `phase08Repository.transitionOrder` moves the order to `cancelled`, releases the reserved inventory, and records audit logs transactionally.

---

## 3. Files Modified & Integer Paisa Compliance

| Modified File | Summary of Changes | Integer Paisa Strictness |
| :--- | :--- | :--- |
| `src/repositories/resellerPortalRepository.js` | Joined `partner_wallets` on `getProfile`; added `total_earned_paisa` sum to `getDashboardSummary`; added courier fields and `reseller_margin_paisa` to `getOrderDetails`. | Strictly BIGINT paisa (`balance_paisa`, `available_balance_paisa`, `pending_balance_paisa`, `total_earned_paisa`). |
| `src/repositories/authRepository.js` | Updated `findResellerById` to left join `partner_wallets` and expose `available_balance` and `pending_balance`. | Exact decimal division `/ 100` for presentation only. |
| `src/routes/resellerPanel.js` | Enabled `allowOrderCreation` and `allowFinancialMutations`; linked live delivered earnings to dashboard profit stat; mounted CSRF-guarded `POST /reseller/orders/:id/cancel`. | Handled through canonical repository paisa contracts. |
| `views/reseller/wallet.ejs` | Rendered live withdrawal request form with minimum ৳100 limit, CSRF, available/pending balances, and clean transaction table. | Uses `formatPaisa` helper with BigInt math. |
| `views/reseller/dashboard.ejs` | Linked commission wallet balance, pending balance, delivered profit, and product order buttons. | Uses `formatPaisa` and locale currency formatting. |
| `views/reseller/orders.ejs` | Unhid "+ নতুন অর্ডার" button; added courier & tracking column. | Formats paisa via BigInt helper. |
| `views/reseller/order-detail.ejs` | Displayed courier tracking badges, reseller margin, and self-service order cancellation for pending orders. | Uses `formatPaisa` helper. |
| `tests/reseller-portal-consolidation.test.js` | Added 5 comprehensive regression tests covering profile balances, dashboard margin aggregation, order tracking details, template rendering, and route CSRF declarations. | Verified against integer paisa assertions. |

---

## 4. Test Verification Totals

- **Foundation Check:** **1,774 checks passed**, **0 failed** (`scripts/check-foundation.js`).
- **Full Test Suite:**
  - **Passed:** **426** tests
  - **Failed:** **0** tests
  - **Skipped:** **32** tests (all disposable MySQL/MariaDB integration tests running in CI)
  - **Total:** **458** tests across **21** suites

---

## 5. Database Migration Status

- **Migration Requirement:** **0 migrations required**.
- **Evidence:** `partner_wallets`, `partner_transactions`, `reseller_financial_ledger`, `order_price_snapshots`, and `orders` (with `courier_code`, `courier_tracking_id`, `reseller_margin_paisa`) exist in canonical MySQL migrations `0023_cod_suborder_settlement_reversal.up.sql` and `0015_phase08_canonical_orders.up.sql`. No schema modifications were needed.

---

## 6. One Consolidated Production Deployment Instruction

In accordance with owner release guidelines, intermediate releases (`b1acb31` and `9556570`) were held so that **ONE safe consolidated fast-forward deployment command** delivers all approved work together:
1. Product Management Consolidation (`b1acb31`): Categories, subcategories, brands, flexible units, and variant pricing/stock.
2. Admin & Vendor Platform Consolidation (`9556570`): Withdrawal ledgers, partner verifications, delivery audit, and paid action guards.
3. Reseller Portal Consolidation (current commit): Live wallet withdrawals, order creation, tracking visibility, self-service order cancellation, and dashboard metrics.

### Consolidated Deployment Command (cPanel Terminal / SSH):
```bash
cd ~/public_html && \
git fetch origin main && \
git status --porcelain && \
git merge --ff-only origin/main && \
mkdir -p tmp && touch tmp/restart.txt && \
npm run deploy:verify
```

---

## 7. Genuine Owner Decisions Required

1. **Online Security Deposit Policy:** Reseller security deposits are currently recorded manually or managed via admin support. When an online payment gateway (e.g., bKash Merchant API) is ready for direct deposit top-up, the deposit submission form can be activated with automated webhooks.
2. **Automated Courier API Booking:** Steadfast and Pathao code adapters are operational in sandbox/mock mode. Live booking on courier systems requires the merchant's live API credentials in Admin Settings.
