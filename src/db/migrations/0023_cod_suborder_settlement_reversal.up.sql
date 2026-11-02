-- COD reconciliation, sub-order fulfillment timestamps, and auditable wallet settlement/reversal ledgers.
ALTER TABLE `courier_cod_collections`
  ADD COLUMN `courier_name` VARCHAR(80) NOT NULL DEFAULT '' AFTER `shipment_id`,
  ADD COLUMN `consignment_id` VARCHAR(120) NOT NULL DEFAULT '' AFTER `courier_name`,
  ADD COLUMN `collected_amount_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `idempotency_key`,
  ADD COLUMN `net_remitted_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `remitted_paisa`,
  ADD COLUMN `bank_trans_ref` VARCHAR(120) NOT NULL DEFAULT '' AFTER `remittance_reference`,
  ADD COLUMN `reconciled_by_user_id` BIGINT UNSIGNED DEFAULT NULL AFTER `received_at`,
  ADD CONSTRAINT `fk_cod_collection_reconciled_by` FOREIGN KEY (`reconciled_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `vendor_sub_orders`
  ADD COLUMN `cod_due_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `status`,
  ADD COLUMN `shipment_carrier` VARCHAR(80) NOT NULL DEFAULT '' AFTER `cod_due_paisa`,
  ADD COLUMN `tracking_code` VARCHAR(120) NOT NULL DEFAULT '' AFTER `shipment_carrier`,
  ADD COLUMN `processing_at` DATETIME DEFAULT NULL AFTER `accepted_at`,
  ADD COLUMN `packed_at` DATETIME DEFAULT NULL AFTER `processing_at`,
  ADD COLUMN `ready_for_pickup_at` DATETIME DEFAULT NULL AFTER `packed_at`,
  ADD COLUMN `in_transit_at` DATETIME DEFAULT NULL AFTER `ready_for_pickup_at`,
  ADD COLUMN `delivered_at` DATETIME DEFAULT NULL AFTER `in_transit_at`,
  ADD COLUMN `return_requested_at` DATETIME DEFAULT NULL AFTER `delivered_at`,
  ADD COLUMN `returned_at` DATETIME DEFAULT NULL AFTER `return_requested_at`,
  ADD COLUMN `failed_delivery_at` DATETIME DEFAULT NULL AFTER `returned_at`,
  ADD COLUMN `cancelled_at` DATETIME DEFAULT NULL AFTER `failed_delivery_at`;

ALTER TABLE `order_status_history`
  ADD COLUMN `vendor_sub_order_id` BIGINT UNSIGNED DEFAULT NULL AFTER `order_id`,
  ADD KEY `idx_order_history_sub_order` (`vendor_sub_order_id`,`created_at`),
  ADD CONSTRAINT `fk_order_history_sub_order` FOREIGN KEY (`vendor_sub_order_id`) REFERENCES `vendor_sub_orders` (`id`) ON DELETE RESTRICT;

ALTER TABLE `vendor_order_status_history`
  ADD COLUMN `vendor_sub_order_id` BIGINT UNSIGNED DEFAULT NULL AFTER `vendor_id`,
  ADD KEY `idx_vendor_sub_order_history` (`vendor_sub_order_id`,`created_at`),
  ADD CONSTRAINT `fk_vendor_status_history_sub_order` FOREIGN KEY (`vendor_sub_order_id`) REFERENCES `vendor_sub_orders` (`id`) ON DELETE RESTRICT;

UPDATE `vendor_order_status_history` h JOIN `vendor_sub_orders` so
  ON so.`order_id`=h.`order_id` AND so.`vendor_id`=h.`vendor_id`
  SET h.`vendor_sub_order_id`=so.`id` WHERE h.`vendor_sub_order_id` IS NULL;
UPDATE `vendor_sub_orders` so JOIN (
  SELECT `vendor_sub_order_id`,MAX(`created_at`) AS `delivered_at`
  FROM `vendor_order_status_history` WHERE `to_status`='delivered' AND `vendor_sub_order_id` IS NOT NULL
  GROUP BY `vendor_sub_order_id`
) h ON h.`vendor_sub_order_id`=so.`id`
  SET so.`delivered_at`=h.`delivered_at` WHERE so.`status`='delivered' AND so.`delivered_at` IS NULL;

CREATE TABLE IF NOT EXISTS `partner_wallets` (
  `reseller_id` BIGINT UNSIGNED NOT NULL,
  `pending_balance` BIGINT NOT NULL DEFAULT 0,
  `available_balance` BIGINT NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`reseller_id`),
  CONSTRAINT `fk_partner_wallet_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_wallets` (
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `pending_settlement` BIGINT NOT NULL DEFAULT 0,
  `available_balance` BIGINT NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`vendor_id`),
  CONSTRAINT `fk_vendor_wallet_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `partner_wallets` (`reseller_id`,`available_balance`)
SELECT `id`,`balance_paisa` FROM `resellers`;
INSERT INTO `vendor_wallets` (`vendor_id`,`available_balance`)
SELECT `id`,`balance_paisa` FROM `vendors`;

CREATE TABLE IF NOT EXISTS `partner_transactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reseller_id` BIGINT UNSIGNED NOT NULL,
  `sub_order_id` BIGINT UNSIGNED DEFAULT NULL,
  `idempotency_key` VARCHAR(140) NOT NULL,
  `transaction_type` VARCHAR(32) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `balance_bucket` VARCHAR(24) NOT NULL,
  `metadata_json` JSON NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_partner_transaction_idempotency` (`idempotency_key`),
  KEY `idx_partner_transaction_wallet` (`reseller_id`,`created_at`),
  CONSTRAINT `fk_partner_transaction_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_partner_transaction_sub_order` FOREIGN KEY (`sub_order_id`) REFERENCES `vendor_sub_orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_transactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `sub_order_id` BIGINT UNSIGNED DEFAULT NULL,
  `idempotency_key` VARCHAR(140) NOT NULL,
  `transaction_type` VARCHAR(32) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `balance_bucket` VARCHAR(24) NOT NULL,
  `metadata_json` JSON NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendor_transaction_idempotency` (`idempotency_key`),
  KEY `idx_vendor_transaction_wallet` (`vendor_id`,`created_at`),
  CONSTRAINT `fk_vendor_transaction_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_vendor_transaction_sub_order` FOREIGN KEY (`sub_order_id`) REFERENCES `vendor_sub_orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `marketplace_revenue_ledger` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sub_order_id` BIGINT UNSIGNED NOT NULL,
  `idempotency_key` VARCHAR(140) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_marketplace_revenue_idempotency` (`idempotency_key`),
  CONSTRAINT `fk_marketplace_revenue_sub_order` FOREIGN KEY (`sub_order_id`) REFERENCES `vendor_sub_orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_price_snapshots` (
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `vendor_id` BIGINT UNSIGNED DEFAULT NULL,
  `reseller_id` BIGINT UNSIGNED DEFAULT NULL,
  `quantity` INT UNSIGNED NOT NULL,
  `customer_unit_price_paisa` BIGINT UNSIGNED NOT NULL,
  `vendor_entitlement_unit_paisa` BIGINT UNSIGNED NOT NULL,
  `reseller_margin_unit_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `marketplace_revenue_unit_paisa` BIGINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`order_item_id`),
  KEY `idx_order_price_snapshot_vendor` (`vendor_id`),
  CONSTRAINT `fk_order_price_snapshot_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_order_price_snapshot_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_order_price_snapshot_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `order_price_snapshots`
  (`order_item_id`,`vendor_id`,`reseller_id`,`quantity`,`customer_unit_price_paisa`,`vendor_entitlement_unit_paisa`,`reseller_margin_unit_paisa`,`marketplace_revenue_unit_paisa`)
SELECT oi.`id`,oi.`vendor_id`,o.`reseller_id`,oi.`qty`,GREATEST(0,oi.`unit_price_paisa`),
  COALESCE(rps.`vendor_entitlement_unit_paisa`,CASE WHEN oi.`vendor_id` IS NULL THEN GREATEST(0,oi.`unit_price_paisa`) ELSE FLOOR(GREATEST(0,oi.`unit_price_paisa`)*(10000-LEAST(10000,COALESCE(v.`commission_rate_bps`,1000)))/10000) END),
  CASE WHEN rps.`order_item_id` IS NULL OR rps.`quantity`=0 THEN 0 ELSE FLOOR(rps.`reseller_earning_paisa`/rps.`quantity`) END,
  CASE WHEN rps.`order_item_id` IS NULL OR rps.`quantity`=0
       THEN GREATEST(0,GREATEST(0,oi.`unit_price_paisa`)-COALESCE(rps.`vendor_entitlement_unit_paisa`,CASE WHEN oi.`vendor_id` IS NULL THEN GREATEST(0,oi.`unit_price_paisa`) ELSE FLOOR(GREATEST(0,oi.`unit_price_paisa`)*(10000-LEAST(10000,COALESCE(v.`commission_rate_bps`,1000)))/10000) END))
       ELSE FLOOR(rps.`platform_revenue_paisa`/rps.`quantity`) END
FROM `order_items` oi JOIN `orders` o ON o.`id`=oi.`order_id`
LEFT JOIN `vendors` v ON v.`id`=oi.`vendor_id`
LEFT JOIN `reseller_order_price_snapshots` rps ON rps.`order_item_id`=oi.`id`;

CREATE TABLE IF NOT EXISTS `financial_reversals` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `quantity` INT UNSIGNED NOT NULL,
  `reason` VARCHAR(32) NOT NULL,
  `idempotency_key` VARCHAR(140) NOT NULL,
  `vendor_amount_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `reseller_amount_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_financial_reversal_idempotency` (`idempotency_key`),
  KEY `idx_financial_reversal_item` (`order_item_id`,`created_at`),
  CONSTRAINT `fk_financial_reversal_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_financial_reversal_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER `trg_order_price_snapshot_no_update`
BEFORE UPDATE ON `order_price_snapshots` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order price snapshots are immutable';
CREATE TRIGGER `trg_order_price_snapshot_no_delete`
BEFORE DELETE ON `order_price_snapshots` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order price snapshots cannot be deleted';
CREATE TRIGGER `trg_partner_transaction_no_update`
BEFORE UPDATE ON `partner_transactions` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Partner transaction ledger is immutable';
CREATE TRIGGER `trg_partner_transaction_no_delete`
BEFORE DELETE ON `partner_transactions` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Partner transaction ledger cannot be deleted';
CREATE TRIGGER `trg_vendor_transaction_no_update`
BEFORE UPDATE ON `vendor_transactions` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Vendor transaction ledger is immutable';
CREATE TRIGGER `trg_vendor_transaction_no_delete`
BEFORE DELETE ON `vendor_transactions` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Vendor transaction ledger cannot be deleted';
CREATE TRIGGER `trg_marketplace_revenue_no_update`
BEFORE UPDATE ON `marketplace_revenue_ledger` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Marketplace revenue ledger is immutable';
CREATE TRIGGER `trg_marketplace_revenue_no_delete`
BEFORE DELETE ON `marketplace_revenue_ledger` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Marketplace revenue ledger cannot be deleted';
CREATE TRIGGER `trg_financial_reversal_no_update`
BEFORE UPDATE ON `financial_reversals` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Financial reversal records are immutable';
CREATE TRIGGER `trg_financial_reversal_no_delete`
BEFORE DELETE ON `financial_reversals` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Financial reversal records cannot be deleted';
