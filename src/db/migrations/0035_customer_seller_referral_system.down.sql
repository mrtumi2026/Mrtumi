-- ============================================================================
-- Migration 0035 (DOWN): Rollback Customer & Seller Referral System with Wallet
-- ============================================================================

ALTER TABLE `vendors`
  DROP COLUMN `referral_code`;

ALTER TABLE `customers`
  DROP COLUMN `referred_by_code`,
  DROP COLUMN `referral_code`;

ALTER TABLE `orders`
  DROP COLUMN `referred_by_type`,
  DROP COLUMN `referred_by_id`,
  DROP COLUMN `referral_code`;

DROP TABLE IF EXISTS `referral_rewards`;
DROP TABLE IF EXISTS `customer_wallet_transactions`;
DROP TABLE IF EXISTS `customer_wallets`;
DROP TABLE IF EXISTS `referral_codes`;
