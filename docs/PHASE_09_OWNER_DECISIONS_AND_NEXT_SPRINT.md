# Phase 09 — Supporting Owner Decision Details & Next-Sprint Acceptance Plan

**Phase status: `IN PROGRESS / NOT COMPLETE`.** This is a supporting detail and historical work-priority document, not a separate decision register or approval record. The single authoritative decision log is [`OWNER_DECISION_REGISTER.md`](OWNER_DECISION_REGISTER.md). No owner response or operational grant is recorded here. Until the corresponding central decision is explicitly approved, do not assign permissions, configure retention/deletion, or change production database privileges.

## Supporting detail for canonical decisions D1–D4

Complete supporting details here if needed, but record the actual decision/status, approving identity and date only in the canonical register. Do not substitute a role label for the actual user/role identifiers to which permission grants would apply.

### D1 — Operational-role permission grants

The permission key catalog and candidate minimum matrix are in [`PHASE_09_ADMIN_DASHBOARD_USERS_PERMISSIONS.md`](PHASE_09_ADMIN_DASHBOARD_USERS_PERMISSIONS.md). The current database migrations define keys only and grant none. This table is a blank approval register, not an authorization request already granted.

| Function | Candidate minimum key(s) | Existing role name + slug to receive access | Actual user IDs (if direct assignment is proposed) | Approve / reject / revise | Conditions / scope / separation | Approver + date |
|---|---|---|---|---|---|---|
| Dashboard viewer | `dashboard.view` | **PENDING** | **PENDING** | **PENDING** | Store-wide data visibility must be explicitly accepted | **PENDING** |
| Order operator | `orders.manage`; separately decide alert keys `orders.poll`, `orders.popup.view`, `orders.popup.dismiss` | **PENDING** | **PENDING** | **PENDING** | Separate viewing/changing orders from alert delivery where appropriate | **PENDING** |
| Refund reviewer | `refunds.review` | **PENDING** | **PENDING** | **PENDING** | Review/decision only; no provider settlement is implied | **PENDING** |
| Catalog reader/editor | `catalog.view`, `catalog.manage` | **PENDING** | **PENDING** | **PENDING** | Decide whether read and mutation access are separate | **PENDING** |
| Inventory/purchasing | `inventory.manage` | **PENDING** | **PENDING** | **PENDING** | Stock adjustment, supplier, purchasing and receiving boundaries | **PENDING** |
| Customer/support | `customers.manage`; separately `checkout.recovery.view`, `checkout.recovery.manage`, `security.manage` | **PENDING** | **PENDING** | **PENDING** | Customer PII, consent and security controls require explicit scope | **PENDING** |
| Finance | `finance.view`; separately `finance.manage` | **PENDING** | **PENDING** | **PENDING** | Separate read vs write; specify any salary/withdrawal restrictions | **PENDING** |
| HR/people | `hr.manage` | **PENDING** | **PENDING** | **PENDING** | Decide whether salary/bonus visibility also requires finance keys | **PENDING** |
| Vendor operations | `vendors.manage` | **PENDING** | **PENDING** | **PENDING** | See D3; global vs partner-scoped is unresolved | **PENDING** |
| Reseller operations | `resellers.manage` | **PENDING** | **PENDING** | **PENDING** | See D3; global vs partner-scoped is unresolved | **PENDING** |
| Delivery operations | `delivery.manage` | **PENDING** | **PENDING** | **PENDING** | Specify delivery and withdrawal scope | **PENDING** |
| Content | `content.manage` | **PENDING** | **PENDING** | **PENDING** | Publishing boundary and review requirements | **PENDING** |
| Settings/integrations | `settings.manage`; separately `integrations.manage`; `communications.send` only by explicit approval | **PENDING** | **PENDING** | **PENDING** | No credentials, messages or external provider operation is authorized by this matrix | **PENDING** |
| Reports | `reports.view` | **PENDING** | **PENDING** | **PENDING** | Includes CSV export access; exports are audited | **PENDING** |
| Operational error logs | `error_logs.view`; separately `error_logs.manage` | **PENDING** | **PENDING** | **PENDING** | Decide which staff may see diagnostic context | **PENDING** |
| Staff lifecycle | `staff.manage`; separately `staff.assign_role` | **PENDING** | **PENDING** | **PENDING** | Assign only approved active roles; no automatic grants | **PENDING** |
| Role/grant administration | `roles.manage`; separately `roles.grants.manage` | **PENDING** | **PENDING** | **PENDING** | Approve a named grant operator and two-person review, if required | **PENDING** |
| Audit reader | `audit_logs.view` | **PENDING** | **PENDING** | **PENDING** | Audit records may contain staff, finance and security events | **PENDING** |

