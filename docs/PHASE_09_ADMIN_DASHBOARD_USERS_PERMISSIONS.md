# Phase 09 — Admin Dashboard, RBAC & Audit

**Status: `IN PROGRESS / NOT COMPLETE`.** The technical route-policy, audit-trigger and MySQL 8.0 migration/test work passes the latest recorded CI run; owner decisions and remaining legacy-handler acceptance work still block closure. Operations must remain blocked until grants and retention decisions are approved. No role grants are assigned automatically.

## Route inventory and authorization

- See [`PHASE_09_LEGACY_ADMIN_ROUTE_INVENTORY.md`](PHASE_09_LEGACY_ADMIN_ROUTE_INVENTORY.md): generated inventory of **252 unique active method/path endpoints from 261 registrations**, including reads, writes, CSV reports, finance, staff, role, order, inventory, configuration, audit, and settings. It records server-side permission, risk, audit behavior, tests, and route status per endpoint. There are 139 unique state-changing endpoints. Nine duplicate method/path registrations resolve by application mount order.
- `legacyAdminRbac` runs after session refresh and before route dispatch. Every authenticated `/admin` path except the login/root flow must resolve to a named policy; currently unmapped paths fail closed (even if a role has unrelated permission keys). Existing router-local `requireAdmin` and explicit dashboard/access/Phase 06/08 permission checks remain in place.
- All authenticated admin POST/PUT/PATCH/DELETE requests require session-bound CSRF. The admin shell adds tokens to existing forms and same-origin `fetch`; login has an explicit CSRF guard; logout is POST + CSRF. The former state-changing `GET /admin/clear-cache` now returns 405, and the action is POST + CSRF.
- The automated policy matrix checks allow/deny for every inventory endpoint. The MySQL HTTP suite sends each non-exempt endpoint as an authenticated zero-grant staff account and expects 403; login, root redirect and self-logout are intentionally exempt. It also covers representative authorized routes, absent grants, inactive staff/session revocation, CSRF rejection, and separate `staff.assign_role` / `roles.grants.manage` controls. This is not a claim that every legacy handler has an authorized business-success test.
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

- MySQL 8.0 migration failure diagnosis: CI run [`40315666404`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40315666404) reproduced `ER_BINLOG_CREATE_ROUTINE_NEED_SUPER` on migration `0009`, statement 2: binary logging was enabled and the database-scoped CI account lacked `SUPER` for trigger creation. This was a server policy/privilege restriction, not malformed trigger SQL. CI now sets `log_bin_trust_function_creators=1` on its disposable MySQL service using root; the schema-scoped migration/test account receives no `SUPER` grant. This CI-only setting is not applied to production.
- Successful final-SHA live MySQL 8.0 CI: [`40317058605`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40317058605) passed on exact SHA `02d253562918d74a9994978ef6f9ecd2803479fa`. All workflow steps succeeded: dependency audit, lint, per-version migration diagnostic, CLI migration lifecycle (up/status repeated/down 9/reapply/down 9), and full MySQL 8.0 HTTP/RBAC/CSRF/audit suite. CI summary/annotations do not expose TAP totals; no remote test counts are claimed.
- Local `npm run verify` on the same source immediately before the final documentation-only commit reported 703 lint checks passed, 48 tests passed, 0 failed, 8 skipped. Skips included local MySQL suites and are not counted as passes.
- Append-only MySQL integration coverage checks UPDATE/DELETE rejection, migration rollback/reapply, preservation of an unrelated trigger and existing audit rows. Trigger limits remain: privileged DDL/TRIGGER-capable operators may remove/bypass them. Production MySQL binlog policy and migration/runtime account separation remain unverified and require deployment-owner review.
- `P09-01` — `IN PROGRESS`: dashboard/poll/popup/assistant implementation exists; provider data remains unavailable, and not every legacy data handler is MySQL-migrated.
- `P09-02` — `IN PROGRESS`: route-policy inventory and blanket unauthorized HTTP coverage are implemented; exhaustive authorized business success for every legacy handler and owner-approved grant mapping are not complete.
- `P09-03` — `IN PROGRESS`: ordinary DML and UI mutation are blocked and tested; privileged DDL bypass remains possible; runtime DB grants and retention/archival policy are unresolved.
- Owner grant approval, vendor/reseller scope approval, production least-privilege grants, and audit retention decision remain **BLOCKED**. Phase 09 must not be marked complete while they remain open.

## Separate phase status

Phase 08 remains **IN PROGRESS / NOT COMPLETE**: provider delivery/settlement remains blocked, return/refund/restock policy awaits owner approval, reservation expiry/OTP/advance work remains open, and production configuration is unverified. Phase 07 remains **IN PROGRESS / NOT COMPLETE**: persistent cart synchronization, approved legal copy/retention, production configuration and remaining acceptance criteria are outstanding.

No production migration/deployment, payment/refund, SMS or external-provider operation occurred.
