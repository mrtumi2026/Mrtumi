-- ============================================================================
-- Migration 0037 (DOWN): Rollback Vendor Store Branding
-- Target Engine: MariaDB 10.3+ ONLY (Production: CloudLinux MariaDB 10.6.18+)
-- Engine Note: Uses MariaDB-specific idempotent DDL extensions:
--   - DROP INDEX IF EXISTS
--   - DROP COLUMN IF EXISTS
-- CAUTION: Drops store branding columns. Run ONLY upon explicit owner decision.
-- ============================================================================

ALTER TABLE `vendors`
  DROP INDEX IF EXISTS `uq_vendors_slug`,
  DROP INDEX IF EXISTS `idx_vendors_store_status`,
  DROP COLUMN IF EXISTS `store_status`,
  DROP COLUMN IF EXISTS `description`,
  DROP COLUMN IF EXISTS `tagline`,
  DROP COLUMN IF EXISTS `banner_url`,
  DROP COLUMN IF EXISTS `logo_url`,
  DROP COLUMN IF EXISTS `slug`;