**Approval completeness checks:** identify real role names/slugs; approve exact keys (not “all permissions”); list affected accounts; identify the provisioning operator; require review evidence; record effective date and review date. Until then, non-Super-Admin grant-dependent access remains **BLOCKED**. No migration or script may auto-grant these keys.

### D2 — Audit retention, archive, deletion and legal hold

No retention duration or purge/archive policy is currently configured. The append-only triggers reject ordinary UPDATE/DELETE. Do not drop them or delete history to satisfy a proposed policy without approved implementation and evidence.

The owner must decide each item below; an answer such as “keep as required” is not sufficiently specific for implementation.

| Decision | Required written answer | Status |
|---|---|---|
| Log categories and scope | Which records are in scope: login success/failure, staff/role changes, orders/refunds/finance, configuration, CSV export, security/error events, and legacy request-level events? | **PENDING** |
| Retention duration | Numeric duration per category (or a documented single duration), start event for the retention clock, and treatment of records under an active hold | **PENDING** |
| Archive | Whether archival is required; cadence; format; storage system/region; encryption/key ownership; access roles; integrity verification; restore test cadence | **PENDING** |
| Legal hold | Who may issue/release a hold; required written evidence; scope and start/end time; how held records are excluded from purge; audit of hold actions | **PENDING** |
| Deletion/erasure | Whether any category may be deleted, who may authorize it, lawful basis, approval evidence, exception path, database/archive scope, and proof of deletion | **PENDING** |
| Review/accountability | Policy owner, legal/compliance reviewer if applicable, approval date, next review date, and change-control procedure | **PENDING** |

**Safe default until approved:** retain existing records; no application purge, destructive migration, archive move, or trigger removal. Any lawful erasure workflow must preserve approved audit evidence without inventing exceptions.

### D3 — Vendor/reseller access scope

The present legacy admin surface is platform-wide; it does not claim tenant isolation. The owner must select and approve one option per entity:

| Entity | Choice A | Choice B | Choice C | Decision |
|---|---|---|---|---|
| Vendors | Confirm global platform admins may view/manage all vendor records; no vendor-tenant boundary is intended | Restrict platform roles to explicitly assigned vendors (requires a scoped authorization/data model and boundary tests) | Other precisely described scope | **PENDING** |
| Resellers | Confirm global platform admins may view/manage all reseller records; no reseller-tenant boundary is intended | Restrict platform roles to explicitly assigned resellers (requires a scoped authorization/data model and boundary tests) | Other precisely described scope | **PENDING** |

For each choice, also specify whether list/read, verification, financial withdrawals, and support actions share the same scope. Until decided, do not claim tenant-scoped admin access or expand non-Super-Admin grants for these operations.

### D4 — Production database privilege and account-separation review

**Plan only; no production access, query, permission change, or migration is authorized by this document.** A deployment owner must approve access and scope before evidence is collected.

