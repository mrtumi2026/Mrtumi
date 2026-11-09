-- ============================================================================
-- Migration 0032 (DOWN): Rollback courier shipments
-- ============================================================================
DROP TABLE IF EXISTS `courier_shipments`;

ALTER TABLE `products`
  DROP KEY `idx_products_vendor_status_created`,
  DROP KEY `idx_products_category_status`;

ALTER TABLE `orders`
  DROP KEY `idx_orders_customer_phone_created`,
  DROP KEY `idx_orders_payment_order_status`;

ALTER TABLE `vendor_orders`
  DROP KEY `idx_vendor_orders_status_credited`,
  DROP KEY `idx_vendor_orders_created_status`;
