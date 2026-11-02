-- Remove the legacy third zone so checkout exposes only the two configured national areas.
DELETE FROM `delivery_locations`
WHERE `division`='Sub-Dhaka'
  AND `district`='Gazipur/Savar/Narayanganj'
  AND `upazila`='ঢাকা সাব-এরিয়া (Sub-Dhaka)';

-- COD is available by default. MFS methods are created inactive until an administrator
-- configures the real receiving account and enables the method in payment settings.
INSERT INTO `payment_gateways` (`name`,`code`,`gateway_type`,`account_number`,`instructions`,`sandbox`,`status`)
SELECT 'Cash on Delivery','cod','auto','','Pay when your order is delivered.',1,1
WHERE NOT EXISTS (SELECT 1 FROM `payment_gateways` WHERE `code`='cod');

INSERT INTO `payment_gateways` (`name`,`code`,`gateway_type`,`account_number`,`instructions`,`sandbox`,`status`)
SELECT 'bKash','bkash','manual','','Configure the receiving account in Admin > Manual Payment Methods.',1,0
WHERE NOT EXISTS (SELECT 1 FROM `payment_gateways` WHERE `code`='bkash');

INSERT INTO `payment_gateways` (`name`,`code`,`gateway_type`,`account_number`,`instructions`,`sandbox`,`status`)
SELECT 'Nagad','nagad','manual','','Configure the receiving account in Admin > Manual Payment Methods.',1,0
WHERE NOT EXISTS (SELECT 1 FROM `payment_gateways` WHERE `code`='nagad');

INSERT INTO `payment_gateways` (`name`,`code`,`gateway_type`,`account_number`,`instructions`,`sandbox`,`status`)
SELECT 'Rocket','rocket','manual','','Configure the receiving account in Admin > Manual Payment Methods.',1,0
WHERE NOT EXISTS (SELECT 1 FROM `payment_gateways` WHERE `code`='rocket');
