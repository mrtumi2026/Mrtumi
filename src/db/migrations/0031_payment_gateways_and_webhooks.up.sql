-- ============================================================================
-- Migration 0031 (UP): Payment Gateways, Tokenized Checkout, and Webhook Logs
-- Target: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- Monetary values: BIGINT paisa (৳1.00 = 100 paisa)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Upgrade / Create payment_transactions Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `payment_transactions` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`           BIGINT UNSIGNED NOT NULL
                       COMMENT 'Parent order ID',
  `vendor_order_id`    BIGINT UNSIGNED DEFAULT NULL
                       COMMENT 'Child vendor order ID if charged individually',
  `gateway_code`       VARCHAR(48) NOT NULL
                       COMMENT 'bkash_tokenized|shurjopay|uddoktapay|cod|manual_bkash|manual_nagad',
  `payment_id`         VARCHAR(191) NOT NULL DEFAULT ''
                       COMMENT 'Gateway session or invoice token (bKash paymentID, Uddokta invoice_id)',
  `trx_id`             VARCHAR(191) NOT NULL DEFAULT ''
                       COMMENT 'Provider transaction reference (bKash trxID, bank TrxID)',
  `amount_paisa`       BIGINT NOT NULL
                       COMMENT 'Transaction amount in paisa',
  `currency`           CHAR(3) NOT NULL DEFAULT 'BDT',
  `status`             ENUM('initiated', 'authorized', 'captured', 'failed', 'cancelled', 'refunded')
                       NOT NULL DEFAULT 'initiated',
  `direction`          ENUM('charge', 'refund') NOT NULL DEFAULT 'charge',
  `customer_phone`     VARCHAR(32) NOT NULL DEFAULT '',
  `idempotency_key`    VARCHAR(128) NOT NULL
                       COMMENT 'Client or server-generated idempotency key',
  `raw_payload`        LONGTEXT DEFAULT NULL
                       COMMENT 'Payload dispatched to payment provider',
  `raw_response`       LONGTEXT DEFAULT NULL
                       COMMENT 'Provider response received',
  `initiated_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at`       DATETIME DEFAULT NULL,
  `created_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pay_trx_idempotency` (`idempotency_key`),
  KEY `idx_pay_trx_order`             (`order_id`, `status`),
  KEY `idx_pay_trx_vendor_order`      (`vendor_order_id`),
  KEY `idx_pay_trx_gateway_code`      (`gateway_code`, `status`),
  KEY `idx_pay_trx_payment_id`        (`payment_id`),
  KEY `idx_pay_trx_provider_trx`      (`trx_id`),
  CONSTRAINT `fk_pay_trx_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_pay_trx_vendor_order`
    FOREIGN KEY (`vendor_order_id`) REFERENCES `vendor_orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Idempotent Webhook Execution Journal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `payment_webhook_logs` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `gateway_code`       VARCHAR(48) NOT NULL,
  `event_type`         VARCHAR(64) NOT NULL DEFAULT 'callback'
                       COMMENT 'callback|ipn|webhook|refund_callback',
  `idempotency_hash`   CHAR(64) NOT NULL
                       COMMENT 'SHA-256 of provider event ID, signature, or canonical payload',
  `headers_json`       LONGTEXT DEFAULT NULL,
  `payload_json`       LONGTEXT DEFAULT NULL,
  `status`             ENUM('received', 'processing', 'processed', 'failed', 'replayed')
                       NOT NULL DEFAULT 'received',
  `response_code`      INT NOT NULL DEFAULT 200,
  `response_body`      TEXT DEFAULT NULL,
  `error_message`      TEXT DEFAULT NULL,
  `processing_time_ms` INT DEFAULT NULL,
  `client_ip`          VARCHAR(64) NOT NULL DEFAULT '',
  `created_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_webhook_idempotency_hash` (`idempotency_hash`),
  KEY `idx_webhook_gateway_status`        (`gateway_code`, `status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Payment Gateway Configuration Seeds (Base COD)
-- ---------------------------------------------------------------------------
INSERT INTO `payment_gateways`
  (`name`, `code`, `gateway_type`, `account_number`, `instructions`, `sandbox`, `status`, `gateway_fee_bps`, `webhook_secret`)
VALUES
  ('Cash on Delivery (COD)', 'cod', 'manual', '', 'Pay in cash to the courier upon delivery.', 0, 1, 0, '')
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `gateway_type` = VALUES(`gateway_type`),
  `instructions` = VALUES(`instructions`),
  `status` = VALUES(`status`),
  `gateway_fee_bps` = VALUES(`gateway_fee_bps`);
