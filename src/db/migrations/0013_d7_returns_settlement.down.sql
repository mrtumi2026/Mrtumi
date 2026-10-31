-- Reversible schema rollback; business rows in these feature tables are removed with their schema.
DROP TABLE IF EXISTS `vendor_financial_adjustments`;
DROP TABLE IF EXISTS `vendor_settlement_items`;
DROP TABLE IF EXISTS `vendor_settlement_batches`;
DROP TABLE IF EXISTS `customer_return_events`;
DROP TABLE IF EXISTS `customer_return_items`;
DROP TABLE IF EXISTS `customer_return_requests`;
DROP TABLE IF EXISTS `return_category_policies`;
DROP TABLE IF EXISTS `order_cancellation_requests`;
DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.id=rp.permission_id
WHERE p.name IN ('returns.review','refunds.approve_high','settlements.prepare','settlements.approve');
DELETE FROM `permissions` WHERE `name` IN ('returns.review','refunds.approve_high','settlements.prepare','settlements.approve');
