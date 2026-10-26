# Phase 09 — Admin Dashboard, Users & Permissions

**Status: `IN PROGRESS`.** This sprint adds an additive permission catalog migration and protected MySQL-backed access-management routes. No role grants are assigned automatically. Current changes require a fresh live MySQL 8.0 CI run before their HTTP/migration acceptance can be called verified.

## Implemented in the current sprint — verification pending

- Migration `0008_phase09_admin_access` adds permission definitions for dashboard, order notifications, assistant reports, staff administration, staff-role assignment (`staff.assign_role`), role administration, separate permission-grant administration (`roles.grants.manage`), and audit-log reading. It does **not** assign grants. Separating role administration from role-grant administration prevents a role manager from automatically gaining privilege-assignment power. Its down migration removes only these definitions that are not referenced by a role, preserving in-use permission keys/grants.
- Dashboard, provider widgets, order polling, popup visibility/dismissal, and assistant report routes use explicit server-side permission keys. Sensitive writes require CSRF. Assistant report use and popup dismissal are audited without storing the submitted prompt or order/customer data in the audit event.
- Added `src/repositories/adminAccessRepository.js` and protected routes for staff listing/create/update/status, role listing/create/status/grant replacement, permission catalog read, and paginated audit-log read. Staff deactivation and profile/role changes revoke that user’s persisted web sessions. Passwords are bcrypt-hashed; responses omit hashes. Role grants are allow-listed against permission rows; Super Admin role grants cannot be edited by this workflow.
- Legacy `/admin/users/manage`, `/admin/roles/manage`, and `/admin/permissions/manage` views now read from MySQL-backed repositories when the Phase 09 routes match first. Legacy user/role delete URLs perform safe deactivation, not hard deletion. Permission definitions are migration-managed rather than freely created/deleted through the old CRUD interface.
- Sidebar entries for dashboard, assistant, staff, roles/permission catalog and audit-log access are filtered by effective grants. Other legacy admin navigation/routes still lack consistent granular coverage.
- Audit logs have a permission-protected read path and no application edit/delete endpoints. The system does not yet enforce database-level append-only integrity against privileged direct SQL; Phase 09 is therefore not complete.

## Verification plan in the current branch

- `tests/phase09-dashboard-mysql.test.js` now uses the full application HTTP stack with real MySQL role/grant rows and real password login. It covers dashboard, polling, popup, CSRF dismissal, assistant reporting, permitted/denied admin access, staff create/deactivate/session revocation, role creation/grant changes, malformed role input, permission catalog, audit access/integrity surface and unavailable provider responses.
- Full-stack MySQL 8.0 CI run [`40308315393`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40308315393) passed on code commit `448d2e6a1c60b36422ba825f486a78eea872d58e`. It ran the updated migration up/status/down cycle and `npm test` with `MYSQL_TEST_REQUIRED=true` against the MySQL 8.0 service, including this sprint’s HTTP/RBAC/staff lifecycle tests. Earlier runs `40307130263`, `40307361892`, `40307569714`, `40307775782`, and `40308035675` failed during iterative test fixes; they were superseded by the passing run.
- Local checks: `npm run lint` — 681 checks passed; `npm test` — 53 tests, 45 passed, 0 failed, 8 skipped because local MySQL is absent. Those local skips are not counted as runtime passes. The CI UI confirms the full MySQL test step passed but does not expose its TAP count in the retrieved run summary; no CI test/skip count is fabricated here.
- CI’s MySQL service was live and the Phase 03, 05, 06, 08, and 09 MySQL-gated suites were enabled by the workflow environment. This verifies the implemented current code at the cited SHA; remaining Phase 09 owner/policy items still prevent phase completion.

## Explicitly unresolved / owner decision needed

- **Permission assignment:** which existing staff roles/users should receive each new key (particularly `dashboard.view`, `staff.manage`, `roles.manage`, and `audit_logs.view`). No grant is seeded or assumed; owner or authorized Super Admin must assign least-privilege grants.
- `P09-01` remains `IN PROGRESS` until the new full-stack MySQL HTTP suite passes and polling/popup/assistant behavior is evidenced on this commit.
- `P09-02` remains `IN PROGRESS`: editing roles beyond grants, password reset workflow, broader user-management UX, all admin-route permission coverage, and owner-approved grants remain open.
- `P09-03` remains `IN PROGRESS`: sidebar filtering covers only selected Phase 09 links; map and enforce every legacy admin navigation/route. Application-level audit immutability is not protection from direct privileged SQL; database-level protection and approved retention policy remain unresolved.
- Tenant/vendor isolation is not applicable to the store-wide admin dashboard as currently designed; no vendor-specific dashboard is exposed by these routes.
- Provider SMS/courier metrics remain explicit `503 unavailable`; no provider adapter, authorized credentials, or verified live account data exists.

## Phase 07 and Phase 08

Phase 08 remains `IN PROGRESS` / **NOT COMPLETE**. Its checkout/reservation and admin HTTP slice passed CI `40301701753`, but provider delivery/settlement remains blocked, return/refund/restock policy awaits the owner, reservation-expiry/OTP/advance work remains open, and production configuration is unverified. Phase 07 remains in progress: persistent cart sync, approved legal copy/retention policy, production configuration and remaining end-to-end acceptance criteria remain outstanding.

No production migration/deployment, payment/refund, SMS or external-provider operation occurred.
