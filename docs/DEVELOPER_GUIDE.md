# Developer guide

Read `../HANDOVER.md` first for current status and known gaps.

## 1. Layout

| Path | Content |
|---|---|
| `app.js` / `server.js` | Passenger startup file / Express app and route mounting |
| `src/routes/` | HTTP routes, one file per portal or area (`admin*`, `vendor*`, `reseller*`, `affiliate*`, `customer*`, `storefront.js`) |
| `src/repositories/` | MySQL queries and transactions. Business money rules live here |
| `src/services/` | Mail, SMS, courier, referral, affiliate, wallet and pricing services |
| `src/middleware/` | Sessions, RBAC, CSRF, uploads, rate limits, security headers |
| `src/db/` | MySQL pool, migrator, `migrations/NNNN_name.up.sql` + `.down.sql` |
| `src/i18n/` | `bn` and `en` dictionaries; lint requires identical keys |
| `views/` | EJS templates per portal |
| `public/` | Static assets |
| `tests/` | `node:test` suites |
| `scripts/` | Migrate, lint (`check-foundation.js`), health check, `ops/` release tooling |
| `android/`, `ios/` | Mobile wrapper apps (not part of the web release) |

## 2. Local setup

Requires Node 22 and MySQL 8 or MariaDB 10.11. Copy `.env.example` to `.env`. Set `SESSION_SECRET`, `CSRF_SECRET` (32+ random characters) and the `DB_*` values with `DB_CLIENT=mysql`.

Production is MySQL only. Some routes still contain an old SQLite branch for local sandbox use; check which branch you are editing (`mysqlActive()`). A fix in the SQLite branch does not reach production.

## 3. Tests

Integration tests need a **disposable** database (they write and delete data):

```bash
export MYSQL_TEST_REQUIRED=true MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_PORT=3306
export MYSQL_TEST_DB=mrtumi_test MYSQL_TEST_USER=... MYSQL_TEST_PASSWORD=...
npm run lint && npm test && npm audit --omit=dev
```

Run `npm test` with `DB_CLIENT`/`DB_NAME` unset so it cannot reach a real database. CI (`.github/workflows/ci.yml`) runs the same on MySQL 8.0 and MariaDB 10.11.

Unit tests alone do not prove a screen works. Submit the real form in a browser for any change to a form, view or route.

## 4. Money rules

- Money is stored as integer **paisa** (`*_paisa`). No FLOAT/DOUBLE. When SQL converts for display, cast to `DECIMAL(20,2)`.
- Change balances inside a transaction, lock the row, and write the matching ledger row.
- Vendor: `vendor_sub_orders`, `vendor_wallets` (`pending_settlement` → `available_balance`), `vendor_transactions`. Release needs delivery, COD reconciliation and the return window.
- Reseller: `partner_wallets`, `partner_transactions`, `resellers.balance_paisa`, `reseller_financial_ledger`. Own-product earning: delivered → admin "Money received" → return window → release.
- Customer wallet at checkout: at most N% (admin setting, default 20) of product price after coupon, delivery excluded; see `customer_wallet_transactions`.
- Withdrawals are paid by hand; the system records them.
- Stock is reserved at order time and consumed on shipment or delivery. Cancel must release it and close vendor sub-orders.

## 5. Making a change

1. Branch from `main`.
2. Views: every form needs CSRF; keep both `bn` and `en` text; keep `<script>` tags balanced.
3. Permissions: protect admin routes with `requirePermission(...)`; vendors may only touch their own rows.
4. Schema: add a new numbered up/down migration pair. Never edit an applied one. Money, auth and schema changes need the owner's approval.
5. Run section 3, then open a pull request.
6. Keep every super admin option; repair a broken one instead of removing it.

## 6. Release (cPanel)

`deploy.sh <40-char commit> <signed ticket> <tag>`. It checks an owner-signed ed25519 ticket against a trust anchor stored outside the repository, rehearses on a separate database, backs up, migrates and health-checks. See `../DEPLOYMENT.md`. Never create or sign a ticket on the owner's behalf. After release, check `/health`, one test order and the portal logins.

Third-party keys (SMTP, SMS, courier) are entered in the admin panel or server environment, never in Git. Only BulkSMSBD is implemented for SMS. Unused payment gateway endpoints are intentionally disabled.
