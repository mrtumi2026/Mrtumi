# Release Validation — Integrated Build (code commit `27315bc`)

Principal release-engineering record for the integrated pre-launch build on
`arena/b73fcbd6-mrtumi`. No deployment, production data, or live provider call
was performed.

## 1. Premise correction

The requested migration `0030` state (`payment_pending`, verification-status
enhancements) does not exist in this repository. `0030` is the multi-vendor
commerce engine, and the "payment_pending" concept is implemented as
`payment_status='pending_verification'` in `0033`. No such state was invented;
the existing migration was validated and hardened instead.

## 2. Branch integration analysis

| Branch | Reported SHA | Branch head | Ancestry result |
|---|---|---|---|
| Customer Portal | `08d73f19` | `53ba67ff` (`arena/e012be98-mrtumi`) | Both are ancestors of this branch and of `main` |
| Courier & Delivery | `5c6ac55` | `317adb67` (`antigravity/courier-hardening`) | Both are ancestors of this branch and of `main` |

Both feature branches were **already integrated** into `main` before this
branch's base (`56bc9c1`). `main` then advanced 59 commits (courier booking
requests and recovery, vendor storefront branding, recovery protocol, security
hardening). Those 59 commits — not the two feature branches — were the real
integration gap. They were merged as `27315bc`.

`main` also independently landed equivalent fixes for the defects this branch
found (portable DDL, duplicate `gateway_type`, checkout TDZ). Where both sides
fixed the same defect, `main`'s verified implementation was taken and this
branch's duplicate change was dropped. The unique safeguards retained are
listed in §4.

## 3. Migration `0028` collision — ownership and sequence

The duplicate version was already resolved on the courier line by commit
`1d8c937` ("resolve migration collision to 0029"):

- `0028_admin_test_data_management.*` owns version `0028`.
- `0029_multi_courier_engine.*` owns version `0029` (renamed from `0028`).

No file was skipped, renamed arbitrarily, or bypassed. The final directory has
**38 contiguous pairs, `0001`–`0038`, one `.up.sql` + one `.down.sql` each**
(`0037_vendor_store_branding`, `0038_vendor_courier_booking_requests`).
`loadMigrationPairs()` rejects gaps, duplicates, and missing rollbacks; the
foundation check and CI migration diagnosis both pass.

## 4. Merge reconciliation decisions (`27315bc`)

| Area | Resolution |
|---|---|
| Phase B fulfilment repository | Took `main`'s implementation: unknown `delivery_mode` fails closed with `CONFLICT`; booking never records pickup; handover is platform-only for platform-managed shipments |
| Checkout OTP | Took `main`'s ordering fix; unverified OTP is `CONFLICT`, matching the live-suite contract |
| Gateway selection | Took `main`'s `status=1 AND (is_active=1 OR is_active IS NULL)` create-order gate |
| `0033` | **Kept this branch's non-destructive deactivation** instead of `DELETE FROM payment_gateways`; rollback now also deactivates rather than deletes |
| `0030` | Kept version-header correction and the `gateway_type`-already-exists note (main removed the duplicate add separately) |
| Courier API RBAC | Kept `settings.manage` mapping, matching the route-level contract asserted by `tests/courier-operational-recovery.test.js` |
| Static-evidence exposure | `main`'s `src/middleware/customerReturnEvidence.js` supersedes this branch's inline guard |
| Foundation guard | Kept a narrowed guard rejecting unadapted `CREATE/ADD INDEX IF NOT EXISTS`; `ALTER ... IF [NOT] EXISTS` is normalized for MySQL by `adaptStatementForEngine` and covered by migrator tests |
| Duplicate-column guard | Kept the migration schema simulation that fails on any duplicate `ADD COLUMN` |
| Live MySQL suite | Adopted `main`'s OTP contract; retained driver-code diagnostics on refusal failures |

## 5. Invariants preserved

- No forward migration drops tables/columns or deletes business rows.
- Parent order lifecycle, table primary keys, and checkout transactions are
  unchanged by this work.
