-- 0029_multi_courier_engine.down.sql
-- Revert multi-courier integration schema enhancements.

ALTER TABLE `fulfillment_shipments`
  DROP KEY `uq_fulfillment_booking_idempotency`,
  DROP COLUMN `external_consignment_id`,
  DROP COLUMN `booking_response_json`,
  DROP COLUMN `recommendation_snapshot_json`,
  DROP COLUMN `booking_idempotency_key`,
  DROP COLUMN `quoted_charge_paisa`;

ALTER TABLE `courier_apis`
  DROP COLUMN `service_options_json`,
  DROP COLUMN `supports_live_quotes`,
  DROP COLUMN `webhook_token`,
  DROP COLUMN `provider_type`;
