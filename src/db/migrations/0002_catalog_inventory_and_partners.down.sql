-- ============================================================================
-- Migration 0002 (DOWN): Reverse Catalogue, Stock Ledger, Purchases & Partners
-- ============================================================================

DROP TABLE IF EXISTS `wholesale_applications`;
DROP TABLE IF EXISTS `stock_reservations`;
DROP TABLE IF EXISTS `stock_ledger`;
DROP TABLE IF EXISTS `purchase_items`;
DROP TABLE IF EXISTS `purchases`;
DROP TABLE IF EXISTS `suppliers`;
DROP TABLE IF EXISTS `product_variants`;
DROP TABLE IF EXISTS `products`;
DROP TABLE IF EXISTS `reseller_transactions`;
DROP TABLE IF EXISTS `resellers`;
DROP TABLE IF EXISTS `vendor_withdrawals`;
DROP TABLE IF EXISTS `vendors`;
DROP TABLE IF EXISTS `sizes`;
DROP TABLE IF EXISTS `colors`;
DROP TABLE IF EXISTS `brands`;
DROP TABLE IF EXISTS `childcategories`;
DROP TABLE IF EXISTS `subcategories`;
DROP TABLE IF EXISTS `categories`;
