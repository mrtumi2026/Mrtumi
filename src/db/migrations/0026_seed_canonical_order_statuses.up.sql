-- Seed the MySQL order lifecycle display/filter definitions without rewriting existing labels or history.
-- Actionable transitions remain governed by the order lifecycle repository, not by this lookup table.
INSERT IGNORE INTO `order_statuses` (`name`,`slug`,`badge_class`,`color`,`sort_order`,`status`) VALUES
  ('Pending','pending','sb-1','#f59e0b',10,1),
  ('Confirmed','confirmed','sb-2','#3b82f6',20,1),
  ('Processing','processing','sb-2','#2563eb',30,1),
  ('Shipped','shipped','sb-3','#8b5cf6',40,1),
  ('Delivered','delivered','sb-6','#22c55e',50,1),
  ('Return requested','return_requested','sb-5','#f97316',60,1),
  ('Cancelled','cancelled','sb-7','#ef4444',70,1),
  ('Failed','failed','sb-7','#dc2626',80,1),
  ('Returned','returned','sb-4','#64748b',90,1),
  ('Completed','completed','sb-6','#22c55e',100,1);
