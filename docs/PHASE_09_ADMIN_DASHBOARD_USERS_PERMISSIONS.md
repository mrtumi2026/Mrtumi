# Phase 09 — Admin Dashboard, RBAC & Audit

**Status: `IN PROGRESS / NOT COMPLETE`.** The technical route-policy and append-only-DML work is implemented in this branch and awaits final live MySQL 8.0 CI on its resulting commit. Operations must remain blocked until grant and retention decisions are approved. No role grants are assigned automatically.

## Route inventory and authorization

- See [`PHASE_09_LEGACY_ADMIN_ROUTE_INVENTORY.md`](PHASE_09_LEGACY_ADMIN_ROUTE_INVENTORY.md): generated inventory of **259 registered admin method/path pairs**, including reads, writes, CSV reports, finance, staff, role, order, inventory, configuration, audit, and the settings route map. It records the server-side permission, risk, audit behavior, tests, and route status per entry. The 144 state-changing route declarations are enumerated separately by method.
- `legacyAdminRbac` runs after session refresh and before route dispatch. Every authenticated `/admin` path except the login/root flow must resolve to a named policy; currently unmapped paths fail closed (even if a role has unrelated permission keys). Existing router-local `requireAdmin` and explicit dashboard/access/Phase 06/08 permission checks remain in place.
- All authenticated admin POST/PUT/PATCH/DELETE requests require session-bound CSRF. The admin shell adds tokens to existing forms and same-origin `fetch`; login has an explicit CSRF guard; logout is POST + CSRF. The former state-changing `GET /admin/clear-cache` now returns 405, and the action is POST + CSRF.
- The automated policy matrix checks allow/deny for every inventory route. The MySQL HTTP suite sends every inventoried method/path as an authenticated zero-grant staff account and expects 403. It also covers representative authorized routes, absent grants, inactive staff/session revocation, CSRF rejection, and the separated `staff.assign_role` / `roles.grants.manage` controls. This is not a claim that the business handler of every legacy endpoint has an end-to-end success test.
- Existing vendor/reseller admin records are intentionally platform-wide views, not tenant-scoped admin APIs. Vendor/reseller self-service routes use separate portal auth and are outside the `/admin` inventory. Tenant-scoped behavior is not claimed; the owner must confirm whether platform-wide admin scope is intended.
- **Persistence limitation:** many older route handlers still call the prohibited synchronous SQLite facade. A permission-approved request to such a handler may reach the handler and return the existing sanitized MySQL-mode 503 rather than complete the business operation. Route-policy coverage does not claim that all legacy handlers are MySQL-migrated or operationally ready.

## Audit-log integrity

- Migration `0009_phase09_legacy_admin_audit` inserts permission definitions without role grants, and installs MySQL `BEFORE UPDATE` and `BEFORE DELETE` triggers on `audit_logs`. Ordinary UPDATE/DELETE DML is rejected with SQLSTATE `45000`; there are no application endpoints to edit/delete audit events. Direct-DML rejection and application 404/denial behavior are tested against MySQL 8.0.
- Existing Phase 06/08/09 and dashboard audit writers remain (transactional coupling varies by route: Phase 08 and Phase 09 access-management writes are transactional; some Phase 06 writers run after the domain mutation). Other successful legacy admin mutations receive a minimized request event (method, path, permission, result; no request body). CSV report exports receive a minimized export event. Generic legacy auditing is not transactionally coupled to old callback-based writes; if its insert fails, the response is 503 and explicitly says the action may already have applied. Transactional access-management audit failure rolls back the staff/role change. Login success audit failure destroys the newly created session; failed logins remain denied if their audit insert fails.
- **Limits:** triggers protect ordinary DML, not a privileged database operator with DDL/TRIGGER privileges. Such a principal can drop the triggers/table, truncate/restore data, or otherwise alter history. Production runtime `SHOW GRANTS` and migration/runtime account separation have not been inspected; least-privilege production database grants are therefore unverified and must be approved/verified operationally. No cryptographic hash chain or independent tamper-evident export was approved or added.
- No retention, archive, deletion, or legal-hold behavior is implemented. Triggers deliberately prevent ordinary deletion; the down migration removes the triggers but does not delete historical rows.

## Safe provisioning and owner grant decision

Migration `0008` and `0009` add definitions only. They assign **zero** permission grants. The code validates every requested permission key, records role-grant changes, prohibits changing Super Admin grants through staff routes, and requires both the role-management and separate grant-management permissions to replace role grants.

Minimum candidate grants by operational function (these are permission keys, **not assumptions about existing role names**):

