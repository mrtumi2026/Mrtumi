-- ============================================================================
-- Migration 0036 (DOWN): Rollback Multi-Tier Affiliate Marketing Program & Mobile Push Notifications
-- ============================================================================

ALTER TABLE `orders`
  DROP COLUMN IF EXISTS `affiliate_code`;

DROP TABLE IF EXISTS `push_notifications`;
DROP TABLE IF EXISTS `device_push_tokens`;
DROP TABLE IF EXISTS `affiliate_withdrawals`;
DROP TABLE IF EXISTS `affiliate_commissions`;
DROP TABLE IF EXISTS `affiliate_links`;
DROP TABLE IF EXISTS `affiliates`;
