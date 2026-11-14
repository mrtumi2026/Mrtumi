-- ============================================================================
-- Migration 0037 (UP): Vendor Store Branding, Store Slugs & Canonical Public Storefront
-- Target: MySQL 8.0+ / MariaDB 10.3+
-- All DDL statements are additive; columns appended to end of table to avoid
-- full table copy in MariaDB.
-- ============================================================================

ALTER TABLE `vendors`
  ADD COLUMN `slug` VARCHAR(191) DEFAULT NULL,
  ADD COLUMN `logo_url` VARCHAR(500) NOT NULL DEFAULT '/uploads/default/store-logo.svg',
  ADD COLUMN `banner_url` VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN `tagline` VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN `description` TEXT DEFAULT NULL,
  ADD COLUMN `store_status` TINYINT(1) NOT NULL DEFAULT 1;

-- Backfill existing vendors with unique slug: 'store-' + id
UPDATE `vendors`
SET `slug` = CONCAT('store-', `id`)
WHERE `slug` IS NULL OR `slug` = '';

-- Apply unique constraint on slug and indexing on store status + lifecycle status
ALTER TABLE `vendors`
  ADD UNIQUE KEY `uq_vendors_slug` (`slug`),
  ADD KEY `idx_vendors_store_status` (`store_status`, `lifecycle_status`);
