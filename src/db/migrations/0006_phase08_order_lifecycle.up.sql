-- Phase 08 additive columns/tables. Existing rows receive safe NULL/empty defaults.
ALTER TABLE `refunds`
  ADD COLUMN `request_key` VARCHAR(128) DEFAULT NULL AFTER `reason`,
  ADD COLUMN `provider_reference` VARCHAR(128) DEFAULT NULL AFTER `request_key`,
  ADD UNIQUE KEY `uq_refunds_request_key` (`request_key`);

CREATE TABLE IF NOT EXISTS `refund_status_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `refund_id` BIGINT UNSIGNED NOT NULL,
  `from_status` VARCHAR(24) NOT NULL DEFAULT '',
  `to_status` VARCHAR(24) NOT NULL,
  `reason` VARCHAR(255) NOT NULL,
  `request_key` VARCHAR(128) DEFAULT NULL,
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_refund_history_refund_created` (`refund_id`, `created_at`),
  CONSTRAINT `fk_refund_history_refund` FOREIGN KEY (`refund_id`) REFERENCES `refunds` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_refund_history_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `order_status_history`
  ADD COLUMN `request_key` VARCHAR(128) DEFAULT NULL AFTER `note`,
  ADD UNIQUE KEY `uq_order_status_history_request` (`request_key`);

ALTER TABLE `stock_reservations`
  ADD COLUMN `request_hash` CHAR(64) NOT NULL DEFAULT '' AFTER `reservation_key`;

ALTER TABLE `order_otps`
  ADD COLUMN `session_hash` CHAR(64) NOT NULL DEFAULT '' AFTER `phone`,
  ADD COLUMN `customer_id` BIGINT UNSIGNED DEFAULT NULL AFTER `order_id`,
  ADD KEY `idx_order_otps_binding` (`order_id`, `customer_id`, `session_hash`, `verified_at`),
  ADD CONSTRAINT `fk_order_otps_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE;

ALTER TABLE `incomplete_orders`
  ADD COLUMN `dedupe_key` CHAR(64) DEFAULT NULL AFTER `session_sid`,
  ADD COLUMN `notification_allowed` TINYINT(1) NOT NULL DEFAULT 0 AFTER `consent_given`,
  ADD COLUMN `consent_withdrawn_at` DATETIME DEFAULT NULL AFTER `notification_allowed`,
  ADD COLUMN `recovered_order_id` BIGINT UNSIGNED DEFAULT NULL AFTER `status`,
  ADD UNIQUE KEY `uq_incomplete_dedupe` (`dedupe_key`),
  ADD UNIQUE KEY `uq_incomplete_recovered_order` (`recovered_order_id`),
  ADD CONSTRAINT `fk_incomplete_recovered_order` FOREIGN KEY (`recovered_order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS `incomplete_order_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `incomplete_order_id` BIGINT UNSIGNED NOT NULL,
  `from_status` VARCHAR(32) NOT NULL DEFAULT '',
  `to_status` VARCHAR(32) NOT NULL,
  `reason` VARCHAR(255) NOT NULL DEFAULT '',
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_incomplete_history_record_created` (`incomplete_order_id`, `created_at`),
  CONSTRAINT `fk_incomplete_history_record` FOREIGN KEY (`incomplete_order_id`) REFERENCES `incomplete_orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_incomplete_history_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
