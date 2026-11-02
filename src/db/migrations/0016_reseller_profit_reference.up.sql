-- Speeds up reconciliation/audit lookups for order-linked reseller ledger entries.
-- Profit credit itself is serialized by the order transition transaction and its
-- unique status-history request key; this index does not alter existing balances.
ALTER TABLE `reseller_transactions`
  ADD KEY `idx_reseller_tx_reference_order` (`reference_order_id`, `tx_type`);
