-- ============================================================================
-- Migration 0038 (UP): Vendor Courier Booking Requests and Audit Trail
-- Target Engine: MariaDB 10.3+ / MySQL 8.0+
-- Provides database-enforced active request uniqueness via virtual column
-- ============================================================================

CREATE TABLE IF NOT EXISTS `vendor_courier_booking_requests` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `sub_order_id` BIGINT NOT NULL,
  `order_id` BIGINT NOT NULL,
  `vendor_id` INT NOT NULL,
  `courier_code` VARCHAR(50) DEFAULT NULL,
  `status` VARCHAR(30) NOT NULL DEFAULT 'pending',
  `tracking_id` VARCHAR(120) DEFAULT NULL,
  `consignment_id` VARCHAR(120) DEFAULT NULL,
  `rejection_reason` TEXT DEFAULT NULL,
  `failure_reason` TEXT DEFAULT NULL,
  `vendor_notes` TEXT DEFAULT NULL,
  `admin_notes` TEXT DEFAULT NULL,
  `idempotency_key` VARCHAR(120) DEFAULT NULL,
  `courier_response_json` LONGTEXT DEFAULT NULL,
  `approved_by_admin_id` INT DEFAULT NULL,
  `active_sub_order_id` BIGINT GENERATED ALWAYS AS (
    CASE WHEN `status` IN ('pending', 'booking', 'booked') THEN `sub_order_id` ELSE NULL END
  ) VIRTUAL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_vcbr_vendor_status` (`vendor_id`, `status`),
  INDEX `idx_vcbr_sub_order` (`sub_order_id`),
  UNIQUE KEY `uq_vcbr_idempotency` (`idempotency_key`),
  UNIQUE KEY `uq_vcbr_active_sub_order` (`active_sub_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_courier_booking_audit_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `booking_request_id` BIGINT NOT NULL,
  `sub_order_id` BIGINT NOT NULL,
  `action` VARCHAR(50) NOT NULL,
  `actor_type` VARCHAR(20) NOT NULL,
  `actor_id` INT NOT NULL,
  `from_status` VARCHAR(30) DEFAULT NULL,
  `to_status` VARCHAR(30) DEFAULT NULL,
  `details_json` LONGTEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_vcbal_request` (`booking_request_id`),
  INDEX `idx_vcbal_sub_order` (`sub_order_id`),
  INDEX `idx_vcbal_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
