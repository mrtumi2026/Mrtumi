-- 0028_multi_courier_engine.up.sql
-- Multi-courier integration schema: provider types, live quote support, webhook credentials,
-- and shipment quote snapshots with idempotency protection.

ALTER TABLE `courier_apis`
  ADD COLUMN `provider_type` VARCHAR(32) NOT NULL DEFAULT 'custom' AFTER `code`,
  ADD COLUMN `webhook_token` VARCHAR(120) DEFAULT NULL AFTER `client_id`,
  ADD COLUMN `supports_live_quotes` TINYINT(1) NOT NULL DEFAULT 0 AFTER `sandbox`,
  ADD COLUMN `service_options_json` TEXT DEFAULT NULL AFTER `supports_live_quotes`;

ALTER TABLE `fulfillment_shipments`
  ADD COLUMN `quoted_charge_paisa` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `cod_due_paisa`,
  ADD COLUMN `booking_idempotency_key` VARCHAR(120) DEFAULT NULL AFTER `booking_status`,
  ADD COLUMN `recommendation_snapshot_json` TEXT DEFAULT NULL AFTER `booking_idempotency_key`,
  ADD COLUMN `booking_response_json` TEXT DEFAULT NULL AFTER `recommendation_snapshot_json`,
  ADD COLUMN `external_consignment_id` VARCHAR(120) DEFAULT NULL AFTER `tracking_id`,
  ADD UNIQUE KEY `uq_fulfillment_booking_idempotency` (`booking_idempotency_key`);
