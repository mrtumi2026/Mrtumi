-- ============================================================================
-- Migration 0038 (DOWN): Revert Vendor Courier Booking Requests and Audit Trail
-- WARNING: DATA-DESTRUCTIVE ROLLBACK. Drops request records and audit logs.
-- Ensure vendor_courier_booking_requests and vendor_courier_booking_audit_logs
-- have been backed up before running this rollback in production.
-- ============================================================================

DROP TABLE IF EXISTS `vendor_courier_booking_audit_logs`;
DROP TABLE IF EXISTS `vendor_courier_booking_requests`;
