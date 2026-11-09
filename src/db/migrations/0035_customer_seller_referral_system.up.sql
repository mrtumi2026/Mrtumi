-- ============================================================================
-- Migration 0035 (UP): Customer & Seller Referral System with Wallet
-- Target: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- All monetary amounts stored as BIGINT paisa (1 BDT = 100 paisa)
-- ============================================================================

CREATE TABLE IF NOT EXISTS `referral_codes` (
  `code` VARCHAR(32) NOT NULL,
  `actor_type` VARCHAR(32) NOT NULL DEFAULT 'customer',
  `actor_id` BIGINT UNSIGNED NOT NULL,
  `clicks_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `conversions_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`),
  KEY `idx_referral_codes_actor` (`actor_type`, `actor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_wallets` (
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `balance_paisa` BIGINT NOT NULL DEFAULT 0,
  `points_balance` INT UNSIGNED NOT NULL DEFAULT 0,
  `lifetime_earned_paisa` BIGINT NOT NULL DEFAULT 0,
  `lifetime_points_earned` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`customer_id`),
  CONSTRAINT `fk_customer_wallets_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_wallet_transactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `tx_type` VARCHAR(32) NOT NULL DEFAULT 'referral_cashback',
  `amount_paisa` BIGINT NOT NULL DEFAULT 0,
  `points` INT NOT NULL DEFAULT 0,
  `balance_after_paisa` BIGINT NOT NULL DEFAULT 0,
  `points_after` INT UNSIGNED NOT NULL DEFAULT 0,
  `reference_id` VARCHAR(120) DEFAULT NULL,
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cust_wallet_tx_cust` (`customer_id`, `created_at`),
  CONSTRAINT `fk_cust_wallet_tx_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `referral_rewards` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `referral_code` VARCHAR(32) NOT NULL,
  `referrer_type` VARCHAR(32) NOT NULL DEFAULT 'customer',
  `referrer_id` BIGINT UNSIGNED NOT NULL,
  `referee_customer_id` BIGINT UNSIGNED DEFAULT NULL,
  `referee_phone` VARCHAR(32) NOT NULL DEFAULT '',
  `order_id` BIGINT UNSIGNED DEFAULT NULL,
  `order_amount_paisa` BIGINT NOT NULL DEFAULT 0,
  `reward_type` VARCHAR(32) NOT NULL DEFAULT 'cashback',
  `reward_paisa` BIGINT NOT NULL DEFAULT 0,
  `reward_points` INT UNSIGNED NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `credited_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_referral_rewards_referrer` (`referrer_type`, `referrer_id`),
  KEY `idx_referral_rewards_order` (`order_id`),
  KEY `idx_referral_rewards_code` (`referral_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `orders`
  ADD COLUMN IF NOT EXISTS `referral_code` VARCHAR(32) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `referred_by_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `referred_by_type` VARCHAR(32) DEFAULT NULL;

ALTER TABLE `customers`
  ADD COLUMN IF NOT EXISTS `referral_code` VARCHAR(32) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `referred_by_code` VARCHAR(32) DEFAULT NULL;

ALTER TABLE `vendors`
  ADD COLUMN IF NOT EXISTS `referral_code` VARCHAR(32) DEFAULT NULL;
