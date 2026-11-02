DROP TRIGGER IF EXISTS `trg_reseller_price_snapshot_no_delete`;
DROP TRIGGER IF EXISTS `trg_reseller_price_snapshot_no_update`;
DROP TABLE IF EXISTS `reseller_financial_adjustments`;
DROP TABLE IF EXISTS `reseller_financial_ledger`;
DROP TABLE IF EXISTS `courier_cod_collections`;
DROP TABLE IF EXISTS `fulfillment_shipments`;
DROP TABLE IF EXISTS `vendor_sub_order_items`;
DROP TABLE IF EXISTS `vendor_sub_orders`;
DROP TABLE IF EXISTS `reseller_order_price_snapshots`;
DROP TABLE IF EXISTS `reseller_product_eligibility`;
DROP TABLE IF EXISTS `reseller_commerce_settings`;
ALTER TABLE `orders`
  DROP COLUMN `reseller_logo_snapshot`,
  DROP COLUMN `reseller_store_name_snapshot`,
  DROP COLUMN `reseller_pricing_mode`;
