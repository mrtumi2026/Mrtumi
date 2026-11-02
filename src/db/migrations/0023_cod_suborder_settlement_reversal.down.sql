-- Financial ledgers, price snapshots, courier reconciliation records, and wallet balances are append-only.
-- Rolling this migration back would destroy auditable balances and settled/reversed history, so fail closed.
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Migration 0023 is intentionally irreversible; preserve financial reconciliation and ledger records.';
