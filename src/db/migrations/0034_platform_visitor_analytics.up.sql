-- ============================================================================
-- Migration 0034 (UP): Platform-Wise Visitors Tracking & Device Analytics
-- Target: MySQL 5.7+, MySQL 8.0+, MariaDB 10.3+
-- ============================================================================

ALTER TABLE `visitor_events`
  ADD COLUMN `device_type` VARCHAR(32) NOT NULL DEFAULT 'Desktop'
    COMMENT 'Desktop, Mobile, Tablet',
  ADD COLUMN `browser` VARCHAR(64) NOT NULL DEFAULT 'Other'
    COMMENT 'Chrome, Safari, Firefox, Edge, Opera, Samsung, etc.',
  ADD COLUMN `os` VARCHAR(64) NOT NULL DEFAULT 'Other'
    COMMENT 'Windows, Android, iOS, macOS, Linux, etc.',
  ADD COLUMN `referrer_domain` VARCHAR(191) NOT NULL DEFAULT ''
    COMMENT 'Source domain or direct referrer host',
  ADD COLUMN `ip_hash` CHAR(64) NOT NULL DEFAULT ''
    COMMENT 'Hashed client IP for anonymous unique visitor metrics';
