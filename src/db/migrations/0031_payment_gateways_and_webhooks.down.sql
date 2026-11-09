-- ============================================================================
-- Migration 0017 (DOWN): Rollback payment_transactions and webhook logs
-- ============================================================================
DROP TABLE IF EXISTS `payment_webhook_logs`;
DROP TABLE IF EXISTS `payment_transactions`;
DELETE FROM `payment_gateways` WHERE `code` IN ('bkash_tokenized', 'shurjopay', 'uddoktapay');
