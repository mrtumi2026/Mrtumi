-- Seed the standard quick-order delivery zones. The labels intentionally match the
-- values synchronized by the admin shipping-charge settings handler.
INSERT INTO `delivery_locations` (`division`,`district`,`upazila`,`delivery_charge_paisa`,`status`)
SELECT 'Dhaka','Dhaka','ঢাকার ভিতরে (Inside Dhaka)',6000,1
WHERE NOT EXISTS (
  SELECT 1 FROM `delivery_locations`
  WHERE `division`='Dhaka' AND `district`='Dhaka' AND `upazila`='ঢাকার ভিতরে (Inside Dhaka)'
);

INSERT INTO `delivery_locations` (`division`,`district`,`upazila`,`delivery_charge_paisa`,`status`)
SELECT 'All','All','ঢাকার বাইরে (Outside Dhaka)',12000,1
WHERE NOT EXISTS (
  SELECT 1 FROM `delivery_locations`
  WHERE `division`='All' AND `district`='All' AND `upazila`='ঢাকার বাইরে (Outside Dhaka)'
);
