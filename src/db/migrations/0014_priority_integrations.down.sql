ALTER TABLE `courier_apis`
  DROP COLUMN `sandbox`,
  DROP COLUMN `secret_key`,
  DROP COLUMN `api_key`;

ALTER TABLE `payment_gateways`
  DROP COLUMN `merchant_id`,
  DROP COLUMN `secret_key`,
  DROP COLUMN `api_key`;

ALTER TABLE `banners`
  DROP COLUMN `created_at`,
  DROP COLUMN `badge`;
