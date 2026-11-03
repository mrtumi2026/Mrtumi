ALTER TABLE `resellers`
  DROP FOREIGN KEY `fk_reseller_branding_reviewer`,
  DROP KEY `idx_resellers_branding_status`,
  DROP CONSTRAINT `chk_reseller_branding_status`,
  DROP COLUMN `branding_reviewed_at`,
  DROP COLUMN `branding_reviewed_by_user_id`,
  DROP COLUMN `branding_review_note`,
  DROP COLUMN `branding_status`,
  DROP COLUMN `logo_url`;
ALTER TABLE `reseller_commerce_settings`
  DROP CONSTRAINT `chk_reseller_platform_fee_bps`,
  DROP CONSTRAINT `chk_reseller_platform_fee_type`,
  DROP COLUMN `platform_fee_bps`,
  DROP COLUMN `platform_fee_type`;
