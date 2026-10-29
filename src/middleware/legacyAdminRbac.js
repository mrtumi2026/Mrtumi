'use strict';

const { hasPermission } = require('./rbac');
const { requireCsrf } = require('./csrf');
const { AuthorizationError } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET','HEAD','OPTIONS']);
const has = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

/** Return the least-privilege policy for every mounted /admin path. Unknown paths fail closed. */
function policyForAdminRoute(method, pathname) {
  const verb = String(method || 'GET').toUpperCase();
  const path = String(pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const write = !SAFE_METHODS.has(verb);
  const viewOrManage = (view, manage) => write ? manage : view;
  if (path === '/admin' || path === '/admin/login' || path === '/admin/logout' || path==='/logout') return { exempt: true, key: null, audit: false };

  if (path === '/admin/dashboard') return { key:'dashboard.view', audit:false };
  if (has(path,'/admin/orders/poll-new')) return { key:'orders.poll', audit:false };
  if (path==='/admin/dashboard/dismiss-new-orders-popup') return { key:'orders.popup.dismiss', audit:false };
  if (has(path,'/admin/dashboard/new-orders-popup')) return { key:'orders.popup.view', audit:false };
  if (has(path,'/admin/gemini-chat')) return { key:'assistant.report', audit:false };
  if (has(path,'/admin/smsgeteway/balance') || has(path,'/admin/bdcourier/my-plan') || has(path,'/admin/steadfast/dashboard-widget')) return { key:'dashboard.view', audit:false };

  if (has(path,'/admin/audit-logs')) return { key:'audit_logs.view', audit:false };
  if (has(path,'/admin/phase09/access')) {
    if(path.includes('/staff')&&write&&verb!=='PATCH')return {key:'staff.manage',also:['staff.assign_role'],audit:false};
    if(/\/roles\/[^/]+\/permissions$/.test(path)&&write)return {key:'roles.manage',also:['roles.grants.manage'],audit:false};
    return {key:path.includes('/staff')?'staff.manage':'roles.manage',audit:false};
  }
  if (has(path,'/admin/users')) return { key:write && !/toggle|delete/.test(path)?'staff.manage':'staff.manage', ...(write&&!/toggle|delete/.test(path)?{also:['staff.assign_role']}:{}) ,audit:false };
  if (has(path,'/admin/roles') || has(path,'/admin/permissions')) return { key:'roles.manage', audit:false };
  if (path==='/admin/phase08' || has(path,'/admin/phase08/orders')) return { key:'orders.manage', audit:false };
  if (has(path,'/admin/phase08/refunds')) return { key:'refunds.review', audit:false };
  if (has(path,'/admin/phase08/incomplete')) return { key:write?'checkout.recovery.manage':'checkout.recovery.view', audit:false };
  if (has(path,'/admin/phase08/settings')) return { key:'settings.manage', audit:false };
  if (has(path,'/admin/phase06')) return { key:write?'inventory.manage':'inventory.manage', audit:false };

  if (has(path,'/admin/refunds')) return { key:'refunds.review', audit:true };
  if (has(path,'/admin/incomplete-orders')) return { key:write?'checkout.recovery.manage':'checkout.recovery.view', audit:true };
  if (has(path,'/admin/customer/ip-block')) return { key:'security.manage', audit:true };
  if (has(path,'/admin/reseller-orders') || has(path,'/admin/reseller-deposits') || has(path,'/admin/reseller-withdrawals') || has(path,'/admin/reseller-tx'))
    return { key:/withdraw|deposit|reseller-tx/.test(path)?viewOrManage('finance.view','finance.manage'):'resellers.manage', audit:write };
  if (has(path,'/admin/order') || has(path,'/admin/orderstatus')) return { key:'orders.manage', audit:write };

  if (has(path,'/admin/products') || has(path,'/admin/inhouse-products') || has(path,'/admin/categories') || has(path,'/admin/subcategories') || has(path,'/admin/childcategories') || has(path,'/admin/brands') || has(path,'/admin/color') || has(path,'/admin/size') || has(path,'/admin/coupon') || has(path,'/admin/reviews') || has(path,'/admin/review'))
    return { key:viewOrManage('catalog.view','catalog.manage'), audit:write };

  if (has(path,'/admin/suppliers') || has(path,'/admin/purchases')) return { key:write?'inventory.manage':'inventory.manage', audit:write };
  if (has(path,'/admin/phase06')) return { key:'inventory.manage', audit:false };
  if (has(path,'/admin/employees') || has(path,'/admin/attendances') || has(path,'/admin/leaves')) return { key:'hr.manage', audit:write };
  if (has(path,'/admin/salaries') || has(path,'/admin/salary-payments') || has(path,'/admin/bonuses')) return { key:viewOrManage('finance.view','finance.manage'), audit:write };
  if (has(path,'/admin/fund') || has(path,'/admin/expenses') || has(path,'/admin/vendor-withdrawals') || has(path,'/admin/delivery-withdrawals')) return { key:viewOrManage('finance.view','finance.manage'), audit:write };
  if (has(path,'/admin/vendors') || has(path,'/admin/vendor-verifications')) return { key:'vendors.manage', audit:write };
  if (has(path,'/admin/resellers') || has(path,'/admin/reseller-verifications')) return { key:'resellers.manage', audit:write };
  if (has(path,'/admin/delivery-boys') || has(path,'/admin/delivery/divisions')) return { key:'delivery.manage', audit:write };
  if (has(path,'/admin/complaints') || has(path,'/admin/contact-messages') || has(path,'/admin/newsletter-subscribers') || has(path,'/admin/customer')) return { key:'customers.manage', audit:write };

  if (has(path,'/admin/blog') || has(path,'/admin/blogs') || has(path,'/admin/page') || has(path,'/admin/banner') || has(path,'/admin/features') || has(path,'/admin/social-media')) return { key:'content.manage', audit:write };
  if (has(path,'/admin/manual-fraud-check')) return { key:'security.manage', audit:false };
  if (has(path,'/admin/sms/custom-send')) return { key:'communications.send', audit:write };
  if (has(path,'/admin/paymentgeteway') || has(path,'/admin/courierapi') || has(path,'/admin/smsgeteway') || has(path,'/admin/bdcourier') || has(path,'/admin/steadfast')) return { key:'integrations.manage', audit:write };
  if (has(path,'/admin/ads-analytics')) return { key:'analytics.view', audit:false };
  if (has(path,'/admin/reports')) return { key:'reports.view', audit:false, auditRead:true };
  if (has(path,'/admin/error-log')) return { key:write?'error_logs.manage':'error_logs.view', audit:write };
  if (has(path,'/admin/clear-cache')) return { key:'settings.manage', audit:write };
  if (path==='/admin/settings/save' && write) return { key:'settings.manage', audit:false };
  if (has(path,'/admin/campaign')) return { key:'content.manage', audit:write };
  if (has(path,'/admin/settings') || has(path,'/admin/sale-notification') || has(path,'/admin/contact/manage') || has(path,'/admin/email-setting') || has(path,'/admin/fraud-settings') || has(path,'/admin/order-restriction-settings') || has(path,'/admin/facebook-capi') || has(path,'/admin/gemini-ai') || has(path,'/admin/social-login') || has(path,'/admin/cron-jobs') || has(path,'/admin/tag-manager') || has(path,'/admin/pixels') || has(path,'/admin/tiktok-pixels') || has(path,'/admin/facebook-page') || has(path,'/admin/popup') || has(path,'/admin/seo-settings') || has(path,'/admin/sitemap') || has(path,'/admin/license-info') || has(path,'/admin/updates')) return { key:'settings.manage', audit:write };

  return { key:null, audit:write, unmapped:true };
}

function legacyAdminRbac(req, _res, next) {
  if (!req.path.startsWith('/admin') || !req.adminUser) return next();
  const policy = policyForAdminRoute(req.method, req.path);
  req.adminRoutePolicy = policy;
  if (policy.exempt) return next();
  if (policy.unmapped) return next(new AuthorizationError('This admin route is blocked pending an explicit permission policy.'));
  const required=[policy.key,...(policy.also||[])].filter(Boolean);
  if (required.every(key=>hasPermission(req.adminUser,key))) return next();
  return next(new AuthorizationError('Insufficient permissions for this admin route.'));
}

function legacyAdminCsrf(req, res, next) {
  if (!req.path.startsWith('/admin') || !req.adminUser || SAFE_METHODS.has(req.method) || req.path === '/admin/login') return next();
  // Multer must parse the multipart body before the CSRF field is readable. This exact upload path
  // enforces requireCsrf immediately after upload parsing and removes any newly written files on denial.
  const multipartUpload=req.method==='POST'&&/^\/admin\/phase06\/products\/\d+\/gallery\/upload$/.test(req.path)&&
    String(req.headers?.['content-type']||'').toLowerCase().startsWith('multipart/form-data;');
  if(multipartUpload)return next();
  return requireCsrf(req,res,next);
}

module.exports = { policyForAdminRoute, legacyAdminRbac, legacyAdminCsrf };
