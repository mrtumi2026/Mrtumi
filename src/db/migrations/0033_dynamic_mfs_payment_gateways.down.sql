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
  DROP COLUMN `verified_at`,
  DROP COLUMN `verified_by_user_id`,
  DROP COLUMN `manual_trx_id`,
  DROP COLUMN `manual_sender_number`;

ALTER TABLE `orders`
  DROP COLUMN `verified_at`,
  DROP COLUMN `verified_by_user_id`,
  DROP COLUMN `manual_trx_id`,
  DROP COLUMN `manual_sender_number`;

ALTER TABLE `payment_gateways`
  DROP COLUMN `max_order_paisa`,
  DROP COLUMN `min_order_paisa`,
  DROP COLUMN `api_credentials`,
  DROP COLUMN `instructions_bn`,
  DROP COLUMN `mode`,
  DROP COLUMN `is_active`;
