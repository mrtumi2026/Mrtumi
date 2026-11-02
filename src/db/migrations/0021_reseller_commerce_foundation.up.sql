-- Reseller commerce snapshots and independent vendor fulfillment/accounting records.
-- All amounts are immutable integer paisa snapshots; financial corrections use separate adjustments.
ALTER TABLE `orders`
  ADD COLUMN `reseller_pricing_mode` VARCHAR(32) DEFAULT NULL AFTER `reseller_id`,
  ADD COLUMN `reseller_store_name_snapshot` VARCHAR(191) NOT NULL DEFAULT '' AFTER `reseller_pricing_mode`,
  ADD COLUMN `reseller_logo_snapshot` VARCHAR(500) NOT NULL DEFAULT '' AFTER `reseller_store_name_snapshot`;

CREATE TABLE IF NOT EXISTS `reseller_commerce_settings` (
  `id` TINYINT UNSIGNED NOT NULL,
  `reseller_price_mode_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `official_price_mode_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `platform_fee_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `official_commission_bps` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `minimum_price_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `maximum_price_paisa` BIGINT UNSIGNED DEFAULT NULL,
  `return_window_days` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `settlement_schedule` VARCHAR(32) NOT NULL DEFAULT 'manual',
  `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_reseller_commerce_settings_singleton` CHECK (`id` = 1),
  CONSTRAINT `chk_reseller_price_range` CHECK (`maximum_price_paisa` IS NULL OR `maximum_price_paisa` >= `minimum_price_paisa`),
  CONSTRAINT `chk_reseller_commission_bps` CHECK (`official_commission_bps` <= 10000),
  CONSTRAINT `fk_reseller_commerce_settings_user` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `reseller_commerce_settings` (`id`) VALUES (1);

CREATE TABLE IF NOT EXISTS `reseller_product_eligibility` (
  `product_id` BIGINT UNSIGNED NOT NULL,
  `reseller_price_mode_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `official_price_mode_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `minimum_price_paisa` BIGINT UNSIGNED DEFAULT NULL,
  `maximum_price_paisa` BIGINT UNSIGNED DEFAULT NULL,
  `vendor_entitlement_paisa` BIGINT UNSIGNED DEFAULT NULL,
  `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`product_id`),
  CONSTRAINT `chk_reseller_product_price_range` CHECK (`maximum_price_paisa` IS NULL OR `minimum_price_paisa` IS NULL OR `maximum_price_paisa` >= `minimum_price_paisa`),
  CONSTRAINT `fk_reseller_product_eligibility_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_reseller_product_eligibility_user` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `reseller_order_price_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `pricing_mode` VARCHAR(32) NOT NULL,
  `quantity` INT UNSIGNED NOT NULL,
  `official_unit_price_paisa` BIGINT UNSIGNED NOT NULL,
  `customer_unit_price_paisa` BIGINT UNSIGNED NOT NULL,
  `vendor_entitlement_unit_paisa` BIGINT UNSIGNED NOT NULL,
  `platform_fee_unit_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `reseller_commission_unit_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `reseller_earning_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `platform_revenue_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `adjustment_paisa` BIGINT NOT NULL DEFAULT 0,
  `snapshot_json` JSON NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reseller_price_snapshot_item` (`order_item_id`),
  KEY `idx_reseller_snapshot_mode_created` (`pricing_mode`,`created_at`),
  CONSTRAINT `fk_reseller_snapshot_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_sub_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `vendor_order_no` VARCHAR(64) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'order_placed',
  `vendor_entitlement_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `marketplace_fee_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `refund_adjustment_paisa` BIGINT NOT NULL DEFAULT 0,
  `net_payable_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `accepted_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendor_sub_order_no` (`vendor_order_no`),
  UNIQUE KEY `uq_vendor_sub_order_parent_vendor` (`order_id`,`vendor_id`),
  KEY `idx_vendor_sub_order_vendor_status` (`vendor_id`,`status`,`created_at`),
  CONSTRAINT `fk_vendor_sub_order_parent` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_vendor_sub_order_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_sub_order_items` (
  `vendor_sub_order_id` BIGINT UNSIGNED NOT NULL,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `quantity` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`vendor_sub_order_id`,`order_item_id`),
  UNIQUE KEY `uq_vendor_sub_order_item` (`order_item_id`),
  CONSTRAINT `fk_vendor_sub_item_sub_order` FOREIGN KEY (`vendor_sub_order_id`) REFERENCES `vendor_sub_orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_vendor_sub_item_order_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `fulfillment_shipments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_sub_order_id` BIGINT UNSIGNED NOT NULL,
  `courier_code` VARCHAR(48) NOT NULL DEFAULT '',
  `tracking_id` VARCHAR(120) NOT NULL DEFAULT '',
  `status` VARCHAR(32) NOT NULL DEFAULT 'ready_for_pickup',
  `cod_due_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `picked_up_at` DATETIME DEFAULT NULL,
  `delivered_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_courier_tracking` (`courier_code`,`tracking_id`),
  KEY `idx_fulfillment_sub_order_status` (`vendor_sub_order_id`,`status`),
  CONSTRAINT `fk_fulfillment_sub_order` FOREIGN KEY (`vendor_sub_order_id`) REFERENCES `vendor_sub_orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `courier_cod_collections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shipment_id` BIGINT UNSIGNED NOT NULL,
  `idempotency_key` VARCHAR(100) NOT NULL,
  `collected_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `courier_fee_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `cod_fee_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `return_fee_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `remitted_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `remittance_reference` VARCHAR(120) NOT NULL DEFAULT '',
  `reconciliation_status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `received_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cod_collection_idempotency` (`idempotency_key`),
  KEY `idx_cod_collection_shipment_status` (`shipment_id`,`reconciliation_status`),
  CONSTRAINT `fk_cod_collection_shipment` FOREIGN KEY (`shipment_id`) REFERENCES `fulfillment_shipments` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `reseller_financial_ledger` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reseller_id` BIGINT UNSIGNED NOT NULL,
  `order_id` BIGINT UNSIGNED DEFAULT NULL,
  `order_item_id` BIGINT UNSIGNED DEFAULT NULL,
  `idempotency_key` VARCHAR(120) NOT NULL,
  `entry_type` VARCHAR(32) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reseller_ledger_idempotency` (`idempotency_key`),
  KEY `idx_reseller_ledger_account_status` (`reseller_id`,`status`,`created_at`),
  KEY `idx_reseller_ledger_order_item` (`order_id`,`order_item_id`),
  CONSTRAINT `fk_reseller_ledger_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_reseller_ledger_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_reseller_ledger_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `reseller_financial_adjustments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `reseller_id` BIGINT UNSIGNED NOT NULL,
  `idempotency_key` VARCHAR(120) NOT NULL,
  `reason` VARCHAR(64) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reseller_adjustment_idempotency` (`idempotency_key`),
  KEY `idx_reseller_adjustment_item` (`order_item_id`,`created_at`),
  CONSTRAINT `fk_reseller_adjustment_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_reseller_adjustment_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_reseller_adjustment_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER `trg_reseller_price_snapshot_no_update`
BEFORE UPDATE ON `reseller_order_price_snapshots` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Reseller price snapshots are immutable';
CREATE TRIGGER `trg_reseller_price_snapshot_no_delete`
BEFORE DELETE ON `reseller_order_price_snapshots` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Reseller price snapshots cannot be deleted';
