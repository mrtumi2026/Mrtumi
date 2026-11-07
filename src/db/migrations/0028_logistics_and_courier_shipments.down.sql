-- ============================================================================
-- Migration 0018 (DOWN): Rollback courier shipments
-- ============================================================================
DROP TABLE IF EXISTS `courier_shipments`;

ALTER TABLE `products`
  DROP KEY IF EXISTS `idx_products_vendor_status_created`,
  DROP KEY IF EXISTS `idx_products_category_status`;

ALTER TABLE `orders`
  DROP KEY IF EXISTS `idx_orders_customer_phone_created`,
  DROP KEY IF EXISTS `idx_orders_payment_order_status`;

ALTER TABLE `vendor_orders`
  DROP KEY IF EXISTS `idx_vendor_orders_status_credited`,
  DROP KEY IF EXISTS `idx_vendor_orders_created_status`;
