-- ============================================================================
-- Migration 0034 (DOWN): Rollback Platform-Wise Visitors Tracking & Device Analytics
-- ============================================================================

ALTER TABLE `visitor_events`
  DROP COLUMN IF EXISTS `ip_hash`,
  DROP COLUMN IF EXISTS `referrer_domain`,
  DROP COLUMN IF EXISTS `os`,
  DROP COLUMN IF EXISTS `browser`,
  DROP COLUMN IF EXISTS `device_type`;
