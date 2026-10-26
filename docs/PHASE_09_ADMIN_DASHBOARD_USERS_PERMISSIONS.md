# Phase 09 — Admin Dashboard, Users & Permissions

**Status: `IN PROGRESS` (kickoff authorized by the user).** Phase 08 remains independently `IN PROGRESS`; its verified live-MySQL test slice does not close its policy- and provider-dependent work.

## Acceptance scope

- Dashboard figures must come from the active database and use the MySQL/InnoDB production path; unsupported or missing data must be shown as unavailable, never invented.
- Admin accounts, roles and granular permission grants must be managed with server-side authorization, validation, CSRF protection, audit records and safe MySQL transactions.
- Every admin route must enforce permissions server-side; navigation visibility is convenience only. Audit records must not be silently mutable through ordinary admin functionality.
- Add authenticated HTTP tests using MySQL role/grant data for permitted and denied access, including mutations, CSRF, audit and replay where applicable.
- Preserve bilingual Bangla-default/English behavior and the modular Express monolith. Do not alter production data or seed/overwrite owner grants without explicit authorization.

## Implemented — pending MySQL CI verification

- Added `src/repositories/adminDashboardRepository.js`, using the canonical MySQL pool/query client and parameterized SQL for dashboard summaries, Dhaka-local day/week/month ranges, status and traffic breakdowns, approved product/category aggregates, recent orders, fund/expense totals, order polling, unseen-order popup, and assistant report snapshots.
- `src/routes/adminDashboard.js` delegates the dashboard and the listed read paths to the repository when `DB_CLIENT=mysql`; direct SQLite queries remain solely in its local non-MySQL prototype branches. This does not migrate unrelated admin routes or the rest of the application.
- Monetary values are read from integer paisa fields and converted for the existing BDT display. Empty result sets return actual empty/zero aggregates from SQL; unsupported provider account data is a distinct unavailable response.
- Dismiss-new-orders mutation is CSRF-protected. Database failures are passed to the centralized safe error handling; SQL text and credentials are not returned by the repository layer.
- Added repository contract tests and `tests/phase09-dashboard-mysql.test.js` for live MySQL repository, date/status/amount/stock behavior, authenticated HTTP access, and unavailable provider responses. The live suite has not yet run in this checkout's CI.

## Blocked / incomplete

- `P09-01` — `IN PROGRESS`: implementation exists; live MySQL 8.0 CI verification is pending. UI compatibility and date/status/empty/error edge cases must be confirmed against MySQL.
- External SMS/courier metric endpoints always return explicit `503 unavailable`; no provider adapter, authorized credentials, or verified live account data exists. Do not infer delivery or settlement from local settings.
- `P09-02` — `IN PROGRESS`: this dashboard currently requires an admin session but has no dashboard-specific granular permission key/guard. Do not silently invent or seed owner grants. Staff/grant lifecycle, all admin route permission coverage and MySQL HTTP denial tests remain outstanding.
- `P09-03` — `IN PROGRESS`: permission-filtered sidebar coverage, audit-log access/immutability and full MySQL HTTP verification remain outstanding.

## Verification record

- Local `npm run lint` passed (659 checks); the full local `npm test` passed (53 tests: 45 passed, 0 failed, 8 skipped). The live Phase 09 MySQL suite is among the local skips because no MySQL service is available; these are not MySQL passes.
- A dashboard-specific `dashboard.view` guard was explored and removed after it broke the existing Super Admin regression test and no owner-approved grants exist. Current dashboard-specific RBAC remains unresolved and must not be described as implemented.
- Prior Phase 08 live MySQL run `40301701753` verifies only its documented checkout/reservation and admin lifecycle slice; it does not verify this Phase 09 repository.

## Safety gates

No provider calls, fabricated metrics, production migrations/deployment, permission seeding, or owner-policy assumptions. Integrations remain blocked until relevant authorization, credentials and verified evidence exist. Phase 08 return/refund/restock policy remains an owner decision and is not part of this phase's implementation assumptions.
