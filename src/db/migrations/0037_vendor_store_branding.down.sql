-- ============================================================================
-- Migration 0037 (DOWN): Rollback Vendor Store Branding
-- CAUTION: Drops store branding columns. Run ONLY upon explicit owner decision.
-- ============================================================================

ALTER TABLE `vendors`
  DROP INDEX `uq_vendors_slug`,
  DROP INDEX `idx_vendors_store_status`,
  DROP COLUMN `store_status`,
  DROP COLUMN `description`,
  DROP COLUMN `tagline`,
  DROP COLUMN `banner_url`,
  DROP COLUMN `logo_url`,
  DROP COLUMN `slug`;
