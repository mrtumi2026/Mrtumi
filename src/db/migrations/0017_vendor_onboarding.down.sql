ALTER TABLE `vendor_withdrawals`
  DROP FOREIGN KEY `fk_vendor_withdrawals_payout_account`,
  DROP INDEX `idx_vendor_withdrawals_payout_account`,
  DROP COLUMN `payout_account_id`;
DROP TABLE IF EXISTS `vendor_payout_accounts`;
DROP TABLE IF EXISTS `vendor_phone_otps`;
DROP TABLE IF EXISTS `vendor_status_history`;
DROP TABLE IF EXISTS `vendor_applications`;
ALTER TABLE `vendors`
  DROP INDEX `idx_vendors_lifecycle`,
  DROP INDEX `idx_vendors_email`,
  DROP COLUMN `trusted_auto_publish`,
  DROP COLUMN `payout_verified_at`,
  DROP COLUMN `commission_configured_at`,
  DROP COLUMN `onboarding_completed_at`,
  DROP COLUMN `identity_verified_at`,
  DROP COLUMN `phone_verified_at`,
  DROP COLUMN `lifecycle_status`;
ALTER TABLE `products` DROP COLUMN `approval_rejection_reason`;
