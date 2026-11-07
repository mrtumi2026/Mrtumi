-- ============================================================================
-- Migration 0016 (UP): Multi-Vendor Commerce Engine
-- Split-orders, commission rules, vendor wallets, immutable ledger,
-- payout requests, and gateway configuration.
-- All monetary values: BIGINT integer paisa (1 BDT = 100 paisa).
-- Compatible: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Commission Rules (per-vendor or per-category overrides)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_rules` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scope`           VARCHAR(16) NOT NULL DEFAULT 'global'
                    COMMENT 'global | vendor | category',
  `vendor_id`       BIGINT UNSIGNED DEFAULT NULL
                    COMMENT 'NULL = applies to all vendors',
  `category_id`     BIGINT UNSIGNED DEFAULT NULL
                    COMMENT 'NULL = applies to all categories',
  `rule_type`       VARCHAR(16) NOT NULL DEFAULT 'percent'
                    COMMENT 'percent | flat',
  `rate_bps`        INT UNSIGNED NOT NULL DEFAULT 1000
                    COMMENT 'Basis points (1000 bps = 10.00%). Used when rule_type=percent.',
  `flat_paisa`      BIGINT NOT NULL DEFAULT 0
                    COMMENT 'Fixed fee in paisa per order item. Used when rule_type=flat.',
  `min_paisa`       BIGINT NOT NULL DEFAULT 0
                    COMMENT 'Minimum commission per line regardless of percent result.',
  `max_paisa`       BIGINT DEFAULT NULL
                    COMMENT 'Maximum commission cap per line. NULL = no cap.',
  `priority`        TINYINT UNSIGNED NOT NULL DEFAULT 10
                    COMMENT 'Lower number wins when multiple rules match.',
  `active`          TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`      BIGINT UNSIGNED DEFAULT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_commission_rules_scope`    (`scope`, `active`, `priority`),
  KEY `idx_commission_rules_vendor`   (`vendor_id`, `active`),
  KEY `idx_commission_rules_category` (`category_id`, `active`),
  CONSTRAINT `fk_commission_rules_vendor`
    FOREIGN KEY (`vendor_id`)   REFERENCES `vendors`     (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_commission_rules_category`
    FOREIGN KEY (`category_id`) REFERENCES `categories`  (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Vendor Sub-Orders (child orders split from a parent order by vendor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_orders` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`             BIGINT UNSIGNED NOT NULL
                         COMMENT 'Parent order FK',
  `vendor_id`            BIGINT UNSIGNED NOT NULL,
  `sub_order_ref`        VARCHAR(60) NOT NULL
                         COMMENT 'Human-readable: <invoice_no>-V<vendor_id>',
  `status`               VARCHAR(32) NOT NULL DEFAULT 'pending'
                         COMMENT 'pending|processing|packed|shipped|delivered|cancelled|return_requested|returned',
  `subtotal_paisa`       BIGINT NOT NULL DEFAULT 0
                         COMMENT 'Sum of item line totals for this vendor',
  `commission_paisa`     BIGINT NOT NULL DEFAULT 0
                         COMMENT 'Platform commission deducted from this sub-order',
  `gateway_fee_paisa`    BIGINT NOT NULL DEFAULT 0
                         COMMENT 'Payment gateway deduction if applicable',
  `shipping_paisa`       BIGINT NOT NULL DEFAULT 0
                         COMMENT 'Shipping amount credited to vendor if vendor-fulfilled',
  `vendor_earning_paisa` BIGINT NOT NULL DEFAULT 0
                         COMMENT 'Net: subtotal - commission - gateway_fee + shipping',
  `is_vendor_fulfilled`  TINYINT(1) NOT NULL DEFAULT 0
                         COMMENT '1 = vendor ships independently; 0 = platform ships',
  `courier_code`         VARCHAR(32) NOT NULL DEFAULT '',
  `courier_tracking_id`  VARCHAR(100) NOT NULL DEFAULT '',
  `packed_at`            DATETIME DEFAULT NULL,
  `shipped_at`           DATETIME DEFAULT NULL,
  `delivered_at`         DATETIME DEFAULT NULL,
  `cancelled_at`         DATETIME DEFAULT NULL,
  `cancel_reason`        VARCHAR(500) NOT NULL DEFAULT '',
  `ledger_credited`      TINYINT(1) NOT NULL DEFAULT 0
                         COMMENT '1 = earnings posted to vendor_ledger_entries',
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendor_orders_ref`         (`sub_order_ref`),
  KEY `idx_vendor_orders_order`             (`order_id`),
  KEY `idx_vendor_orders_vendor_status`     (`vendor_id`, `status`, `created_at`),
  KEY `idx_vendor_orders_ledger_uncredited` (`ledger_credited`, `status`),
  CONSTRAINT `fk_vendor_orders_order`
    FOREIGN KEY (`order_id`)  REFERENCES `orders`  (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_vendor_orders_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Link order_items to their sub-order (nullable until split is performed)
ALTER TABLE `order_items`
  ADD COLUMN IF NOT EXISTS `vendor_order_id` BIGINT UNSIGNED DEFAULT NULL
    COMMENT 'FK to vendor_orders.id — set during order split',
  ADD KEY IF NOT EXISTS `idx_order_items_vendor_order` (`vendor_order_id`);

-- ---------------------------------------------------------------------------
-- 3. Vendor Wallets (single row per vendor, balance in paisa)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_wallets` (
  `vendor_id`         BIGINT UNSIGNED NOT NULL,
  `available_paisa`   BIGINT NOT NULL DEFAULT 0
                      COMMENT 'Funds available for payout',
  `pending_paisa`     BIGINT NOT NULL DEFAULT 0
                      COMMENT 'Funds from delivered orders pending settlement maturity',
  `locked_paisa`      BIGINT NOT NULL DEFAULT 0
                      COMMENT 'Funds held against open payout requests or disputes',
  `lifetime_earned_paisa`  BIGINT NOT NULL DEFAULT 0
                      COMMENT 'Cumulative gross earned (never decremented)',
  `lifetime_commission_paisa` BIGINT NOT NULL DEFAULT 0
                      COMMENT 'Cumulative commission charged (never decremented)',
  `updated_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`vendor_id`),
  CONSTRAINT `fk_vendor_wallets_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Immutable Dual-Entry Vendor Ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_ledger_entries` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id`       BIGINT UNSIGNED NOT NULL,
  `entry_type`      VARCHAR(48) NOT NULL
                    COMMENT 'credit_earning|debit_payout|debit_refund|credit_refund_reversal|debit_commission_adj|credit_adjustment|debit_adjustment|maturity_move',
  `direction`       ENUM('credit','debit') NOT NULL,
  `amount_paisa`    BIGINT NOT NULL
                    COMMENT 'Always positive. Direction encodes sign.',
  `balance_after_paisa` BIGINT NOT NULL
                    COMMENT 'Available balance snapshot after this entry — denormalized for audit trail.',
  `reference_type`  VARCHAR(48) NOT NULL DEFAULT ''
                    COMMENT 'vendor_order|payout_request|refund|adjustment|settlement_batch',
  `reference_id`    BIGINT UNSIGNED DEFAULT NULL,
  `note`            VARCHAR(500) NOT NULL DEFAULT '',
  `created_by_type` VARCHAR(32) NOT NULL DEFAULT 'system'
                    COMMENT 'system|admin|vendor',
  `created_by_id`   BIGINT UNSIGNED DEFAULT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ledger_vendor_created`    (`vendor_id`, `created_at`),
  KEY `idx_ledger_reference`         (`reference_type`, `reference_id`),
  KEY `idx_ledger_entry_type`        (`entry_type`, `created_at`),
  CONSTRAINT `fk_vendor_ledger_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- After-insert trigger to prevent mutation of posted ledger rows
-- (DDL triggers are not portable to all MySQL versions; enforced at application layer instead)

-- ---------------------------------------------------------------------------
-- 5. Payout Requests (vendor withdrawal requests)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_payout_requests` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id`            BIGINT UNSIGNED NOT NULL,
  `requested_paisa`      BIGINT NOT NULL
                         COMMENT 'Amount the vendor requested',
  `approved_paisa`       BIGINT DEFAULT NULL
                         COMMENT 'Admin may approve a different (lower) amount',
  `method`               VARCHAR(48) NOT NULL
                         COMMENT 'bkash|nagad|rocket|bank_transfer|cod_adjustment',
  `account_number`       VARCHAR(100) NOT NULL,
  `account_name`         VARCHAR(191) NOT NULL DEFAULT '',
  `bank_name`            VARCHAR(191) NOT NULL DEFAULT '',
  `branch_name`          VARCHAR(191) NOT NULL DEFAULT '',
  `routing_number`       VARCHAR(64) NOT NULL DEFAULT '',
  `status`               VARCHAR(24) NOT NULL DEFAULT 'pending'
                         COMMENT 'pending|under_review|approved|rejected|paid|cancelled',
  `admin_note`           VARCHAR(1000) NOT NULL DEFAULT '',
  `transaction_ref`      VARCHAR(255) NOT NULL DEFAULT ''
                         COMMENT 'Gateway TrxID or bank reference after payment',
  `requested_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewed_by_user_id`  BIGINT UNSIGNED DEFAULT NULL,
  `reviewed_at`          DATETIME DEFAULT NULL,
  `paid_at`              DATETIME DEFAULT NULL,
  `ledger_entry_id`      BIGINT UNSIGNED DEFAULT NULL
                         COMMENT 'Links to vendor_ledger_entries row created on approval',
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_payout_vendor_status`     (`vendor_id`, `status`, `requested_at`),
  KEY `idx_payout_status_created`    (`status`, `created_at`),
  CONSTRAINT `fk_payout_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_payout_ledger_entry`
    FOREIGN KEY (`ledger_entry_id`) REFERENCES `vendor_ledger_entries` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. Gateway Config Table (extends existing payment_gateways with credentials)
-- ---------------------------------------------------------------------------
ALTER TABLE `payment_gateways`
  ADD COLUMN IF NOT EXISTS `config_json` LONGTEXT DEFAULT NULL
    COMMENT 'Encrypted gateway credentials (app_key, secret_key, merchant_id, etc.)',
  ADD COLUMN IF NOT EXISTS `webhook_secret` VARCHAR(255) NOT NULL DEFAULT ''
    COMMENT 'HMAC secret for validating inbound webhook callbacks',
  ADD COLUMN IF NOT EXISTS `gateway_fee_bps` INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Gateway deduction in basis points applied to vendor earnings',
  ADD COLUMN IF NOT EXISTS `gateway_type` VARCHAR(24) NOT NULL DEFAULT 'auto'
    COMMENT 'auto|manual — duplicates legacy `type` column; kept for backward compat';

-- ---------------------------------------------------------------------------
-- 7. Seed: global default commission rule (10% = 1000 bps)
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO `commission_rules`
  (`scope`, `vendor_id`, `category_id`, `rule_type`, `rate_bps`, `flat_paisa`, `min_paisa`, `max_paisa`, `priority`, `active`)
VALUES
  ('global', NULL, NULL, 'percent', 1000, 0, 100, NULL, 100, 1);

-- ---------------------------------------------------------------------------
-- 9. Seed: initialise wallet rows for all existing approved vendors
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO `vendor_wallets` (`vendor_id`)
SELECT `id` FROM `vendors` WHERE `lifecycle_status` = 'active';

-- ---------------------------------------------------------------------------
-- 10. RBAC permissions for new features
-- ---------------------------------------------------------------------------
INSERT INTO `permissions` (`name`, `module`, `description`) VALUES
  ('vendor_orders.view',         'vendor',  'View vendor sub-orders on the admin panel'),
  ('vendor_orders.update',       'vendor',  'Update vendor sub-order status'),
  ('vendor_payouts.view',        'finance', 'View vendor payout requests'),
  ('vendor_payouts.approve',     'finance', 'Approve or reject vendor payout requests'),
  ('vendor_payouts.mark_paid',   'finance', 'Mark a payout as paid after bank transfer'),
  ('commission_rules.manage',    'finance', 'Create and edit commission rules'),
  ('payment_gateways.manage',    'finance', 'Configure payment gateway credentials'),
  ('payment_transactions.view',  'finance', 'View payment transaction log')
ON DUPLICATE KEY UPDATE `description` = VALUES(`description`);
