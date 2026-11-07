-- ============================================================================
-- Migration 0016 (DOWN): Reverse Multi-Vendor Commerce Engine
-- ============================================================================
DELETE FROM `permissions` WHERE `name` IN (
  'vendor_orders.view','vendor_orders.update','vendor_payouts.view',
  'vendor_payouts.approve','vendor_payouts.mark_paid','commission_rules.manage',
  'payment_gateways.manage','payment_transactions.view'
);
DROP TABLE IF EXISTS `vendor_payout_requests`;
DROP TABLE IF EXISTS `vendor_ledger_entries`;
DROP TABLE IF EXISTS `vendor_wallets`;
ALTER TABLE `order_items`  DROP FOREIGN KEY IF EXISTS `fk_order_items_vendor_order`;
ALTER TABLE `order_items`  DROP INDEX     IF EXISTS `idx_order_items_vendor_order`;
ALTER TABLE `order_items`  DROP COLUMN    IF EXISTS `vendor_order_id`;
DROP TABLE IF EXISTS `vendor_orders`;
DROP TABLE IF EXISTS `commission_rules`;
ALTER TABLE `payment_gateways`
  DROP COLUMN IF EXISTS `config_json`,
  DROP COLUMN IF EXISTS `webhook_secret`,
  DROP COLUMN IF EXISTS `gateway_fee_bps`,
  DROP COLUMN IF EXISTS `gateway_type`;
