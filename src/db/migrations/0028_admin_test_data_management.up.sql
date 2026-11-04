-- Explicit test-data provenance. Existing rows remain NULL and are never inferred from names.
CREATE TABLE IF NOT EXISTS `test_data_groups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_key` VARCHAR(64) NOT NULL,
  `label` VARCHAR(191) NOT NULL,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `source` VARCHAR(32) NOT NULL DEFAULT 'admin',
  `status` VARCHAR(24) NOT NULL DEFAULT 'active',
  `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `cleaned_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_test_data_group_key` (`group_key`),
  KEY `idx_test_data_group_status_created` (`status`,`created_at`),
  CONSTRAINT `fk_test_data_group_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `categories`
  ADD COLUMN `test_data_group_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD KEY `idx_categories_test_data_group` (`test_data_group_id`),
  ADD CONSTRAINT `fk_categories_test_data_group` FOREIGN KEY (`test_data_group_id`) REFERENCES `test_data_groups` (`id`) ON DELETE RESTRICT;
ALTER TABLE `customers`
  ADD COLUMN `test_data_group_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD KEY `idx_customers_test_data_group` (`test_data_group_id`),
  ADD CONSTRAINT `fk_customers_test_data_group` FOREIGN KEY (`test_data_group_id`) REFERENCES `test_data_groups` (`id`) ON DELETE RESTRICT;
ALTER TABLE `vendors`
  ADD COLUMN `test_data_group_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD KEY `idx_vendors_test_data_group` (`test_data_group_id`),
  ADD CONSTRAINT `fk_vendors_test_data_group` FOREIGN KEY (`test_data_group_id`) REFERENCES `test_data_groups` (`id`) ON DELETE RESTRICT;
ALTER TABLE `products`
  ADD COLUMN `test_data_group_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD KEY `idx_products_test_data_group` (`test_data_group_id`),
  ADD CONSTRAINT `fk_products_test_data_group` FOREIGN KEY (`test_data_group_id`) REFERENCES `test_data_groups` (`id`) ON DELETE RESTRICT;
ALTER TABLE `orders`
  ADD COLUMN `test_data_group_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD KEY `idx_orders_test_data_group` (`test_data_group_id`),
  ADD CONSTRAINT `fk_orders_test_data_group` FOREIGN KEY (`test_data_group_id`) REFERENCES `test_data_groups` (`id`) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS `test_data_cleanup_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_id` BIGINT UNSIGNED NOT NULL,
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `scope_json` LONGTEXT NOT NULL,
  `result` VARCHAR(24) NOT NULL,
  `detail` VARCHAR(1000) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_test_data_cleanup_group_created` (`group_id`,`created_at`),
  CONSTRAINT `fk_test_data_cleanup_group` FOREIGN KEY (`group_id`) REFERENCES `test_data_groups` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_test_data_cleanup_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `permissions` (`name`,`module`,`description`) VALUES
 ('test_data.manage','test_data','Identify, inspect and safely clean explicitly marked test data')
ON DUPLICATE KEY UPDATE `module`=VALUES(`module`),`description`=VALUES(`description`);
INSERT INTO `role_permissions` (`role_id`,`permission_id`)
SELECT r.id,p.id FROM `roles` r JOIN `permissions` p ON p.name='test_data.manage'
WHERE r.slug='admin'
ON DUPLICATE KEY UPDATE `permission_id`=VALUES(`permission_id`);
