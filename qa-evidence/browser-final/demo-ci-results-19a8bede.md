# Disposable DEMO browser E2E results

- Tested source SHA: `19a8bede4bcfafb040564808c5e29d43824279c4`
- Workflow run: [41220988284 — Disposable DEMO browser E2E](https://github.com/mrtumi2026/Mrtumi/actions/runs/41220988284)
- Databases: disposable MySQL 8.0 and MariaDB 10.11 GitHub Actions service containers; separate service/database per matrix job.
- Browser: Playwright Chromium installed by the workflow.
- Data boundary: only the fresh CI schema `mrtumi_test`; no production database or existing SQLite file was used.
- External operations: none. The checkout journey uses COD only; no payment, courier, OTP, email, SMS, refund, or payout provider was called.

## Actual journey results

| Journey | MySQL 8.0 | MariaDB 10.11 | Evidence detail |
|---|---|---|---|
| Public storefront: five bilingual DEMO product detail pages | PASS | PASS | Product screenshots `product-1.png` through `product-5.png`; storefront screenshots at 360, 390, 768, and 1366 px. |
| Two customer registrations, fresh logins, cart add, normal COD checkout, order records and account history | PASS | PASS | Browser-created customer accounts and two order records per engine; customer registration, cart, checkout, order-success and history screenshots. Passwords were generated only for CI fixtures and are not included in public logs/artifacts. |
| Eligible pre-dispatch cancellation | PASS | PASS | Browser cancellation recorded for a pending COD fixture order; demo vendor-stock reservation returned to zero. |
| Vendor login and tenant-scoped order visibility for both synthetic vendors | PASS | PASS | Each vendor logged in separately, saw its assigned order and did not see the other vendor's order. Vendor order screenshots included. The observed MySQL login failure from the earlier attempt was fixed to use canonical MySQL authentication; contract regression test added. |
| Admin order management using an existing admin | BLOCKED | BLOCKED | Fresh migration-only CI schema has no existing admin user or credentials. No admin account was created, consistent with the no-new-admin requirement. |
| Return request/review | BLOCKED | BLOCKED | No return-eligible category policy exists in the fresh schema. No policy was invented or changed; demo orders also remain pending and unfulfilled. |

**Totals per database engine:** 6 journey checks: 4 PASS, 0 FAIL, 2 BLOCKED.  
**Combined:** 12 checks: 8 PASS, 0 FAIL, 4 BLOCKED.

## Cleanup and disposable environment

The runner migrated down all 13 schema versions after capturing evidence. Cleanup verification reported **0 application tables** and **0 migration rows** remaining in each database. GitHub Actions then successfully stopped each database service container. The result JSON includes generated record IDs, invoices, audit-event evidence where present, server version, viewport measurements, and cleanup counts.

## Screenshots and logs

The workflow uploaded the actual run output as retained GitHub Actions artifacts (30-day retention):

- [MySQL 8.0 artifact (`demo-browser-evidence-MySQL 8.0`, artifact ID 13049788560)](https://github.com/mrtumi2026/Mrtumi/actions/runs/41220988284)
- [MariaDB 10.11 artifact (`demo-browser-evidence-MariaDB 10.11`, artifact ID 13050520140)](https://github.com/mrtumi2026/Mrtumi/actions/runs/41220988284)

Each artifact contains `journey-results.json`, `runner.log`, and the Playwright screenshots for that engine. CI logs also contain the per-engine status summary. The workflow, rather than this repository checkout, is the source for the binary screenshot files.

## Verification

Local `npm run verify` on the tested source SHA: foundation **1000 checks passed**; Node test suite **171 total, 147 passed, 0 failed, 24 skipped** (database-dependent tests run in CI). The exact-SHA standard MySQL/MariaDB CI run was still completing when this evidence note was prepared; its run is [41220988154](https://github.com/mrtumi2026/Mrtumi/actions/runs/41220988154). The evidence-document commit triggers a fresh run at its final SHA.
