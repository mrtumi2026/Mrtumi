-- ============================================================================
-- Migration 0038 (DOWN): Revert Vendor Courier Booking Requests and Audit Trail
-- ============================================================================

DROP TABLE IF EXISTS `vendor_courier_booking_audit_logs`;
DROP TABLE IF EXISTS `vendor_courier_booking_requests`;
