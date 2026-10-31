DROP TABLE IF EXISTS `vendor_order_status_history`;
DROP TABLE IF EXISTS `vendor_order_item_history`;
DROP TABLE IF EXISTS `vendor_product_history`;
ALTER TABLE `order_items` DROP COLUMN `fulfillment_status`;
