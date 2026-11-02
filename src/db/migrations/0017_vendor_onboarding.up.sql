-- Complete vendor application, verification and activation lifecycle.
ALTER TABLE `products`
  ADD COLUMN `approval_rejection_reason` VARCHAR(1000) NOT NULL DEFAULT '' AFTER `approval_status`;

ALTER TABLE `vendors`
  ADD COLUMN `lifecycle_status` VARCHAR(24) NOT NULL DEFAULT 'pending' AFTER `verified`,
  ADD COLUMN `phone_verified_at` DATETIME DEFAULT NULL AFTER `lifecycle_status`,
  ADD COLUMN `identity_verified_at` DATETIME DEFAULT NULL AFTER `phone_verified_at`,
  ADD COLUMN `onboarding_completed_at` DATETIME DEFAULT NULL AFTER `identity_verified_at`,
  ADD COLUMN `commission_configured_at` DATETIME DEFAULT NULL AFTER `onboarding_completed_at`,
  ADD COLUMN `payout_verified_at` DATETIME DEFAULT NULL AFTER `commission_configured_at`,
  ADD COLUMN `trusted_auto_publish` TINYINT(1) NOT NULL DEFAULT 0 AFTER `payout_verified_at`;

-- Preserve previously verified accounts; their historical verification and commission are grandfathered.
UPDATE `vendors`
SET `lifecycle_status` = CASE WHEN `status`=0 THEN 'deactivated' WHEN `verified`=1 THEN 'active' ELSE 'pending' END,
    `phone_verified_at` = CASE WHEN `verified`=1 THEN `created_at` ELSE NULL END,
    `identity_verified_at` = CASE WHEN `verified`=1 THEN `created_at` ELSE NULL END,
    `onboarding_completed_at` = CASE WHEN `verified`=1 THEN `created_at` ELSE NULL END,
    `commission_configured_at` = CASE WHEN `verified`=1 THEN `created_at` ELSE NULL END;

ALTER TABLE `vendors`
  ADD KEY `idx_vendors_lifecycle` (`lifecycle_status`,`status`,`created_at`),
  ADD KEY `idx_vendors_email` (`email`);

CREATE TABLE IF NOT EXISTS `vendor_applications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `business_type` VARCHAR(32) NOT NULL,
  `business_category` VARCHAR(100) NOT NULL,
  `district` VARCHAR(100) NOT NULL,
  `upazila` VARCHAR(100) NOT NULL,
  `nid_ciphertext` TEXT NOT NULL,
  `nid_hash` CHAR(64) NOT NULL,
  `nid_front_document` VARCHAR(128) NOT NULL,
  `nid_back_document` VARCHAR(128) NOT NULL,
  `trade_license_document` VARCHAR(128) DEFAULT NULL,
  `shop_logo_document` VARCHAR(128) NOT NULL,
  `resubmission_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendor_application_vendor` (`vendor_id`),
  UNIQUE KEY `uq_vendor_application_nid_hash` (`nid_hash`),
  CONSTRAINT `fk_vendor_application_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_status_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `from_status` VARCHAR(24) NOT NULL DEFAULT '',
  `to_status` VARCHAR(24) NOT NULL,
  `reason` VARCHAR(1000) NOT NULL DEFAULT '',
  `actor_type` VARCHAR(24) NOT NULL,
  `actor_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_status_history_vendor` (`vendor_id`,`created_at`,`id`),
  CONSTRAINT `fk_vendor_status_history_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `vendor_status_history` (`vendor_id`,`from_status`,`to_status`,`reason`,`actor_type`,`actor_id`)
SELECT `id`,'',`lifecycle_status`,'Lifecycle backfilled during vendor onboarding migration','system',NULL
FROM `vendors`;

CREATE TABLE IF NOT EXISTS `vendor_phone_otps` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `otp_hash` CHAR(64) NOT NULL,
  `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `expires_at` DATETIME NOT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_phone_otp_active` (`vendor_id`,`verified_at`,`expires_at`,`id`),
  CONSTRAINT `fk_vendor_phone_otp_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_payout_accounts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `method` VARCHAR(16) NOT NULL,
  `details_ciphertext` TEXT NOT NULL,
  `masked_account` VARCHAR(32) NOT NULL,
  `verification_status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `verification_reason` VARCHAR(1000) NOT NULL DEFAULT '',
  `verified_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_payout_accounts_vendor_status` (`vendor_id`,`verification_status`,`id`),
  CONSTRAINT `fk_vendor_payout_accounts_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_vendor_payout_accounts_verifier` FOREIGN KEY (`verified_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `vendor_withdrawals`
  ADD COLUMN `payout_account_id` BIGINT UNSIGNED DEFAULT NULL AFTER `vendor_id`,
  ADD KEY `idx_vendor_withdrawals_payout_account` (`payout_account_id`),
  ADD CONSTRAINT `fk_vendor_withdrawals_payout_account` FOREIGN KEY (`payout_account_id`) REFERENCES `vendor_payout_accounts` (`id`) ON DELETE RESTRICT;
