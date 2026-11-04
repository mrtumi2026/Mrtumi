# Admin Test Data Management — Phase E

## Identification contract

`test_data_groups` is the provenance ledger. `test_data_group_id` is nullable on customers, vendors, products, categories, and parent orders. Existing rows remain `NULL`; no historical record is inferred from its name, email, phone, SKU, invoice, or status. Child records are displayed through their owning marked customer/product/order/vendor relationship: addresses and cart items, product variants and stock movements, order items and suborders, shipments, COD/payment/return/settlement references. Group creation and each explicit record-mark action are append-audited. E2E fixtures use the same marker only after the disposable `mrtumi_test` schema has been verified and migrated.

A record may belong to only one group. Marking is an explicit, single-record admin action; records already assigned to any group cannot be reclassified through this interface. Group keys are random and stable. Cleanup groups and cleanup-run rows are retained for audit purposes.

## Cleanup policy

The preview uses fixed allow-listed tables, calculates root and related counts, and blocks the whole operation if any protected relation exists. Confirmation requires the exact `CLEAN <group-key>` string, in addition to authenticated `test_data.manage` authorization, a valid CSRF token, and a session-protected POST. Preview is recalculated under a transaction and group row lock before any write. Record deletion and the cleanup run are one transaction; failure rolls the whole operation back. A separate append-only `audit_logs` entry records successful completion.

The first cleanup scope intentionally supports only isolated, explicitly marked customer, vendor, product, category, and cart/address data whose dependencies are known to be test-only. It can remove customer addresses/cart items, product variants and reservations through their owning rows, and eligible roots. It does **not** delete orders or their order items/status history, suborders, shipments, COD/payment/refund/return/settlement/ledger records, stock movement history, product review history, vendor verification/payout history, customer consent/privacy history, or global audit logs. If any such dependency is present, preview reports the blocker and cleanup makes no deletion. This avoids inventing a legal retention period or financial disposition policy. Order-bearing groups therefore require an owner-approved retention/anonymization process before they can be safely cleaned.

Empty groups record an `empty` cleanup attempt without changing records. Repeated cleanup of a completed group is rejected as a safe no-op. Existing data is never bulk-marked. An admin can search unmarked entities and explicitly mark the intended record into an active group.

## Operational and launch QA notes

- Migration `0028_admin_test_data_management` is additive and uses nullable markers; apply with the existing migration runner and verify the registered checksum. Do not edit applied migrations.
- Use the Admin navigation item **Test Data Management** (Bangla: **টেস্ট ডেটা ব্যবস্থাপনা**) only with an account authorized for `test_data.manage`. Super Admin retains the repository's existing platform-wide permission behavior; the `admin` role receives the dedicated permission through the additive migration.
- MySQL 8.0 and MariaDB 10.11 disposable CI runs exercise transactional preview/cleanup and the Browser E2E runner. The browser runner creates a random-password admin only after asserting `NODE_ENV=test`, `DB_CLIENT=mysql`, host `127.0.0.1`, and database/user `mrtumi_test`; it creates no production-default credentials. A return-eligible category policy is inserted only in that guarded E2E schema. Both are removed by guaranteed full disposable-schema teardown.
- Do not use this interface as a production database reset. Before launch, require a verified backup and owner-approved restore rehearsal. This feature does not create backups, anonymize financial orders, or perform partial cleanup.
- Courier provider integrations and comparison work remain out of scope and are assigned separately.
