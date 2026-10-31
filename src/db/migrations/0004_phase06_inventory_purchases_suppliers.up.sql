-- ============================================================================
-- Migration 0004 (UP): Phase 06 — Product Types, Supplier Details, Multi-Line
-- Purchase Orders, Idempotent Purchase Receipts & Unit-Cost Stock Ledger
-- Compatible with MySQL 5.7+, MySQL 8.0+, and MariaDB 10.3+
-- All monetary values stored as BIGINT integer paisa (1 BDT = 100 paisa).
-- ============================================================================

ALTER TABLE `products`
  ADD COLUMN `product_type` VARCHAR(32) NOT NULL DEFAULT 'grocery' AFTER `slug`;

ALTER TABLE `suppliers`
  ADD COLUMN `supplier_code` VARCHAR(48) DEFAULT NULL AFTER `id`,
  ADD COLUMN `contact_person` VARCHAR(191) NOT NULL DEFAULT '' AFTER `company`,
  ADD COLUMN `email` VARCHAR(191) DEFAULT NULL AFTER `phone`,
  ADD COLUMN `tax_or_trade_id` VARCHAR(100) NOT NULL DEFAULT '' AFTER `address`,
  ADD COLUMN `notes` TEXT DEFAULT NULL AFTER `balance_due_paisa`,
  ADD COLUMN `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`,
  ADD UNIQUE KEY `uq_suppliers_code` (`supplier_code`);

ALTER TABLE `purchases`
  ADD COLUMN `subtotal_paisa` BIGINT NOT NULL DEFAULT 0 AFTER `supplier_id`,
  ADD COLUMN `discount_paisa` BIGINT NOT NULL DEFAULT 0 AFTER `subtotal_paisa`,
  ADD COLUMN `shipping_charge_paisa` BIGINT NOT NULL DEFAULT 0 AFTER `discount_paisa`,
  ADD COLUMN `cancelled_reason` VARCHAR(255) NOT NULL DEFAULT '' AFTER `note`,
  ADD COLUMN `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

ALTER TABLE `purchase_items`
  ADD COLUMN `variant_id` BIGINT UNSIGNED DEFAULT NULL AFTER `product_id`,
  ADD COLUMN `returned_qty` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `received_qty`,
  ADD KEY `idx_purchase_items_variant` (`variant_id`),
  ADD CONSTRAINT `fk_purchase_items_variant` FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL;

ALTER TABLE `stock_ledger`
  ADD COLUMN `unit_cost_paisa` BIGINT DEFAULT NULL AFTER `balance_after`;

CREATE TABLE IF NOT EXISTS `purchase_receipts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `purchase_id` BIGINT UNSIGNED NOT NULL,
  `receipt_no` VARCHAR(64) NOT NULL,
  `idempotency_key` VARCHAR(128) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `event_type` VARCHAR(32) NOT NULL DEFAULT 'receipt',
  `total_qty` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_value_paisa` BIGINT NOT NULL DEFAULT 0,
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `received_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_receipts_no` (`receipt_no`),
  UNIQUE KEY `uq_purchase_receipts_idem` (`idempotency_key`),
  KEY `idx_purchase_receipts_purchase` (`purchase_id`, `created_at`),
  CONSTRAINT `fk_purchase_receipts_purchase` FOREIGN KEY (`purchase_id`) REFERENCES `purchases` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_purchase_receipts_user` FOREIGN KEY (`received_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
