-- ============================================================================
-- Migration 0003 (UP): Customers, Orders, OTP, Payments, Couriers, CMS, POS, HRM & Finance
-- All monetary values stored as BIGINT integer paisa (1 BDT = 100 paisa).
-- ============================================================================

CREATE TABLE IF NOT EXISTS `customers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL DEFAULT '',
  `address` TEXT DEFAULT NULL,
  `district` VARCHAR(80) NOT NULL DEFAULT '',
  `is_wholesale` TINYINT(1) NOT NULL DEFAULT 0,
  `total_orders` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_blocked` TINYINT(1) NOT NULL DEFAULT 0,
  `last_ip` VARCHAR(64) NOT NULL DEFAULT '',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customers_phone` (`phone`),
  KEY `idx_customers_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_addresses` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `label` VARCHAR(64) NOT NULL DEFAULT 'Home',
  `recipient_name` VARCHAR(191) NOT NULL,
  `recipient_phone` VARCHAR(32) NOT NULL,
  `division` VARCHAR(80) NOT NULL DEFAULT '',
  `district` VARCHAR(80) NOT NULL DEFAULT '',
  `upazila` VARCHAR(80) NOT NULL DEFAULT '',
  `street_address` TEXT NOT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customer_addresses_cust` (`customer_id`),
  CONSTRAINT `fk_customer_addresses_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `password_resets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_type` VARCHAR(32) NOT NULL DEFAULT 'customer',
  `identifier` VARCHAR(191) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `used_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_password_resets_token` (`token_hash`),
  KEY `idx_password_resets_ident` (`actor_type`, `identifier`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `delivery_locations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `division` VARCHAR(80) NOT NULL,
  `district` VARCHAR(80) NOT NULL,
  `upazila` VARCHAR(80) NOT NULL DEFAULT '',
  `delivery_charge_paisa` BIGINT NOT NULL DEFAULT 12000,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_delivery_locations_div_dist` (`division`, `district`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `delivery_boys` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `area` VARCHAR(120) NOT NULL DEFAULT '',
  `vehicle_type` VARCHAR(64) NOT NULL DEFAULT 'Bike',
  `commission_per_order_paisa` BIGINT NOT NULL DEFAULT 3000,
  `balance_paisa` BIGINT NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_boys_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `delivery_withdrawals` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `delivery_boy_id` BIGINT UNSIGNED NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `method` VARCHAR(64) NOT NULL,
  `account_number` VARCHAR(100) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_delivery_withdrawals_rider` (`delivery_boy_id`, `status`),
  CONSTRAINT `fk_delivery_withdrawals_rider` FOREIGN KEY (`delivery_boy_id`) REFERENCES `delivery_boys` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `coupons` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(64) NOT NULL,
  `discount_type` VARCHAR(24) NOT NULL DEFAULT 'percent',
  `discount_value` BIGINT NOT NULL DEFAULT 0,
  `min_purchase_paisa` BIGINT NOT NULL DEFAULT 0,
  `max_discount_paisa` BIGINT DEFAULT NULL,
  `usage_limit` INT UNSIGNED DEFAULT NULL,
  `used_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `expires_at` DATETIME DEFAULT NULL,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coupons_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_statuses` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(80) NOT NULL,
  `slug` VARCHAR(80) NOT NULL,
  `badge_class` VARCHAR(40) NOT NULL DEFAULT 'sb-1',
  `color` VARCHAR(24) NOT NULL DEFAULT '#f59e0b',
  `sort_order` INT NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order_statuses_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `invoice_no` VARCHAR(40) NOT NULL,
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `customer_id` BIGINT UNSIGNED DEFAULT NULL,
  `reseller_id` BIGINT UNSIGNED DEFAULT NULL,
  `delivery_boy_id` BIGINT UNSIGNED DEFAULT NULL,
  `customer_name` VARCHAR(191) NOT NULL,
  `customer_phone` VARCHAR(32) NOT NULL,
  `shipping_address` TEXT NOT NULL,
  `division` VARCHAR(80) NOT NULL DEFAULT '',
  `district` VARCHAR(80) NOT NULL DEFAULT '',
  `upazila` VARCHAR(80) NOT NULL DEFAULT '',
  `shipping_zone` VARCHAR(80) NOT NULL DEFAULT 'Inside Dhaka',
  `subtotal_paisa` BIGINT NOT NULL DEFAULT 0,
  `discount_paisa` BIGINT NOT NULL DEFAULT 0,
  `shipping_paisa` BIGINT NOT NULL DEFAULT 0,
  `total_paisa` BIGINT NOT NULL DEFAULT 0,
  `advance_required_paisa` BIGINT NOT NULL DEFAULT 0,
  `paid_paisa` BIGINT NOT NULL DEFAULT 0,
  `cod_due_paisa` BIGINT NOT NULL DEFAULT 0,
  `reseller_margin_paisa` BIGINT NOT NULL DEFAULT 0,
  `coupon_code` VARCHAR(64) NOT NULL DEFAULT '',
  `payment_method` VARCHAR(40) NOT NULL DEFAULT 'cod',
  `payment_status` VARCHAR(32) NOT NULL DEFAULT 'unpaid',
  `otp_status` VARCHAR(24) NOT NULL DEFAULT 'not_required',
  `order_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `order_channel` VARCHAR(32) NOT NULL DEFAULT 'storefront',
  `traffic_source` VARCHAR(64) NOT NULL DEFAULT 'Direct',
  `utm_source` VARCHAR(100) NOT NULL DEFAULT '',
  `utm_medium` VARCHAR(100) NOT NULL DEFAULT '',
  `utm_campaign` VARCHAR(150) NOT NULL DEFAULT '',
  `courier_code` VARCHAR(32) NOT NULL DEFAULT '',
  `courier_tracking_id` VARCHAR(100) NOT NULL DEFAULT '',
  `client_ip` VARCHAR(64) NOT NULL DEFAULT '',
  `customer_note` TEXT DEFAULT NULL,
  `admin_note` TEXT DEFAULT NULL,
  `consent_accepted_at` DATETIME DEFAULT NULL,
  `is_seen` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orders_invoice_no` (`invoice_no`),
  UNIQUE KEY `uq_orders_idempotency` (`idempotency_key`),
  KEY `idx_orders_status_created` (`order_status`, `created_at`),
  KEY `idx_orders_phone_created` (`customer_phone`, `created_at`),
  KEY `idx_orders_traffic` (`traffic_source`, `created_at`),
  CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_delivery_boy` FOREIGN KEY (`delivery_boy_id`) REFERENCES `delivery_boys` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `variant_id` BIGINT UNSIGNED DEFAULT NULL,
  `vendor_id` BIGINT UNSIGNED DEFAULT NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `product_image` VARCHAR(500) NOT NULL DEFAULT '',
  `unit_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `qty` INT UNSIGNED NOT NULL DEFAULT 1,
  `line_total_paisa` BIGINT NOT NULL DEFAULT 0,
  `size_label` VARCHAR(80) NOT NULL DEFAULT '',
  `color_label` VARCHAR(80) NOT NULL DEFAULT '',
  `gift_note` VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_order_items_order` (`order_id`),
  KEY `idx_order_items_vendor` (`vendor_id`),
  CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_order_items_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_order_items_variant` FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_order_items_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_status_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `from_status` VARCHAR(32) NOT NULL DEFAULT '',
  `to_status` VARCHAR(32) NOT NULL,
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `changed_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_order_status_hist_order` (`order_id`, `created_at`),
  CONSTRAINT `fk_order_status_hist_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_order_status_hist_user` FOREIGN KEY (`changed_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_otps` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone` VARCHAR(32) NOT NULL,
  `order_id` BIGINT UNSIGNED DEFAULT NULL,
  `otp_hash` CHAR(64) NOT NULL,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 5,
  `expires_at` DATETIME NOT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_order_otps_phone_exp` (`phone`, `expires_at`),
  CONSTRAINT `fk_order_otps_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `payment_gateways` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `code` VARCHAR(48) NOT NULL,
  `gateway_type` VARCHAR(24) NOT NULL DEFAULT 'auto',
  `account_number` VARCHAR(100) NOT NULL DEFAULT '',
  `instructions` TEXT DEFAULT NULL,
  `sandbox` TINYINT(1) NOT NULL DEFAULT 1,
  `status` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payment_gateways_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `order_payments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `gateway_code` VARCHAR(48) NOT NULL,
  `provider_trx_id` VARCHAR(128) DEFAULT NULL,
  `sender_number` VARCHAR(32) NOT NULL DEFAULT '',
  `amount_paisa` BIGINT NOT NULL,
  `payment_purpose` VARCHAR(32) NOT NULL DEFAULT 'full',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `verified_at` DATETIME DEFAULT NULL,
  `verified_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `raw_meta_json` LONGTEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order_payments_gateway_trx` (`gateway_code`, `provider_trx_id`),
  KEY `idx_order_payments_order_status` (`order_id`, `status`),
  CONSTRAINT `fk_order_payments_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_order_payments_user` FOREIGN KEY (`verified_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `refunds` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `invoice_no` VARCHAR(40) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `reason` VARCHAR(255) NOT NULL DEFAULT '',
  `method` VARCHAR(48) NOT NULL DEFAULT 'bKash',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `processed_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_refunds_status` (`status`, `created_at`),
  CONSTRAINT `fk_refunds_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_refunds_user` FOREIGN KEY (`processed_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `incomplete_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_sid` VARCHAR(128) NOT NULL DEFAULT '',
  `customer_name` VARCHAR(191) NOT NULL DEFAULT '',
  `phone` VARCHAR(32) NOT NULL,
  `address` TEXT DEFAULT NULL,
  `cart_json` LONGTEXT DEFAULT NULL,
  `estimated_amount_paisa` BIGINT NOT NULL DEFAULT 0,
  `consent_given` TINYINT(1) NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'abandoned',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_incomplete_orders_phone_status` (`phone`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `courier_apis` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `code` VARCHAR(48) NOT NULL,
  `base_url` VARCHAR(255) NOT NULL DEFAULT '',
  `balance_paisa` BIGINT NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_courier_apis_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `courier_shipments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT UNSIGNED NOT NULL,
  `courier_code` VARCHAR(48) NOT NULL,
  `consignment_id` VARCHAR(120) NOT NULL,
  `tracking_code` VARCHAR(120) NOT NULL DEFAULT '',
  `cod_amount_paisa` BIGINT NOT NULL DEFAULT 0,
  `delivery_fee_paisa` BIGINT NOT NULL DEFAULT 0,
  `courier_status` VARCHAR(64) NOT NULL DEFAULT 'in_review',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `settled_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_courier_consignment` (`courier_code`, `consignment_id`),
  KEY `idx_courier_shipments_order` (`order_id`, `is_active`),
  CONSTRAINT `fk_courier_shipments_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `courier_webhook_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `courier_code` VARCHAR(48) NOT NULL,
  `event_id` VARCHAR(128) DEFAULT NULL,
  `signature_valid` TINYINT(1) NOT NULL DEFAULT 0,
  `payload_json` LONGTEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_courier_webhooks_code_created` (`courier_code`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `fraud_checks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone` VARCHAR(32) NOT NULL,
  `provider_code` VARCHAR(48) NOT NULL DEFAULT 'bdcourier',
  `total_parcels` INT UNSIGNED NOT NULL DEFAULT 0,
  `delivered_parcels` INT UNSIGNED NOT NULL DEFAULT 0,
  `cancelled_parcels` INT UNSIGNED NOT NULL DEFAULT 0,
  `success_rate_bps` INT UNSIGNED NOT NULL DEFAULT 0,
  `risk_level` VARCHAR(24) NOT NULL DEFAULT 'unknown',
  `response_json` LONGTEXT DEFAULT NULL,
  `checked_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fraud_checks_phone_checked` (`phone`, `checked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `campaigns` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `theme_key` VARCHAR(64) NOT NULL DEFAULT 'grocery_combo',
  `product_id` BIGINT UNSIGNED DEFAULT NULL,
  `headline` VARCHAR(255) NOT NULL DEFAULT '',
  `subheadline` TEXT DEFAULT NULL,
  `banner_image` VARCHAR(500) NOT NULL DEFAULT '',
  `offer_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `regular_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `benefits_json` LONGTEXT DEFAULT NULL,
  `publish_state` VARCHAR(24) NOT NULL DEFAULT 'draft',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_campaigns_slug` (`slug`),
  CONSTRAINT `fk_campaigns_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `banners` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(191) NOT NULL DEFAULT '',
  `subtitle` VARCHAR(255) NOT NULL DEFAULT '',
  `position` VARCHAR(48) NOT NULL DEFAULT 'hero',
  `image_url` VARCHAR(500) NOT NULL,
  `link_url` VARCHAR(500) NOT NULL DEFAULT '#',
  `sort_order` INT NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_banners_pos_status` (`position`, `status`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `reviews` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED DEFAULT NULL,
  `customer_name` VARCHAR(191) NOT NULL,
  `rating` TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `comment` TEXT DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_reviews_prod_status` (`product_id`, `status`),
  CONSTRAINT `fk_reviews_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reviews_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `blogs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `category` VARCHAR(100) NOT NULL DEFAULT '',
  `image_url` VARCHAR(500) NOT NULL DEFAULT '',
  `excerpt` TEXT DEFAULT NULL,
  `content` LONGTEXT DEFAULT NULL,
  `author` VARCHAR(120) NOT NULL DEFAULT 'Mr. Tumi Editorial',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_blogs_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_pages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title_bn` VARCHAR(255) NOT NULL,
  `title_en` VARCHAR(255) NOT NULL DEFAULT '',
  `slug` VARCHAR(191) NOT NULL,
  `content_bn` LONGTEXT DEFAULT NULL,
  `content_en` LONGTEXT DEFAULT NULL,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_pages_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `features` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title_bn` VARCHAR(191) NOT NULL,
  `title_en` VARCHAR(191) NOT NULL DEFAULT '',
  `subtitle_bn` VARCHAR(255) NOT NULL DEFAULT '',
  `subtitle_en` VARCHAR(255) NOT NULL DEFAULT '',
  `icon` VARCHAR(80) NOT NULL DEFAULT 'check-circle',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `social_links` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `platform` VARCHAR(64) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `icon` VARCHAR(64) NOT NULL DEFAULT 'globe',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `complaints` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `invoice_no` VARCHAR(40) NOT NULL DEFAULT '',
  `details` TEXT NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `admin_reply` TEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_complaints_status` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `contact_messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(32) NOT NULL DEFAULT '',
  `email` VARCHAR(191) NOT NULL DEFAULT '',
  `subject` VARCHAR(255) NOT NULL DEFAULT '',
  `message` TEXT NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'unread',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `newsletter_subscribers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email_or_phone` VARCHAR(191) NOT NULL,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_newsletter_sub` (`email_or_phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sms_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `recipient_masked` VARCHAR(32) NOT NULL,
  `template_key` VARCHAR(64) NOT NULL DEFAULT 'custom',
  `message_preview` VARCHAR(255) NOT NULL DEFAULT '',
  `gateway_code` VARCHAR(48) NOT NULL DEFAULT 'bulksmsbd',
  `provider_message_id` VARCHAR(100) DEFAULT NULL,
  `delivery_status` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sms_logs_status_created` (`delivery_status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notification_queue` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `channel` VARCHAR(24) NOT NULL DEFAULT 'sms',
  `recipient` VARCHAR(191) NOT NULL,
  `payload_json` LONGTEXT NOT NULL,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 3,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `next_attempt_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_error` VARCHAR(255) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notification_queue_poll` (`status`, `next_attempt_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `visitor_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_sid` VARCHAR(128) NOT NULL DEFAULT '',
  `event_name` VARCHAR(64) NOT NULL,
  `event_id` VARCHAR(100) NOT NULL,
  `platform_source` VARCHAR(64) NOT NULL DEFAULT 'Direct',
  `utm_source` VARCHAR(100) NOT NULL DEFAULT '',
  `utm_medium` VARCHAR(100) NOT NULL DEFAULT '',
  `utm_campaign` VARCHAR(150) NOT NULL DEFAULT '',
  `page_path` VARCHAR(255) NOT NULL DEFAULT '/',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_visitor_events_event_id` (`event_id`),
  KEY `idx_visitor_events_source_created` (`platform_source`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_shifts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `cashier_user_id` BIGINT UNSIGNED NOT NULL,
  `opening_cash_paisa` BIGINT NOT NULL DEFAULT 0,
  `closing_cash_paisa` BIGINT DEFAULT NULL,
  `expected_cash_paisa` BIGINT DEFAULT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'open',
  `opened_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closed_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pos_shifts_cashier_status` (`cashier_user_id`, `status`),
  CONSTRAINT `fk_pos_shifts_user` FOREIGN KEY (`cashier_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `hrm_departments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hrm_departments_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `employees` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `department_id` BIGINT UNSIGNED DEFAULT NULL,
  `name` VARCHAR(191) NOT NULL,
  `designation` VARCHAR(120) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT NULL,
  `base_salary_paisa` BIGINT NOT NULL DEFAULT 0,
  `join_date` DATE NOT NULL,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_employees_phone` (`phone`),
  CONSTRAINT `fk_employees_dept` FOREIGN KEY (`department_id`) REFERENCES `hrm_departments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `attendances` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `att_date` DATE NOT NULL,
  `check_in` VARCHAR(16) NOT NULL DEFAULT '',
  `check_out` VARCHAR(16) NOT NULL DEFAULT '',
  `status` VARCHAR(24) NOT NULL DEFAULT 'present',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_attendances_emp_date` (`employee_id`, `att_date`),
  CONSTRAINT `fk_attendances_employee` FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `leaves` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `leave_type` VARCHAR(48) NOT NULL DEFAULT 'casual',
  `from_date` DATE NOT NULL,
  `to_date` DATE NOT NULL,
  `reason` VARCHAR(255) NOT NULL DEFAULT '',
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `approved_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_leaves_employee` FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_leaves_user` FOREIGN KEY (`approved_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `salaries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `salary_month` VARCHAR(16) NOT NULL,
  `basic_paisa` BIGINT NOT NULL DEFAULT 0,
  `bonus_paisa` BIGINT NOT NULL DEFAULT 0,
  `deduction_paisa` BIGINT NOT NULL DEFAULT 0,
  `net_salary_paisa` BIGINT NOT NULL DEFAULT 0,
  `status` VARCHAR(24) NOT NULL DEFAULT 'draft',
  `approved_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `paid_date` DATE DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_salaries_emp_month` (`employee_id`, `salary_month`),
  CONSTRAINT `fk_salaries_employee` FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_salaries_user` FOREIGN KEY (`approved_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bonuses` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `amount_paisa` BIGINT NOT NULL DEFAULT 0,
  `bonus_date` DATE NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_bonuses_employee` FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `fund_transactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `account_name` VARCHAR(100) NOT NULL,
  `tx_type` VARCHAR(24) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `tx_date` DATE NOT NULL,
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fund_tx_date` (`tx_date`, `tx_type`),
  CONSTRAINT `fk_fund_tx_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `expenses` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(191) NOT NULL,
  `category` VARCHAR(100) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `expense_date` DATE NOT NULL,
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_expenses_date_cat` (`expense_date`, `category`),
  CONSTRAINT `fk_expenses_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
