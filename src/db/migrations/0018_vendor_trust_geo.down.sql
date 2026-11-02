ALTER TABLE `vendors`
  DROP INDEX `idx_vendors_trust_level`,
  DROP COLUMN `upazila`,
  DROP COLUMN `district`,
  DROP COLUMN `trust_level`;
