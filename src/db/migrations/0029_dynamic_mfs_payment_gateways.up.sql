-- ============================================================================
-- Migration 0029 (UP): Dynamic Dual-Mode Bangladesh MFS Payment Gateways
-- Target: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- Monetary values: BIGINT paisa (1 BDT = 100 paisa)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Purge Obsolete Third-Party Aggregators (ShurjoPay & UddoktaPay)
-- ---------------------------------------------------------------------------
DELETE FROM `payment_gateways` WHERE `code` IN ('shurjopay', 'uddoktapay');

-- ---------------------------------------------------------------------------
-- 2. Extend payment_gateways with Dual-Mode Attributes & Bengali Instructions
-- ---------------------------------------------------------------------------
ALTER TABLE `payment_gateways`
  ADD COLUMN IF NOT EXISTS `is_active` TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '1 = Active and visible on checkout; 0 = Deactivated',
  ADD COLUMN IF NOT EXISTS `mode` VARCHAR(24) NOT NULL DEFAULT 'auto'
    COMMENT 'auto = Programmatic API gateway; manual = Sender Number + TrxID',
  ADD COLUMN IF NOT EXISTS `instructions_bn` TEXT DEFAULT NULL
    COMMENT 'Localized instructions in Bengali for customer checkout display',
  ADD COLUMN IF NOT EXISTS `api_credentials` LONGTEXT DEFAULT NULL
    COMMENT 'Secure JSON configuration for automated API modes',
  ADD COLUMN IF NOT EXISTS `min_order_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Minimum order amount in paisa to use this channel',
  ADD COLUMN IF NOT EXISTS `max_order_paisa` BIGINT UNSIGNED DEFAULT NULL
    COMMENT 'Maximum order amount in paisa allowed for this channel';

-- ---------------------------------------------------------------------------
-- 3. Extend orders and payment_transactions with Manual Verification Columns
-- ---------------------------------------------------------------------------
ALTER TABLE `orders`
  ADD COLUMN IF NOT EXISTS `manual_sender_number` VARCHAR(32) NOT NULL DEFAULT ''
    COMMENT 'Customer mobile number used to send manual MFS payment',
  ADD COLUMN IF NOT EXISTS `manual_trx_id` VARCHAR(128) NOT NULL DEFAULT ''
    COMMENT 'Customer provided transaction ID for manual verification',
  ADD COLUMN IF NOT EXISTS `verified_by_user_id` BIGINT UNSIGNED DEFAULT NULL
    COMMENT 'Staff/Admin user ID who confirmed manual payment',
  ADD COLUMN IF NOT EXISTS `verified_at` DATETIME DEFAULT NULL
    COMMENT 'Timestamp when manual payment was verified';

ALTER TABLE `payment_transactions`
  ADD COLUMN IF NOT EXISTS `manual_sender_number` VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS `manual_trx_id` VARCHAR(128) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS `verified_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `verified_at` DATETIME DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- 4. Seed Canonical 7-Channel Dual-Mode Payment Gateways
-- ---------------------------------------------------------------------------
INSERT INTO `payment_gateways`
  (`name`, `code`, `mode`, `gateway_type`, `account_number`, `instructions`, `instructions_bn`, `is_active`, `status`, `sandbox`, `gateway_fee_bps`, `min_order_paisa`)
VALUES
  ('bKash Online Payment', 'bkash_api', 'auto', 'auto', '',
   'Instant automated mobile payment via official bKash Tokenized Checkout API.',
   'bKash পেমেন্ট গেটওয়ের মাধ্যমে তাৎক্ষণিক স্বয়ংক্রিয় পেমেন্ট করুন।',
   1, 1, 1, 150, 1000),

  ('bKash Manual Send Money', 'bkash_manual', 'manual', 'manual', '01711-000000',
   'Send Money to our bKash Merchant/Personal wallet and enter your Sender Phone & TrxID.',
   'আমাদের বিকাশ নম্বরে Send Money করুন এবং নিচের ঘরে আপনার বিকাশ নম্বর ও TrxID লিখুন।',
   1, 1, 0, 0, 1000),

  ('Nagad Online Payment', 'nagad_api', 'auto', 'auto', '',
   'Pay instantly using official Nagad PGW automated gateway.',
   'নগদ অনলাইন গেটওয়ের মাধ্যমে সরাসরি পেমেন্ট করুন।',
   1, 1, 1, 120, 1000),

  ('Nagad Manual Send Money', 'nagad_manual', 'manual', 'manual', '01711-000000',
   'Send Money to our Nagad Merchant/Personal wallet and enter your Sender Phone & TrxID.',
   'আমাদের নগদ নম্বরে Send Money করুন এবং নিচের ঘরে আপনার নগদ নম্বর ও TrxID লিখুন।',
   1, 1, 0, 0, 1000),

  ('Rocket Online Payment', 'rocket_api', 'auto', 'auto', '',
   'Pay instantly using DBBL Rocket PGW API.',
   'রকেট অনলাইন গেটওয়ের মাধ্যমে সরাসরি পেমেন্ট করুন।',
   1, 1, 1, 180, 1000),

  ('Rocket Manual Send Money', 'rocket_manual', 'manual', 'manual', '01711-000000',
   'Send Money to our Rocket Merchant/Personal wallet and enter your Sender Phone & TrxID.',
   'আমাদের রকেট নম্বরে Send Money করুন এবং নিচের ঘরে আপনার রকেট নম্বর ও TrxID লিখুন।',
   1, 1, 0, 0, 1000),

  ('Cash on Delivery (COD)', 'cod', 'manual', 'auto', '',
   'Pay in cash to the courier representative upon delivery.',
   'পণ্য হাতে পেয়ে ক্যাশ ডেলিভারি ম্যানের কাছে পরিশোধ করুন।',
   1, 1, 0, 0, 0)
ON DUPLICATE KEY UPDATE
  `name`            = VALUES(`name`),
  `mode`            = VALUES(`mode`),
  `gateway_type`    = VALUES(`gateway_type`),
  `instructions`    = VALUES(`instructions`),
  `instructions_bn` = VALUES(`instructions_bn`),
  `is_active`       = VALUES(`is_active`),
  `status`          = VALUES(`status`),
  `gateway_fee_bps` = VALUES(`gateway_fee_bps`);
