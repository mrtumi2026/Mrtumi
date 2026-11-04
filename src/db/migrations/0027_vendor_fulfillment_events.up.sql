-- Explicit delivery ownership stays NULL until an authorized operator classifies the shipment.
ALTER TABLE `vendor_sub_orders`
  ADD COLUMN `delivery_mode` VARCHAR(24) DEFAULT NULL AFTER `status`;

ALTER TABLE `fulfillment_shipments`
  ADD COLUMN `booking_status` VARCHAR(24) DEFAULT NULL AFTER `status`,
  MODIFY COLUMN `tracking_id` VARCHAR(120) DEFAULT NULL AFTER `courier_code`;

CREATE TABLE IF NOT EXISTS `fulfillment_shipment_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shipment_id` BIGINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(32) NOT NULL,
  `actor_type` VARCHAR(16) NOT NULL,
  `vendor_id` BIGINT UNSIGNED DEFAULT NULL,
  `user_id` BIGINT UNSIGNED DEFAULT NULL,
  `courier_code` VARCHAR(48) NOT NULL DEFAULT '',
  `tracking_reference` VARCHAR(120) NOT NULL DEFAULT '',
  `result_code` VARCHAR(24) NOT NULL DEFAULT '',
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_shipment_event_history` (`shipment_id`,`created_at`,`id`),
  KEY `idx_shipment_event_actor` (`actor_type`,`vendor_id`,`user_id`,`created_at`),
  CONSTRAINT `fk_shipment_event_shipment` FOREIGN KEY (`shipment_id`) REFERENCES `fulfillment_shipments` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_shipment_event_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_shipment_event_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
