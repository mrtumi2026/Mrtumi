-- D6 rollback removes only schema/config definitions; audit and customer/order history is untouched.
DROP TABLE IF EXISTS `customer_privacy_request_events`;
DROP TABLE IF EXISTS `customer_privacy_requests`;
DROP TABLE IF EXISTS `privacy_retention_settings`;
DROP TABLE IF EXISTS `customer_recovery_tokens`;
DROP TABLE IF EXISTS `customer_consent_current`;
DROP TABLE IF EXISTS `customer_consent_events`;
DROP TABLE IF EXISTS `customer_policy_acceptances`;
DROP TABLE IF EXISTS `privacy_consent_options`;
DROP TABLE IF EXISTS `privacy_policy_publication_history`;
DROP TABLE IF EXISTS `privacy_policy_versions`;
DELETE p FROM `permissions` p
LEFT JOIN `role_permissions` rp ON rp.`permission_id`=p.`id`
WHERE p.`name` IN ('privacy.manage','privacy.review') AND rp.`permission_id` IS NULL;
ALTER TABLE `customers`
  DROP COLUMN `phone_verified_at`,
  DROP COLUMN `email_verified_at`;
