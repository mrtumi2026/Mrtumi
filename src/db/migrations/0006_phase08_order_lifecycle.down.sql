DROP TABLE IF EXISTS `incomplete_order_history`;
ALTER TABLE `incomplete_orders`
  DROP FOREIGN KEY `fk_incomplete_recovered_order`,
  DROP INDEX `uq_incomplete_dedupe`,
  DROP INDEX `uq_incomplete_recovered_order`,
  DROP COLUMN `recovered_order_id`,
  DROP COLUMN `consent_withdrawn_at`,
  DROP COLUMN `notification_allowed`,
  DROP COLUMN `dedupe_key`;
ALTER TABLE `order_otps`
  DROP FOREIGN KEY `fk_order_otps_customer`,
  DROP FOREIGN KEY `fk_order_otps_order`,
  DROP INDEX `idx_order_otps_binding`,
  DROP COLUMN `customer_id`,
  DROP COLUMN `session_hash`,
  ADD KEY `idx_order_otps_order` (`order_id`),
  ADD CONSTRAINT `fk_order_otps_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE;
ALTER TABLE `stock_reservations` DROP COLUMN `request_hash`;
ALTER TABLE `order_status_history`
  DROP INDEX `uq_order_status_history_request`,
  DROP COLUMN `request_key`;
DROP TABLE IF EXISTS `refund_status_history`;
ALTER TABLE `refunds` DROP INDEX `uq_refunds_request_key`, DROP COLUMN `provider_reference`, DROP COLUMN `request_key`;