1. **Inventory, read-only:** identify the production MySQL version, binary-log configuration, database/schema, runtime principal, migration principal, backup/restore principal, and secret-management locations without copying secrets into chat or repository.
2. **Collect approved evidence:** obtain redacted `SHOW GRANTS`/account-privilege evidence for each principal; record object/global privilege scope, TLS/network restrictions, credential rotation, and audit ownership. Do not infer privileges from CI.
3. **Compare to least privilege:** runtime account should have only required application DML and routine privileges; it should not own schema DDL/TRIGGER authority unless a documented need is approved. Migration account should be separate, time-bounded, controlled, and reviewed. Determine how MySQL binary logging affects trigger creation and whether the production migration process uses an approved privileged migration account or explicitly approved server setting.
4. **Validate safely:** reproduce the intended privilege split in a disposable MySQL 8.0 environment; test application runtime, migrations, audit inserts, trigger enforcement, rollback and restore without production data.
5. **Review and approve:** deployment owner/security reviewer signs a privilege matrix and rollback plan. If a production change is later authorized, create a separate change request with explicit target, window, backup, rollback, monitoring and approval. No production operation occurs in this sprint.

CI uses a disposable-service setting for the demonstrated MySQL binlog trigger-creator restriction; that setting is **not** evidence that production has or should have the same configuration.

## Next-sprint legacy handler test and MySQL migration order

Source of truth: [`PHASE_09_LEGACY_ADMIN_ROUTE_INVENTORY.md`](PHASE_09_LEGACY_ADMIN_ROUTE_INVENTORY.md), currently 252 unique active endpoints from 261 registrations. This priority order is for engineering work only; it does not approve operational grants. Existing Phase 06/08/09 MySQL repositories/tests should be preserved. Many older route handlers still use the synchronous SQLite facade and are not ready for successful MySQL-mode business tests. `POST /admin/settings/save` was selected as a bounded P4 migration and its transactional persistence/authenticated tests passed CI run `40319408987` on SHA `67e9fd924ccccdded0a926b3305989a34f5d4533`. On 2026-10-27, P0 order reads selected `GET /admin/order/invoice/:id`, `GET /admin/order/:status`, and `GET /admin/order/view/:id`. The invoice passed full MySQL 8.0 CI run [`40467159032`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40467159032) on `0599b1f60c8c899cdfa7b4a696c326739482f7df`; the status/search list passed exact-SHA CI run [`40474441107`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40474441107) on `e323c36c8677049a12d4dfb073dd161021af6002`. The current bounded sprint migrates only order detail through `adminOrderReadRepository.getAdminOrderDetail`, retaining the existing `is_seen` read-tracking side effect in response to the owner's scope choice; exact-SHA MySQL 8.0 CI run [`40477881115`](https://github.com/mrtumi2026/Mrtumi/actions/runs/40477881115) passed on `3974ea66f81984bc0a07049e18141b6f5b8aad18`. The list preserves current platform-wide scope and unpaginated behavior; neither order read resolves vendor/reseller owner scope decisions. Other P0–P5 operations remain unverified or unimplemented.

