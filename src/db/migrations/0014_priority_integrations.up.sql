-- Priority storefront integrations: preserve existing values while adding legacy-admin fields.
ALTER TABLE `banners`
  ADD COLUMN `badge` VARCHAR(100) NOT NULL DEFAULT '' AFTER `subtitle`,
  ADD COLUMN `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `status`;

ALTER TABLE `payment_gateways`
  ADD COLUMN `api_key` TEXT DEFAULT NULL AFTER `account_number`,
  ADD COLUMN `secret_key` TEXT DEFAULT NULL AFTER `api_key`,
  ADD COLUMN `merchant_id` VARCHAR(191) NOT NULL DEFAULT '' AFTER `secret_key`;

ALTER TABLE `courier_apis`
  ADD COLUMN `api_key` TEXT DEFAULT NULL AFTER `base_url`,
  ADD COLUMN `secret_key` TEXT DEFAULT NULL AFTER `api_key`,
  ADD COLUMN `sandbox` TINYINT(1) NOT NULL DEFAULT 1 AFTER `status`;
