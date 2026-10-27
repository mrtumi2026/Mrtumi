-- Phase 14: record optional analytics attribution consent alongside any order attribution.
ALTER TABLE `orders`
  ADD COLUMN `analytics_consent_at` DATETIME DEFAULT NULL AFTER `consent_accepted_at`,
  ADD COLUMN `analytics_consent_version` VARCHAR(24) DEFAULT NULL AFTER `analytics_consent_at`;
