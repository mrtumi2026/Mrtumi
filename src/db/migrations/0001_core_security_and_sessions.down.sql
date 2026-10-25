-- ============================================================================
-- Migration 0001 (DOWN): Reverse Core RBAC, Staff Users, Settings & Security
-- ============================================================================

DROP TABLE IF EXISTS `error_logs`;
DROP TABLE IF EXISTS `ip_blocks`;
DROP TABLE IF EXISTS `rate_limits`;
DROP TABLE IF EXISTS `idempotency_keys`;
DROP TABLE IF EXISTS `audit_logs`;
DROP TABLE IF EXISTS `web_sessions`;
DROP TABLE IF EXISTS `settings`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `role_permissions`;
DROP TABLE IF EXISTS `permissions`;
DROP TABLE IF EXISTS `roles`;