| Priority | Scope / route families | Why first | Acceptance evidence for each operation family |
|---|---|---|---|
| **P0 — money, order state, refund decisions** | `/admin/phase08/orders`, `/admin/phase08/refunds`, `/admin/order*`, `/admin/orderstatus*`, `/admin/refunds*`, finance/fund/expense/salary/withdrawal routes | Highest financial/order-state impact; do not conflate administrative approval with provider settlement | MySQL 8.0 authorized success changes only expected rows; replay/idempotency and invalid transitions; unauthorized/inactive/CSRF rejection; required audit event; no external payment/refund action |
| **P1 — identity, access, customer data** | `/admin/phase09/access/*`, `/admin/users*`, `/admin/roles*`, `/admin/permissions*`, `/admin/customer*`, complaints/messages, checkout recovery, IP/security | Privilege escalation, customer PII, consent and session-revocation risk | Actual DB-resolved permissions, least privilege, successful permitted lifecycle operation, audit atomicity, sensitive fields excluded, inactive session revocation, consent boundary |
| **P2 — stock and product lifecycle** | `/admin/phase06/*`, `/admin/products*`, categories/brands/size/color/reviews/coupons, `/admin/suppliers*`, `/admin/purchases*` | Inventory valuation/availability and catalog visibility; Phase 06 success paths need complete MySQL coverage | MySQL InnoDB transaction and integer-paisa invariants; stock movement/reversal/idempotency; successful authorized mutation and audit; concurrent conflict behavior |
| **P3 — partner and fulfilment operations** | `/admin/vendors*`, `/admin/vendor-*`, `/admin/resellers*`, `/admin/reseller-*`, `/admin/delivery*` | Scope choice D3 is a prerequisite; financial/withdrawal routes stay P0 | First obtain D3 scope approval; then MySQL success tests by assigned scope, cross-partner denial where scoped, audit and no cross-tenant leakage |
| **P4 — configuration, integrations, communications, exports** | `/admin/settings*`, `/admin/paymentgeteway*`, courier/SMS integration routes, `/admin/sms/custom-send`, `/admin/reports*`, analytics and error logs | Provider credentials, outbound messaging and CSV data exposure; avoid real provider operations | Stubbed/no-network tests only; no secret echo; permission + CSRF; minimized export/send audit; no live payment/SMS/provider call |
| **P5 — HR, content, support and remaining reads** | `/admin/employees*`, attendance/leaves/salaries/bonuses, blogs/pages/banners, newsletter/contact/support, ordinary dashboard/settings/report reads | Sensitive HR data and broad remaining legacy surface; prioritize mutations before routine reads | MySQL-backed success path per route family; role denial; safe validation/error response; audit where classified sensitive; rendering regression |

### Per-handler completion unit

For each endpoint in a priority family, track one row in a sprint issue/test map and record: method/path; owning router/handler; SQLite facade use or MySQL repository; named permission(s); mutation/read/export; approved scope; authorized success test; unauthenticated and wrong-role outcome; inactive-account outcome where relevant; CSRF case for mutations; database before/after assertions; audit event and failure behavior; migration dependency; final CI run/SHA. Do not mark a family MySQL-ready based only on route-policy denial tests.

## Carry-forward status

- Operational permission grants: **BLOCKED — owner approval pending; none assigned**.
- Retention/archive/deletion/legal-hold: **BLOCKED — owner policy pending; no purge configured**.
- Vendor/reseller scope: **BLOCKED — owner confirmation pending; current admin surface is platform-wide**.
- Production DB privilege/account split: **UNVERIFIED — approved read-only evidence collection plan only**.
- Remaining legacy authorized success paths/MySQL migration: **IN PROGRESS — `POST /admin/settings/save` passed CI on `67e9fd924ccccdded0a926b3305989a34f5d4533`; invoice read `GET /admin/order/invoice/:id` passed CI run `40467159032` on `0599b1f60c8c899cdfa7b4a696c326739482f7df`; status/search list `GET /admin/order/:status` passed exact-SHA CI run `40474441107` on `e323c36c8677049a12d4dfb073dd161021af6002`; the current detail read `GET /admin/order/view/:id` passed exact-SHA MySQL 8.0 CI run `40477881115` on `3974ea66f81984bc0a07049e18141b6f5b8aad18`. Opening detail retains the legacy `is_seen` notification acknowledgement; all business mutations remain outside scope. Remaining order mutations and legacy product/supplier/purchase/inventory routes require route-by-route acceptance; prioritize P0→P5.**
- Phase 09: **IN PROGRESS / NOT COMPLETE**. Phase 07 and Phase 08 remain **IN PROGRESS / NOT COMPLETE**.

## Incomplete request item

The message ended with a bare “6.” and no sixth action/requirement. No sixth item has been inferred; provide its text to add it to this plan.
