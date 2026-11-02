DELETE FROM `delivery_locations`
WHERE (`division`='Dhaka' AND `district`='Dhaka' AND `upazila`='ঢাকার ভিতরে (Inside Dhaka)')
   OR (`division`='All' AND `district`='All' AND `upazila`='ঢাকার বাইরে (Outside Dhaka)')
   OR (`division`='Sub-Dhaka' AND `district`='Gazipur/Savar/Narayanganj' AND `upazila`='ঢাকা সাব-এরিয়া (Sub-Dhaka)');
