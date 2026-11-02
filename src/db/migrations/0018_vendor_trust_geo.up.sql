-- Vendor trust tiers and canonical Bangladesh administrative locations.
ALTER TABLE `vendors`
  ADD COLUMN `trust_level` VARCHAR(16) NOT NULL DEFAULT 'new' AFTER `lifecycle_status`,
  ADD COLUMN `district` VARCHAR(100) NOT NULL DEFAULT '' AFTER `address`,
  ADD COLUMN `upazila` VARCHAR(100) NOT NULL DEFAULT '' AFTER `district`,
  ADD KEY `idx_vendors_trust_level` (`trust_level`,`lifecycle_status`);

UPDATE `vendors`
SET `trust_level` = CASE
  WHEN `trusted_auto_publish` = 1 THEN 'trusted'
  WHEN `verified` = 1 THEN 'verified'
  ELSE 'new'
END;

UPDATE `vendors` v JOIN `vendor_applications` a ON a.`vendor_id`=v.`id`
SET v.`district`=a.`district`,v.`upazila`=a.`upazila`;
