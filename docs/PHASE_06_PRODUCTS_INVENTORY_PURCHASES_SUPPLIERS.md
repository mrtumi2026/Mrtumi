# PHASE 06 — PRODUCTS, INVENTORY, PURCHASES & SUPPLIERS

**Status:** `IN PROGRESS` — the tested vertical slice below is implemented; full Phase 06 acceptance is not yet met.
**Scope:** `P06-01`–`P06-05` only. No Phase 07+ work is represented as complete.
**Database:** MySQL/InnoDB is the production boundary; local SQLite is retained as a non-production compatibility/test adapter.
**Migration:** `0004_phase06_inventory_purchases_suppliers` (`.up.sql` / `.down.sql`), reversible additive DDL.

## Implemented vertical slice

- `src/repositories/phase06Repository.js` provides product creation, active supplier creation, warehouse/vendor stock listing, reason-required inventory adjustment, product archive/restore, multi-line draft PO creation, partial/full purchase receipt, and bounded list queries.
- `src/routes/phase06.js` mounts the feature at `/admin/phase06`, requires an admin session and per-write CSRF token, validates through the repository, and serves an inventory JSON read endpoint. New routes use the repository, not the synchronous SQLite facade in MySQL mode.
- `views/admin/phase06.ejs` reuses the existing Admin shell and shared locale/formatters; both `bn` and `en` UI dictionaries have matching Phase 06 keys.
- `0004` adds product type; supplier code/contact/email/business identifier/notes; PO totals, charges and cancellation reason; purchase-line variant/return metadata; unit-cost detail to the stock ledger; and uniquely identified purchase receipts with request hashes.
- A new product's optional opening stock is recorded once in `stock_ledger`. Product creation without an explicit opening quantity starts at zero. Product archive disables storefront status and preserves relational history; no product hard delete is offered in this module.
- Manual adjustment requires a reason, uses the repository's MySQL `SELECT ... FOR UPDATE` transaction on the product, prohibits negative stock, writes a ledger movement, and keeps warehouse vs vendor quantities separate. A vendor-pool adjustment requires the product be assigned to a vendor.
- Purchase creation validates and calculates line totals server-side in integer paisa, validates supplier and product records, and creates a `draft` PO without increasing stock. Receipt updates are transactional, row-locked, partial-receipt aware, request-hash/idempotency checked, and update stock and ledger together.
- Inventory valuation is not presented as a financial report. `cost_price_paisa` is maintained using a moving weighted-average cost on receipts; vendor consignment stock and retail-margin valuation are excluded. This calculation still requires additional audited purchase-return/write-off policies before being used for management reporting.
- Image-upload middleware now denies SVG and other active-content formats, limits size and count, uses random names, and checks raster magic bytes. Existing configured upload root is respected. The product UI currently accepts an escaped URL/path; multi-image gallery upload/management remains outstanding.

## Tests and evidence

- `tests/phase06-inventory-purchases.test.js`: 4 local SQLite-adapter tests pass for SKU uniqueness, money validation, opening-ledger event, reasoned adjustments and negative-stock prevention, draft-PO stock invariance, partial/full receipt, duplicate-receipt idempotency, archive/restore history, and SVG signature rejection.
- `tests/phase06-mysql.test.js`: requires the workflow's live `mysql:8.0` service and tests schema application, draft PO behavior, transactional partial receiving, duplicate receipt, and concurrent row-locked stock changes. It is explicitly skipped on this local sandbox when no MySQL service is available; only GitHub Actions can establish live MySQL test status.
- `npm run lint`: 565 checks passed (after Phase 06 additions). `npm test`: 27 pass, 8 live-MySQL tests skipped locally, 0 failed after the migration-pair expectation was updated from 3 to 4. `npm audit --omit=dev`: 0 vulnerabilities.

## Remaining Phase 06 work (not complete)

- Product edit workflow; structured option/variant CRUD and per-variant stock/SKU/price management; product gallery upload/reordering and safe bulk operations; robust search/sort/pagination and CSV import/export with preview/rollback; category/subcategory/brand relational selector UI (current initial screen uses optional numeric IDs).
- Supplier edit/activate/deactivate and supplier purchase-history detail; business identifier/notes display and validation polish.
- PO state transitions (`draft` → `ordered`), explicit cancellation, cancellation reasons, supplier returns as reverse ledger movements, receipt UI that selects exact outstanding purchase-line quantities, receipt list/history, supplier payable ledger, discount/charges reconciliation, and paid-amount bounds.
- Batch/lot/expiry tracking is unresolved business policy. No batch/expiry or FIFO claims are implemented. Owner must define whether perishable grocery lot/expiry/FEFO tracking is mandatory before final Phase 06 sign-off.
- CI must pass live MySQL 8.0 migration/test suite for this commit before any P06 feature is reported `TESTED AND PASSED` against MySQL. Local SQLite test success is not a substitute.

## Security and data safety

- Admin-session authentication + CSRF applies to the new POST endpoints. Existing legacy Admin routes are not made safe by this change and remain under the previously documented staged SQLite route migration.
- Migration rollback is schema-reversible but is not a data-preservation strategy for a future production rollback. Do not run it against a live schema until backup/release approval procedures are in place.
- `data/pholbazar.db*` was not read, modified, reset, staged, or committed by this work.
- No production deployment or live database migration was performed.
