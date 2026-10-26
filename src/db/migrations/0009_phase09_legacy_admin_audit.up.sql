-- Phase 09 closure: permission catalog for legacy admin route families, with no role grants.
INSERT INTO `permissions` (`name`,`module`,`description`) VALUES
 ('orders.manage','orders','Read and manage orders, statuses and reseller orders'),
 ('refunds.review','finance','Review and decide refund requests'),
 ('checkout.recovery.view','customers','View consented incomplete checkout records'),
 ('checkout.recovery.manage','customers','Manage consented incomplete checkout records'),
 ('catalog.view','catalog','Read catalog, categories, reviews and promotions'),
 ('catalog.manage','catalog','Create, update, approve and remove catalog records'),
 ('inventory.manage','inventory','Manage stock, suppliers and purchase receiving'),
 ('content.manage','content','Manage blogs, pages, banners and storefront content'),
 ('customers.manage','customers','Manage customer, contact and support records'),
 ('security.manage','security','Manage IP blocks and security controls'),
 ('hr.manage','hr','Manage employee, attendance, leave, salary and bonus records'),
 ('finance.view','finance','Read fund, expense, salary and financial summaries'),
 ('finance.manage','finance','Create or manage fund, expense, salary and payment records'),
 ('vendors.manage','vendors','Manage vendor profiles and verification'),
 ('resellers.manage','resellers','Manage reseller profiles and verification'),
 ('delivery.manage','delivery','Manage delivery staff, routes and delivery withdrawals'),
 ('settings.manage','settings','Manage general site and storefront settings'),
 ('integrations.manage','integrations','Manage payment, courier and messaging integration settings'),
 ('communications.send','communications','Send administrative SMS communications'),
 ('analytics.view','analytics','View advertising analytics'),
 ('reports.view','reports','View and export administrative reports'),
 ('error_logs.view','security','Read operational error logs'),
 ('error_logs.manage','security','Manage operational error logs')
ON DUPLICATE KEY UPDATE `module`=VALUES(`module`), `description`=VALUES(`description`);

-- Append-only protection for ordinary DML principals. A database principal with DDL/TRIGGER
-- privileges can still remove these triggers; least-privilege deployment grants remain required.
CREATE TRIGGER `trg_audit_logs_no_update`
BEFORE UPDATE ON `audit_logs` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='audit_logs is append-only';

CREATE TRIGGER `trg_audit_logs_no_delete`
BEFORE DELETE ON `audit_logs` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='audit_logs is append-only';
