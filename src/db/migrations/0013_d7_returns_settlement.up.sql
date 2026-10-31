-- D7 workflows: customer cancellation/returns, inspection evidence and settlement snapshots.
CREATE TABLE IF NOT EXISTS `order_cancellation_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'accepted',
  `reason` VARCHAR(255) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `idx_cancel_order` (`order_id`,`created_at`),
  CONSTRAINT `fk_cancel_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_cancel_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `return_category_policies` (
  `category_id` BIGINT UNSIGNED NOT NULL,
  `eligible` TINYINT(1) NOT NULL DEFAULT 0,
  `window_days` SMALLINT UNSIGNED NOT NULL DEFAULT 7,
  `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`category_id`),
  CONSTRAINT `fk_return_policy_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_return_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `claim_type` VARCHAR(24) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `evidence_path` VARCHAR(500) NOT NULL DEFAULT '',
  `status` VARCHAR(24) NOT NULL DEFAULT 'requested',
  `decision_note` VARCHAR(500) NOT NULL DEFAULT '',
  `reviewed_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `idx_return_request_order` (`order_id`,`created_at`), KEY `idx_return_request_status` (`status`,`created_at`),
  CONSTRAINT `fk_return_request_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_return_request_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_return_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `return_request_id` BIGINT UNSIGNED NOT NULL,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `qty` INT UNSIGNED NOT NULL,
  `disposition` VARCHAR(24) NOT NULL DEFAULT 'pending_inspection',
  `inspected_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `inspected_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_return_item_request_line` (`return_request_id`,`order_item_id`),
  CONSTRAINT `fk_return_item_request` FOREIGN KEY (`return_request_id`) REFERENCES `customer_return_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_return_item_order_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_return_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `return_request_id` BIGINT UNSIGNED NOT NULL,
  `from_status` VARCHAR(24) NOT NULL DEFAULT '',
  `to_status` VARCHAR(24) NOT NULL,
  `note` VARCHAR(500) NOT NULL DEFAULT '',
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `idx_return_events_request` (`return_request_id`,`created_at`),
  CONSTRAINT `fk_return_event_request` FOREIGN KEY (`return_request_id`) REFERENCES `customer_return_requests` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_settlement_batches` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `period_start` DATE NOT NULL,
  `period_end` DATE NOT NULL,
  `gross_paisa` BIGINT NOT NULL,
  `commission_paisa` BIGINT NOT NULL,
  `adjustments_paisa` BIGINT NOT NULL DEFAULT 0,
  `refunds_paisa` BIGINT NOT NULL DEFAULT 0,
  `cod_collection_paisa` BIGINT NOT NULL DEFAULT 0,
  `net_payable_paisa` BIGINT NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'prepared',
  `evidence_json` LONGTEXT NOT NULL,
  `prepared_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `approved_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `approved_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `idx_vendor_settlement_vendor_period` (`vendor_id`,`period_start`,`period_end`),
  CONSTRAINT `fk_vendor_settlement_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_settlement_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `settlement_batch_id` BIGINT UNSIGNED NOT NULL,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `gross_paisa` BIGINT NOT NULL,
  `commission_paisa` BIGINT NOT NULL,
  `refund_paisa` BIGINT NOT NULL DEFAULT 0,
  `cod_collection_paisa` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_settlement_order_item` (`order_item_id`),
  KEY `idx_settlement_item_batch` (`settlement_batch_id`),
  CONSTRAINT `fk_settlement_item_batch` FOREIGN KEY (`settlement_batch_id`) REFERENCES `vendor_settlement_batches` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_settlement_item_order_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_financial_adjustments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `effective_date` DATE NOT NULL,
  `direction` VARCHAR(8) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `reason` VARCHAR(255) NOT NULL,
  `decision_note` VARCHAR(255) NOT NULL DEFAULT '',
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `approved_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `approved_at` DATETIME DEFAULT NULL,
  `settlement_batch_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `idx_vendor_adjustment_period` (`vendor_id`,`effective_date`,`status`),
  CONSTRAINT `fk_vendor_adjustment_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_vendor_adjustment_batch` FOREIGN KEY (`settlement_batch_id`) REFERENCES `vendor_settlement_batches` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `permissions` (`name`,`module`,`description`) VALUES
 ('returns.review','returns','Review customer returns and inspect disposition'),
 ('refunds.approve_high','finance','Approve refunds above the configured standard approval limit'),
 ('settlements.prepare','finance','Prepare vendor settlements'),
 ('settlements.approve','finance','Approve vendor settlements')
ON DUPLICATE KEY UPDATE `description`=VALUES(`description`);
INSERT INTO `role_permissions` (`role_id`,`permission_id`)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.name IN ('returns.review','settlements.prepare','settlements.approve')
WHERE r.name='admin' ON DUPLICATE KEY UPDATE permission_id=VALUES(permission_id);
