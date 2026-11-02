-- Admin-managed reseller commerce settings and explicit co-branding review state.
ALTER TABLE `reseller_commerce_settings`
  ADD COLUMN `platform_fee_type` VARCHAR(16) NOT NULL DEFAULT 'fixed' AFTER `platform_fee_paisa`,
  ADD COLUMN `platform_fee_bps` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `platform_fee_type`,
  ADD CONSTRAINT `chk_reseller_platform_fee_type` CHECK (`platform_fee_type` IN ('fixed','percent')),
  ADD CONSTRAINT `chk_reseller_platform_fee_bps` CHECK (`platform_fee_bps` <= 10000);

ALTER TABLE `resellers`
  ADD COLUMN `logo_url` VARCHAR(500) NOT NULL DEFAULT '' AFTER `shop_name`,
  ADD COLUMN `branding_status` VARCHAR(16) NOT NULL DEFAULT 'pending' AFTER `logo_url`,
  ADD COLUMN `branding_review_note` VARCHAR(500) NOT NULL DEFAULT '' AFTER `branding_status`,
  ADD COLUMN `branding_reviewed_by_user_id` BIGINT UNSIGNED DEFAULT NULL AFTER `branding_review_note`,
  ADD COLUMN `branding_reviewed_at` DATETIME DEFAULT NULL AFTER `branding_reviewed_by_user_id`,
  ADD KEY `idx_resellers_branding_status` (`branding_status`,`status`),
  ADD CONSTRAINT `chk_reseller_branding_status` CHECK (`branding_status` IN ('pending','approved','rejected')),
  ADD CONSTRAINT `fk_reseller_branding_reviewer` FOREIGN KEY (`branding_reviewed_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;
