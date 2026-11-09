-- ============================================================================
-- Migration 0036 (UP): Multi-Tier Affiliate Marketing Program & Mobile Push Notifications
-- Target: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- All monetary amounts stored as BIGINT integer paisa (1 BDT = 100 paisa)
-- ============================================================================

CREATE TABLE IF NOT EXISTS `affiliates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `affiliate_code` VARCHAR(32) NOT NULL,
  `parent_affiliate_id` BIGINT UNSIGNED DEFAULT NULL,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `commission_rate_bps` INT UNSIGNED NOT NULL DEFAULT 500,
  `tier2_commission_rate_bps` INT UNSIGNED NOT NULL DEFAULT 100,
  `balance_paisa` BIGINT NOT NULL DEFAULT 0,
  `pending_balance_paisa` BIGINT NOT NULL DEFAULT 0,
  `lifetime_earnings_paisa` BIGINT NOT NULL DEFAULT 0,
  `payout_method` VARCHAR(32) NOT NULL DEFAULT 'bKash',
  `payout_account` VARCHAR(100) NOT NULL DEFAULT '',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_affiliates_code` (`affiliate_code`),
  UNIQUE KEY `uq_affiliates_phone` (`phone`),
  KEY `idx_affiliates_parent` (`parent_affiliate_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `affiliate_links` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `affiliate_id` BIGINT UNSIGNED NOT NULL,
  `target_type` VARCHAR(32) NOT NULL DEFAULT 'storefront',
  `target_id` VARCHAR(191) DEFAULT NULL,
  `target_url` VARCHAR(500) NOT NULL,
  `clicks_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `conversions_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_affiliate_links_aff` (`affiliate_id`),
  CONSTRAINT `fk_affiliate_links_aff` FOREIGN KEY (`affiliate_id`) REFERENCES `affiliates` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `affiliate_commissions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `affiliate_id` BIGINT UNSIGNED NOT NULL,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `tier` TINYINT NOT NULL DEFAULT 1,
  `sale_amount_paisa` BIGINT NOT NULL DEFAULT 0,
  `rate_bps` INT UNSIGNED NOT NULL DEFAULT 500,
  `commission_paisa` BIGINT NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `approved_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_aff_comm_aff_status` (`affiliate_id`, `status`),
  KEY `idx_aff_comm_order` (`order_id`),
  CONSTRAINT `fk_aff_comm_aff` FOREIGN KEY (`affiliate_id`) REFERENCES `affiliates` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `affiliate_withdrawals` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `affiliate_id` BIGINT UNSIGNED NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `payout_method` VARCHAR(32) NOT NULL,
  `payout_account` VARCHAR(100) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `admin_note` VARCHAR(255) NOT NULL DEFAULT '',
  `processed_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_aff_with_aff_status` (`affiliate_id`, `status`),
  CONSTRAINT `fk_aff_with_aff` FOREIGN KEY (`affiliate_id`) REFERENCES `affiliates` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `device_push_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token` VARCHAR(255) NOT NULL,
  `app_type` VARCHAR(32) NOT NULL DEFAULT 'customer',
  `user_id` BIGINT UNSIGNED DEFAULT NULL,
  `platform` VARCHAR(32) NOT NULL DEFAULT 'android',
  `topic` VARCHAR(64) NOT NULL DEFAULT 'general',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `last_seen_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_push_tokens_token` (`token`),
  KEY `idx_push_tokens_app_topic` (`app_type`, `topic`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `push_notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `app_type` VARCHAR(32) NOT NULL DEFAULT 'customer',
  `target_audience` VARCHAR(64) NOT NULL DEFAULT 'all',
  `title` VARCHAR(191) NOT NULL,
  `body` TEXT NOT NULL,
  `image_url` VARCHAR(500) DEFAULT NULL,
  `deep_link` VARCHAR(500) DEFAULT NULL,
  `sent_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'sent',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_push_notif_app` (`app_type`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `orders`
  ADD COLUMN IF NOT EXISTS `affiliate_code` VARCHAR(32) DEFAULT NULL;
