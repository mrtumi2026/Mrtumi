-- ============================================================================
-- Migration 0002 (UP): Catalogue, Stock Ledger, Purchases & Partner Portals
-- All monetary values stored as BIGINT integer paisa (1 BDT = 100 paisa).
-- ============================================================================

CREATE TABLE IF NOT EXISTS `categories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name_bn` VARCHAR(191) NOT NULL,
  `name_en` VARCHAR(191) NOT NULL DEFAULT '',
  `slug` VARCHAR(191) NOT NULL,
  `icon` VARCHAR(120) NOT NULL DEFAULT '',
  `image_url` VARCHAR(500) NOT NULL DEFAULT '',
  `front_view` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_categories_slug` (`slug`),
  KEY `idx_categories_status_sort` (`status`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `subcategories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_id` BIGINT UNSIGNED NOT NULL,
  `name_bn` VARCHAR(191) NOT NULL,
  `name_en` VARCHAR(191) NOT NULL DEFAULT '',
  `slug` VARCHAR(191) NOT NULL,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_subcategories_slug` (`slug`),
  KEY `idx_subcategories_cat` (`category_id`, `status`),
  CONSTRAINT `fk_subcategories_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `childcategories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `subcategory_id` BIGINT UNSIGNED NOT NULL,
  `name_bn` VARCHAR(191) NOT NULL,
  `name_en` VARCHAR(191) NOT NULL DEFAULT '',
  `slug` VARCHAR(191) NOT NULL,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_childcategories_slug` (`slug`),
  KEY `idx_childcategories_subcat` (`subcategory_id`, `status`),
  CONSTRAINT `fk_childcategories_subcategory` FOREIGN KEY (`subcategory_id`) REFERENCES `subcategories` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `brands` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name_bn` VARCHAR(191) NOT NULL,
  `name_en` VARCHAR(191) NOT NULL DEFAULT '',
  `slug` VARCHAR(191) NOT NULL,
  `logo_url` VARCHAR(500) NOT NULL DEFAULT '',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_brands_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `colors` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name_bn` VARCHAR(100) NOT NULL,
  `name_en` VARCHAR(100) NOT NULL DEFAULT '',
  `hex_code` VARCHAR(16) NOT NULL DEFAULT '#16a34a',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sizes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name_bn` VARCHAR(100) NOT NULL,
  `name_en` VARCHAR(100) NOT NULL DEFAULT '',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendors` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_name` VARCHAR(191) NOT NULL,
  `owner_name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT NULL,
  `address` TEXT DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `commission_rate_bps` INT UNSIGNED NOT NULL DEFAULT 1000,
  `balance_paisa` BIGINT NOT NULL DEFAULT 0,
  `verified` TINYINT(1) NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendors_phone` (`phone`),
  KEY `idx_vendors_verified_status` (`verified`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_withdrawals` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `vendor_id` BIGINT UNSIGNED NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `method` VARCHAR(64) NOT NULL,
  `account_number` VARCHAR(100) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `processed_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_withdrawals_vendor_status` (`vendor_id`, `status`),
  CONSTRAINT `fk_vendor_withdrawals_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_vendor_withdrawals_user` FOREIGN KEY (`processed_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `resellers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `shop_name` VARCHAR(191) NOT NULL DEFAULT '',
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `balance_paisa` BIGINT NOT NULL DEFAULT 0,
  `deposit_paisa` BIGINT NOT NULL DEFAULT 0,
  `verified` TINYINT(1) NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_resellers_phone` (`phone`),
  KEY `idx_resellers_verified_status` (`verified`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `reseller_transactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reseller_id` BIGINT UNSIGNED NOT NULL,
  `tx_type` VARCHAR(40) NOT NULL,
  `amount_paisa` BIGINT NOT NULL,
  `method` VARCHAR(64) NOT NULL DEFAULT '',
  `trx_id` VARCHAR(120) DEFAULT NULL,
  `reference_order_id` BIGINT UNSIGNED DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_reseller_tx_reseller_status` (`reseller_id`, `status`),
  CONSTRAINT `fk_reseller_tx_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sku` VARCHAR(64) NOT NULL,
  `barcode` VARCHAR(64) DEFAULT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `name_bn` VARCHAR(255) NOT NULL,
  `name_en` VARCHAR(255) NOT NULL DEFAULT '',
  `category_id` BIGINT UNSIGNED DEFAULT NULL,
  `subcategory_id` BIGINT UNSIGNED DEFAULT NULL,
  `childcategory_id` BIGINT UNSIGNED DEFAULT NULL,
  `brand_id` BIGINT UNSIGNED DEFAULT NULL,
  `vendor_id` BIGINT UNSIGNED DEFAULT NULL,
  `regular_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `sale_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `cost_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `wholesale_price_paisa` BIGINT NOT NULL DEFAULT 0,
  `wholesale_min_qty` INT UNSIGNED NOT NULL DEFAULT 10,
  `stock_on_hand` INT NOT NULL DEFAULT 0,
  `stock_reserved` INT NOT NULL DEFAULT 0,
  `vendor_stock_on_hand` INT NOT NULL DEFAULT 0,
  `vendor_stock_reserved` INT NOT NULL DEFAULT 0,
  `low_stock_threshold` INT UNSIGNED NOT NULL DEFAULT 10,
  `sold_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `unit_label` VARCHAR(50) NOT NULL DEFAULT '1 pc',
  `image_url` VARCHAR(500) NOT NULL DEFAULT '',
  `gallery_json` LONGTEXT DEFAULT NULL,
  `short_desc_bn` TEXT DEFAULT NULL,
  `short_desc_en` TEXT DEFAULT NULL,
  `description_bn` LONGTEXT DEFAULT NULL,
  `description_en` LONGTEXT DEFAULT NULL,
  `is_flash_sale` TINYINT(1) NOT NULL DEFAULT 0,
  `is_hot_deal` TINYINT(1) NOT NULL DEFAULT 0,
  `is_wholesale` TINYINT(1) NOT NULL DEFAULT 0,
  `is_gift_eligible` TINYINT(1) NOT NULL DEFAULT 0,
  `approval_status` VARCHAR(32) NOT NULL DEFAULT 'approved',
  `is_archived` TINYINT(1) NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_products_sku` (`sku`),
  UNIQUE KEY `uq_products_slug` (`slug`),
  KEY `idx_products_barcode` (`barcode`),
  KEY `idx_products_cat_status` (`category_id`, `status`, `is_archived`),
  KEY `idx_products_vendor_approval` (`vendor_id`, `approval_status`),
  CONSTRAINT `fk_products_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_subcategory` FOREIGN KEY (`subcategory_id`) REFERENCES `subcategories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_childcategory` FOREIGN KEY (`childcategory_id`) REFERENCES `childcategories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_brand` FOREIGN KEY (`brand_id`) REFERENCES `brands` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `product_variants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `variant_sku` VARCHAR(80) NOT NULL,
  `size_label` VARCHAR(80) NOT NULL DEFAULT '',
  `color_label` VARCHAR(80) NOT NULL DEFAULT '',
  `price_paisa` BIGINT NOT NULL DEFAULT 0,
  `stock_on_hand` INT NOT NULL DEFAULT 0,
  `stock_reserved` INT NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_variants_sku` (`variant_sku`),
  KEY `idx_product_variants_product` (`product_id`, `status`),
  CONSTRAINT `fk_product_variants_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `suppliers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `company` VARCHAR(191) NOT NULL DEFAULT '',
  `phone` VARCHAR(32) NOT NULL,
  `address` TEXT DEFAULT NULL,
  `balance_due_paisa` BIGINT NOT NULL DEFAULT 0,
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_suppliers_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `purchases` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reference_no` VARCHAR(64) NOT NULL,
  `supplier_id` BIGINT UNSIGNED NOT NULL,
  `total_cost_paisa` BIGINT NOT NULL DEFAULT 0,
  `paid_amount_paisa` BIGINT NOT NULL DEFAULT 0,
  `receive_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `purchase_date` DATE NOT NULL,
  `note` VARCHAR(255) NOT NULL DEFAULT '',
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchases_ref` (`reference_no`),
  KEY `idx_purchases_supplier_date` (`supplier_id`, `purchase_date`),
  CONSTRAINT `fk_purchases_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_purchases_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `purchase_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `purchase_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `ordered_qty` INT UNSIGNED NOT NULL,
  `received_qty` INT UNSIGNED NOT NULL DEFAULT 0,
  `unit_cost_paisa` BIGINT NOT NULL DEFAULT 0,
  `line_total_paisa` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_purchase_items_purchase` (`purchase_id`),
  CONSTRAINT `fk_purchase_items_purchase` FOREIGN KEY (`purchase_id`) REFERENCES `purchases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_purchase_items_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_ledger` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `variant_id` BIGINT UNSIGNED DEFAULT NULL,
  `stock_pool` VARCHAR(24) NOT NULL DEFAULT 'warehouse',
  `vendor_id` BIGINT UNSIGNED DEFAULT NULL,
  `movement_type` VARCHAR(40) NOT NULL,
  `qty_delta` INT NOT NULL,
  `balance_after` INT NOT NULL,
  `reference_type` VARCHAR(40) DEFAULT NULL,
  `reference_id` BIGINT UNSIGNED DEFAULT NULL,
  `reason` VARCHAR(255) NOT NULL DEFAULT '',
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_stock_ledger_product_created` (`product_id`, `created_at`),
  KEY `idx_stock_ledger_ref` (`reference_type`, `reference_id`),
  CONSTRAINT `fk_stock_ledger_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_stock_ledger_variant` FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_stock_ledger_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_stock_ledger_user` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_reservations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `variant_id` BIGINT UNSIGNED DEFAULT NULL,
  `stock_pool` VARCHAR(24) NOT NULL DEFAULT 'warehouse',
  `qty` INT UNSIGNED NOT NULL,
  `reservation_key` VARCHAR(128) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'active',
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stock_reservations_key_prod` (`reservation_key`, `product_id`),
  KEY `idx_stock_reservations_status_exp` (`status`, `expires_at`),
  CONSTRAINT `fk_stock_reservations_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `wholesale_applications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_name` VARCHAR(191) NOT NULL,
  `contact_name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT NULL,
  `trade_license_no` VARCHAR(100) NOT NULL DEFAULT '',
  `address` TEXT DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `reviewed_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wholesale_apps_status` (`status`),
  CONSTRAINT `fk_wholesale_apps_user` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
