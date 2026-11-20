-- ============================================================================
-- Migration 0037 (UP): Vendor Store Branding, Store Slugs & Canonical Public Storefront
-- Target Engine: MariaDB 10.3+ ONLY (Production: CloudLinux MariaDB 10.6.18+)
-- Engine Note: Uses MariaDB-specific idempotent DDL extensions:
--   - ADD COLUMN IF NOT EXISTS
--   - ADD UNIQUE KEY IF NOT EXISTS
--   - ADD KEY IF NOT EXISTS
-- MySQL 8.0 does NOT support IF NOT EXISTS on indexes; Gate 1 strictly blocks non-MariaDB.
-- CAUTION / LOCKING NOTICE:
-- In MariaDB, ALTER TABLE operations acquire exclusive metadata locks (MDL).
-- While appending columns (without AFTER clause) may allow INSTANT operations in compatible
-- storage formats, index creation (ADD UNIQUE KEY, ADD KEY) may require table rebuild or lock wait.
-- Do not run during peak traffic; execute during low-traffic maintenance windows.
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
