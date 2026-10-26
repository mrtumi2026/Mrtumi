-- ============================================================================
-- Migration 0004 (DOWN): Rollback Phase 06 schema additions
-- ============================================================================

DROP TABLE IF EXISTS `purchase_receipts`;

ALTER TABLE `stock_ledger`
  DROP COLUMN `unit_cost_paisa`;

ALTER TABLE `purchase_items`
  DROP FOREIGN KEY `fk_purchase_items_variant`,
  DROP KEY `idx_purchase_items_variant`,
  DROP COLUMN `returned_qty`,
  DROP COLUMN `variant_id`;

ALTER TABLE `purchases`
  DROP COLUMN `updated_at`,
  DROP COLUMN `cancelled_reason`,
  DROP COLUMN `shipping_charge_paisa`,
  DROP COLUMN `discount_paisa`,
  DROP COLUMN `subtotal_paisa`;

ALTER TABLE `suppliers`
  DROP KEY `uq_suppliers_code`,
  DROP COLUMN `updated_at`,
  DROP COLUMN `notes`,
  DROP COLUMN `tax_or_trade_id`,
  DROP COLUMN `email`,
  DROP COLUMN `contact_person`,
  DROP COLUMN `supplier_code`;

ALTER TABLE `products`
  DROP COLUMN `product_type`;
