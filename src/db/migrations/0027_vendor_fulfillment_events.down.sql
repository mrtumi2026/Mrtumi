-- Retain nullable tracking_id on rollback so multiple unbooked shipment attempts remain representable.
DROP TABLE IF EXISTS `fulfillment_shipment_events`;
ALTER TABLE `fulfillment_shipments` DROP COLUMN `booking_status`;
ALTER TABLE `vendor_sub_orders` DROP COLUMN `delivery_mode`;
