-- ============================================================================
-- Migration 0003 (DOWN): Reverse Customers, Orders, Payments, Couriers, POS, HRM & Finance
-- ============================================================================

DROP TABLE IF EXISTS `expenses`;
DROP TABLE IF EXISTS `fund_transactions`;
DROP TABLE IF EXISTS `bonuses`;
DROP TABLE IF EXISTS `salaries`;
DROP TABLE IF EXISTS `leaves`;
DROP TABLE IF EXISTS `attendances`;
DROP TABLE IF EXISTS `employees`;
DROP TABLE IF EXISTS `hrm_departments`;
DROP TABLE IF EXISTS `pos_shifts`;
DROP TABLE IF EXISTS `visitor_events`;
DROP TABLE IF EXISTS `notification_queue`;
DROP TABLE IF EXISTS `sms_logs`;
DROP TABLE IF EXISTS `newsletter_subscribers`;
DROP TABLE IF EXISTS `contact_messages`;
DROP TABLE IF EXISTS `complaints`;
DROP TABLE IF EXISTS `social_links`;
DROP TABLE IF EXISTS `features`;
DROP TABLE IF EXISTS `cms_pages`;
DROP TABLE IF EXISTS `blogs`;
DROP TABLE IF EXISTS `reviews`;
DROP TABLE IF EXISTS `banners`;
DROP TABLE IF EXISTS `campaigns`;
DROP TABLE IF EXISTS `fraud_checks`;
DROP TABLE IF EXISTS `courier_webhook_logs`;
DROP TABLE IF EXISTS `courier_shipments`;
DROP TABLE IF EXISTS `courier_apis`;
DROP TABLE IF EXISTS `incomplete_orders`;
DROP TABLE IF EXISTS `refunds`;
DROP TABLE IF EXISTS `order_payments`;
DROP TABLE IF EXISTS `payment_gateways`;
DROP TABLE IF EXISTS `order_otps`;
DROP TABLE IF EXISTS `order_status_history`;
DROP TABLE IF EXISTS `order_items`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `order_statuses`;
DROP TABLE IF EXISTS `coupons`;
DROP TABLE IF EXISTS `delivery_withdrawals`;
DROP TABLE IF EXISTS `delivery_boys`;
DROP TABLE IF EXISTS `delivery_locations`;
DROP TABLE IF EXISTS `password_resets`;
DROP TABLE IF EXISTS `customer_addresses`;
DROP TABLE IF EXISTS `customers`;
