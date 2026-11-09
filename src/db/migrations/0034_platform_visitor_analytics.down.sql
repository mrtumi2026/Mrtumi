-- ============================================================================
-- Migration 0034 (DOWN): Rollback Platform-Wise Visitors Tracking & Device Analytics
-- ============================================================================

ALTER TABLE `visitor_events`
  DROP COLUMN `ip_hash`,
  DROP COLUMN `referrer_domain`,
  DROP COLUMN `os`,
  DROP COLUMN `browser`,
  DROP COLUMN `device_type`;
