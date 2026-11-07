-- ============================================================================
-- Migration 0029 (DOWN): Rollback Dynamic MFS Gateways
-- ============================================================================

DELETE FROM `payment_gateways`
WHERE `code` IN (
  'bkash_api',
  'bkash_manual',
  'nagad_api',
  'nagad_manual',
  'rocket_api',
  'rocket_manual'
);

ALTER TABLE `payment_transactions`
  DROP COLUMN IF EXISTS `verified_at`,
  DROP COLUMN IF EXISTS `verified_by_user_id`,
  DROP COLUMN IF EXISTS `manual_trx_id`,
  DROP COLUMN IF EXISTS `manual_sender_number`;

ALTER TABLE `orders`
  DROP COLUMN IF EXISTS `verified_at`,
  DROP COLUMN IF EXISTS `verified_by_user_id`,
  DROP COLUMN IF EXISTS `manual_trx_id`,
  DROP COLUMN IF EXISTS `manual_sender_number`;

ALTER TABLE `payment_gateways`
  DROP COLUMN IF EXISTS `max_order_paisa`,
  DROP COLUMN IF EXISTS `min_order_paisa`,
  DROP COLUMN IF EXISTS `api_credentials`,
  DROP COLUMN IF EXISTS `instructions_bn`,
  DROP COLUMN IF EXISTS `mode`,
  DROP COLUMN IF EXISTS `is_active`;
