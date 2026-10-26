-- Phase 09 permission catalog. Definitions only; never assign grants to existing roles/users.
INSERT INTO `permissions` (`name`,`module`,`description`) VALUES
  ('dashboard.view','dashboard','View admin dashboard summaries'),
  ('orders.poll','dashboard','Poll new order notifications'),
  ('orders.popup.view','dashboard','View unseen-order popup data'),
  ('orders.popup.dismiss','dashboard','Dismiss unseen-order popup'),
  ('assistant.report','dashboard','Use admin report assistant'),
  ('staff.manage','admin_access','Manage staff accounts and activation'),
  ('staff.assign_role','admin_access','Assign staff to an active role'),
  ('roles.manage','admin_access','Create and deactivate roles'),
  ('roles.grants.manage','admin_access','Assign permission keys to roles'),
  ('audit_logs.view','admin_access','View append-only administrative audit logs')
ON DUPLICATE KEY UPDATE `module`=VALUES(`module`), `description`=VALUES(`description`);