- No return, refund, privacy, delivery, or settlement policy was invented.
- Existing Grocery, Admin, Vendor, Reseller, POS, inventory, and security
  functionality is retained; the merge only adds `main`'s newer work.

## 6. Verification evidence

### Local (sandbox, no database service)

| Gate | Result |
|---|---|
| `npm run lint` | **1899 checks passed, 0 failed** |
| `npm test` | **602 tests, 563 passed, 0 failed, 39 skipped** (DB-gated) |
| Production dependency audit | 0 high/critical vulnerabilities (CI step) |

### CI — MySQL 8.0 and MariaDB 10.11 (both PASS)

- Push run: <https://github.com/mrtumi2026/Mrtumi/actions/runs/44773274851>
- PR run: <https://github.com/mrtumi2026/Mrtumi/actions/runs/44773289866>

Both engine jobs passed: foundation lint/SQL/secret scan, per-migration
diagnosis on a fresh schema, CLI migrator `up -> status -> down -> up`,
backup/restore rehearsal, full reapply, and the complete unit + portal
regression + live MySQL/MariaDB integration suites.

### Browser E2E (both engines PASS, 6 journeys each)

- Push run: <https://github.com/mrtumi2026/Mrtumi/actions/runs/44773274937>
- PR run: <https://github.com/mrtumi2026/Mrtumi/actions/runs/44773289931>

Journeys: public storefront; customer registration/login/cart/COD
checkout/order history; customer pre-dispatch cancellation; admin login, order
management and test-data cleanup; vendor login/tenant isolation; return
request with evidence upload and policy-authorized review.

### Journey coverage map (live suites + E2E)

| Capability | Where verified |
|---|---|
| Customer profile, password, address management | `tests/phase09-dashboard-mysql.test.js`, `tests/phase07-customer-account.test.js` |
| Saved-address checkout, invoice, order history | `tests/phase05-mysql.test.js`, `tests/phase08-*` |
| Cancellation | E2E journey 3, `tests/d7-workflows.test.js` |
| Return evidence / refund request | E2E journey 6, `tests/phase07-customer-account.test.js`, `tests/financial-reconciliation.test.js` |
| Vendor workflow | E2E journey 5, `tests/vendor-*`, `tests/phase09-dashboard-mysql.test.js` |
| Courier booking/tracking (mock adapter) | `tests/multi-courier-engine.test.js`, `tests/courier-adapters.test.js`, `tests/courier-operational-recovery.test.js` |
| Admin management | E2E journey 4, `tests/phase09-dashboard-mysql.test.js` |
| Storefront | E2E journey 1, `tests/phase05-mysql.test.js` |

The courier mock-booking assertions were reviewed: they assert the documented
sandbox contract (`sandbox_mock`, mock carrier/tracking references) and pass on
both engines. No defect was found, so the contract was not changed.

### Disposable data

CI uses disposable schemas (`mrtumi_test`) recreated from migrations; the
browser runner performs guaranteed cleanup and records its status in
`journey-results.json`. No production data or live provider was touched.

## 7. Known limitations

- The Android APK workflow fails in its **Setup Android SDK** step
  (<https://github.com/mrtumi2026/Mrtumi/actions/runs/44773274871>), before any
  project build. This is CI infrastructure/tooling, outside the database and
  browser acceptance gates; no application code is involved.
- CI artifacts (raw logs, screenshots) are retained by GitHub but cannot be
  downloaded from this sandbox (blob-storage egress blocked). Job/step results
  above are the authoritative record.

## 8. Deployment order (not executed)

1. Verified backup and restore rehearsal.
2. `npm run migrate:status` against staging (expect 38 applied/pending as
   appropriate).
3. `npm run migrate:up` with `CONFIRM_PRODUCTION_MIGRATION=true` only after
   owner authorization.
4. Re-check status/checksums; rehearse `migrate:down 1` on a disposable clone.
5. `/health`, then booking/handover and checkout smoke journeys.

Deployment and merging into `main` require separate authorization.