| Operational function | Minimum candidate keys | Owner decision needed |
|---|---|---|
| Dashboard viewer | `dashboard.view` | Identify which existing user/role may see store-wide dashboard data |
| Order operator | `orders.manage`; optionally `orders.poll`, `orders.popup.view`, `orders.popup.dismiss` | Approve who may view/change orders and who receives real-time order alerts |
| Refund reviewer | `refunds.review` | Approve who may see customer/refund data and decide refund requests |
| Catalog editor | `catalog.view`, `catalog.manage` | Approve distinct read/edit scope for products, reviews, coupons and categories |
| Inventory operator | `inventory.manage` | Approve stock, supplier and purchase-receiving access |
| Customer/support operator | `customers.manage`; separately `checkout.recovery.view` / `checkout.recovery.manage`; `security.manage` only when needed | Approve access to customer identity/contact data, consented recovery, and IP/security controls |
| Finance reader/operator | `finance.view`; separately `finance.manage` | Approve read vs create/change access to funds, expenses, salaries and withdrawals |
| People/HR operator | `hr.manage` | Approve access to employee, attendance, leave, salary and bonus records; decide whether finance keys are also required |
| Vendor / reseller / delivery operations | `vendors.manage`, `resellers.manage`, `delivery.manage` | Confirm these remain global platform-wide operations or need future tenant separation |
| Content editor | `content.manage` | Approve publishing access to blogs, pages, banners and storefront content |
| Settings/integration operator | `settings.manage`; separately `integrations.manage`; `communications.send` only if expressly authorized | Approve configuration and provider credential/send boundaries; no provider operation is performed by this sprint |
| Reports reader | `reports.view` | Approve access to financial and customer CSV exports; exports are audited |
| Error-log reader/operator | `error_logs.view`; separately `error_logs.manage` | Approve exposure of operational diagnostic data and any log management |
| Staff operator | `staff.manage`; `staff.assign_role` separately | Approve staff lifecycle and who may assign an existing active role |
| Role/grant operator | `roles.manage`; `roles.grants.manage` separately | Approve who may create/deactivate roles vs assign permission keys |
| Audit reader | `audit_logs.view` | Approve who may inspect staff/financial/security audit history |

**Required owner approval:** map these functions to actual existing users/roles, approve exact keys for each, and approve a named provisioning operator. Until then, all grant-dependent operational access is **BLOCKED** for non-Super-Admin users; no grants have been seeded.

## Verification and status

- Previous baseline CI: `40308648157` passed on `dddd7a3878ff0be63dbc783bc2f632844e8d79a5`; this is the starting baseline, not verification of closure-sprint changes.
- Local `npm run verify` on source commit `6239161e5c3a1bbdc8f2d76513ba65b67893ce03` passed: lint reported 694 checks; `npm test` reported 48 pass, 0 fail, 8 skipped. The skips include the MySQL 8.0 integration suites because local MySQL/Docker is unavailable; these are not passes.
- Live MySQL 8.0 CI remains **BLOCKED / FAILED** pending a post-fix run. The original run [`40314190510`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40314190510) on `c0ecb37328547ecb8cabfffccbda6ad2d503a14d` failed during migration verification. The later disposable-MySQL diagnostic run [`40315666404`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40315666404) on `f752da1361dcee33c7701ee3dea95b4f832a1d11` reproduced the exact error: migration `0009`, statement 2, `ER_BINLOG_CREATE_ROUTINE_NEED_SUPER`: `You do not have the SUPER privilege and binary logging is enabled (you *might* want to use the less safe log_bin_trust_function_creators variable)`. This is a MySQL 8.0 binary-log trigger-creator restriction, not evidence of malformed SQL. An ephemeral-CI-only server setting now enables `log_bin_trust_function_creators=1` via root before migration; the database-scoped migration/test user receives no SUPER grant. A post-fix CI run is still required. Production MySQL binlog policy and migration/runtime account separation remain unverified and require deployment-owner review. No remote TAP totals are available.
- `P09-01` — `IN PROGRESS`: dashboard/poll/popup/assistant implementation exists; provider data remains unavailable, and not every legacy data handler is MySQL-migrated.
- `P09-02` — `IN PROGRESS`: route-policy inventory and blanket unauthorized HTTP coverage are implemented; exhaustive authorized business success for every legacy handler and owner-approved grant mapping are not complete.
- `P09-03` — `IN PROGRESS`: ordinary DML and UI mutation are blocked and tested; privileged DDL bypass remains possible; runtime DB grants and retention/archival policy are unresolved.
- Owner grant approval, vendor/reseller scope approval, production least-privilege grants, and audit retention decision remain **BLOCKED**. Phase 09 must not be marked complete while they remain open.

## Separate phase status

Phase 08 remains **IN PROGRESS / NOT COMPLETE**: provider delivery/settlement remains blocked, return/refund/restock policy awaits owner approval, reservation expiry/OTP/advance work remains open, and production configuration is unverified. Phase 07 remains **IN PROGRESS / NOT COMPLETE**: persistent cart synchronization, approved legal copy/retention, production configuration and remaining acceptance criteria are outstanding.

No production migration/deployment, payment/refund, SMS or external-provider operation occurred.
