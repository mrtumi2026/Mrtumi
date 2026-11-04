DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.id=rp.permission_id WHERE p.name='test_data.manage';
DELETE FROM `permissions` WHERE `name`='test_data.manage';
ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_test_data_group`, DROP KEY `idx_orders_test_data_group`, DROP COLUMN `test_data_group_id`;
ALTER TABLE `products` DROP FOREIGN KEY `fk_products_test_data_group`, DROP KEY `idx_products_test_data_group`, DROP COLUMN `test_data_group_id`;
ALTER TABLE `vendors` DROP FOREIGN KEY `fk_vendors_test_data_group`, DROP KEY `idx_vendors_test_data_group`, DROP COLUMN `test_data_group_id`;
ALTER TABLE `customers` DROP FOREIGN KEY `fk_customers_test_data_group`, DROP KEY `idx_customers_test_data_group`, DROP COLUMN `test_data_group_id`;
ALTER TABLE `categories` DROP FOREIGN KEY `fk_categories_test_data_group`, DROP KEY `idx_categories_test_data_group`, DROP COLUMN `test_data_group_id`;
DROP TABLE IF EXISTS `test_data_cleanup_runs`;
DROP TABLE IF EXISTS `test_data_groups`;
