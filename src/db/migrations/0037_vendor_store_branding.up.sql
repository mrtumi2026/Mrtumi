-- ============================================================================
-- Migration 0037 (UP): Vendor Store Branding, Store Slugs & Canonical Public Storefront
-- Target: MariaDB 10.3+ / MySQL 8.0+
-- All DDL statements are additive and idempotent (IF NOT EXISTS);
-- columns appended to end of table to avoid full table copy in MariaDB.
-- Safe against re-runs after partial DDL interruption.
-- ============================================================================

ALTER TABLE `vendors`
  ADD COLUMN IF NOT EXISTS `slug` VARCHAR(191) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `logo_url` VARCHAR(500) NOT NULL DEFAULT '/uploads/default/store-logo.svg',
  ADD COLUMN IF NOT EXISTS `banner_url` VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS `tagline` VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS `description` TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `store_status` TINYINT(1) NOT NULL DEFAULT 1;

-- Backfill existing vendors with unique slug: 'store-' + id
-- Only vendors with NULL or empty slug are updated; existing custom slugs are preserved
UPDATE `vendors`
SET `slug` = CONCAT('store-', `id`)
WHERE `slug` IS NULL OR `slug` = '';

-- Apply unique constraint on slug and indexing on store status + lifecycle status
-- Idempotent IF NOT EXISTS prevents duplicate index errors on partial DDL retries
ALTER TABLE `vendors`
  ADD UNIQUE KEY IF NOT EXISTS `uq_vendors_slug` (`slug`),
  ADD KEY IF NOT EXISTS `idx_vendors_store_status` (`store_status`, `lifecycle_status`);

