-- Remove only catalog entries that are not assigned to any role. Keep in-use permissions intact.
DELETE p FROM `permissions` p
LEFT JOIN `role_permissions` rp ON rp.`permission_id`=p.`id`
WHERE p.`name` IN ('dashboard.view','orders.poll','orders.popup.view','orders.popup.dismiss','assistant.report','staff.manage','staff.assign_role','roles.manage','roles.grants.manage','audit_logs.view')
  AND rp.`permission_id` IS NULL;
