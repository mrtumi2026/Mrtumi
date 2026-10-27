-- Phase 14: remove consent metadata added by migration 0010.
ALTER TABLE `orders`
  DROP COLUMN `analytics_consent_version`,
  DROP COLUMN `analytics_consent_at`;
