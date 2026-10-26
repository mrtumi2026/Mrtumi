DROP TRIGGER IF EXISTS `trg_audit_logs_no_delete`;
DROP TRIGGER IF EXISTS `trg_audit_logs_no_update`;

-- Remove only unused Phase 09 catalog entries; never revoke a permission assigned to a role.
DELETE p FROM `permissions` p
LEFT JOIN `role_permissions` rp ON rp.`permission_id`=p.`id`
WHERE p.`name` IN (
 'orders.manage','refunds.review','checkout.recovery.view','checkout.recovery.manage',
 'catalog.view','catalog.manage','inventory.manage','content.manage','customers.manage',
 'security.manage','hr.manage','finance.view','finance.manage','vendors.manage',
 'resellers.manage','delivery.manage','settings.manage','integrations.manage',
 'communications.send','analytics.view','reports.view','error_logs.view','error_logs.manage'
) AND rp.`permission_id` IS NULL;
