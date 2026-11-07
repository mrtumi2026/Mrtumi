-- ============================================================================
-- Migration 0018 (UP): Logistics, Courier Shipments, and Query Optimizations
-- Target: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- All monetary amounts: BIGINT paisa (৳1.00 = 100 paisa)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Create courier_shipments Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `courier_shipments` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`           BIGINT UNSIGNED NOT NULL
                       COMMENT 'Parent order ID',
  `vendor_order_id`    BIGINT UNSIGNED DEFAULT NULL
                       COMMENT 'Vendor sub-order ID (if shipped independently by vendor)',
  `courier_provider`   VARCHAR(32) NOT NULL
                       COMMENT 'steadfast | pathao | redx | internal_rider',
  `consignment_id`     VARCHAR(100) NOT NULL DEFAULT ''
                       COMMENT 'Unique ID assigned by courier API',
  `tracking_code`      VARCHAR(100) NOT NULL DEFAULT ''
                       COMMENT 'Public tracking identifier for customer',
  `status`             VARCHAR(48) NOT NULL DEFAULT 'in_review'
                       COMMENT 'in_review|pending|picked|in_transit|delivered|partial_delivered|cancelled|hold|returned',
  `delivery_fee_paisa` BIGINT NOT NULL DEFAULT 0
                       COMMENT 'Actual delivery charge invoiced by courier',
  `cod_amount_paisa`   BIGINT NOT NULL DEFAULT 0
                       COMMENT 'Amount courier must collect upon doorstep handover',
  `label_url`          VARCHAR(500) NOT NULL DEFAULT ''
                       COMMENT 'URL or base64 PDF of printable shipping airway bill',
  `recipient_name`     VARCHAR(191) NOT NULL DEFAULT '',
  `recipient_phone`    VARCHAR(32) NOT NULL DEFAULT '',
  `recipient_address`  TEXT NOT NULL,
  `recipient_district` VARCHAR(80) NOT NULL DEFAULT '',
  `recipient_city_id`  INT UNSIGNED DEFAULT NULL,
  `recipient_zone_id`  INT UNSIGNED DEFAULT NULL,
  `recipient_area_id`  INT UNSIGNED DEFAULT NULL,
  `raw_response`       LONGTEXT DEFAULT NULL
                       COMMENT 'Raw JSON payload returned by courier order creation API',
  `raw_webhook`        LONGTEXT DEFAULT NULL
                       COMMENT 'Latest webhook status payload received from courier',
  `dispatched_at`      DATETIME DEFAULT NULL,
  `delivered_at`       DATETIME DEFAULT NULL,
  `cancelled_at`       DATETIME DEFAULT NULL,
  `created_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_shipments_order`            (`order_id`),
  KEY `idx_shipments_vendor_order`     (`vendor_order_id`),
  KEY `idx_shipments_consignment`      (`consignment_id`),
  KEY `idx_shipments_tracking`         (`tracking_code`),
  KEY `idx_shipments_provider_status`  (`courier_provider`, `status`, `created_at`),
  CONSTRAINT `fk_shipments_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_shipments_vendor_order`
    FOREIGN KEY (`vendor_order_id`) REFERENCES `vendor_orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Performance Indexes (High Concurrency & Flash Sale Optimizations)
-- ---------------------------------------------------------------------------
ALTER TABLE `products`
  ADD KEY IF NOT EXISTS `idx_products_vendor_status_created` (`vendor_id`, `status`, `created_at`),
  ADD KEY IF NOT EXISTS `idx_products_category_status`       (`category_id`, `status`, `is_archived`);

ALTER TABLE `orders`
  ADD KEY IF NOT EXISTS `idx_orders_customer_phone_created`  (`customer_phone`, `created_at`),
  ADD KEY IF NOT EXISTS `idx_orders_payment_order_status`    (`payment_status`, `order_status`);

ALTER TABLE `vendor_orders`
  ADD KEY IF NOT EXISTS `idx_vendor_orders_status_credited`  (`status`, `ledger_credited`),
  ADD KEY IF NOT EXISTS `idx_vendor_orders_created_status`   (`created_at`, `status`);
