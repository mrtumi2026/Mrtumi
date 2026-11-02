-- Optional provider client identifier for courier account credentials.
ALTER TABLE `courier_apis`
  ADD COLUMN `client_id` VARCHAR(191) NOT NULL DEFAULT '' AFTER `api_key`;
