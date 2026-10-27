'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {collectAdminRoutes,collectAdminRouteRegistrations}=require('../tests/helpers/adminRouteInventory');
const {policyForAdminRoute}=require('../src/middleware/legacyAdminRbac');

function risk(method,routePath){
  if(routePath.includes('/reports'))return method==='GET'?'HIGH — financial/customer export':'HIGH';
  if(/refund|fund|expense|salary|withdraw|paymentgeteway|sms\/custom-send/.test(routePath))return 'HIGH — financial/provider/sending';
  if(/users|roles|permissions|audit-logs/.test(routePath))return 'HIGH — access/security/audit';
  if(/order|customer|vendor|reseller|delivery|fraud|ip-block/.test(routePath))return 'HIGH — customer/order/partner data';
  if(!['GET','HEAD','OPTIONS'].includes(method))return 'MUTATION';
  return 'READ';
}
function audit(method,path,policy,route){
  if(method==='GET'&&path==='/admin/order/:status')return 'No event for ordinary read; P0 MySQL-backed status/search list has authorized HTTP success and error-path coverage';
  if(method==='GET'&&path==='/admin/order/invoice/:id')return 'No event for ordinary read; P0 invoice MySQL path has authorized HTTP success coverage';
  if(method==='POST'&&path==='/logout')return 'Specific admin.logout event; session destroyed';
  if(method==='GET'&&path==='/logout')return 'No-op redirect; does not destroy session';
  if(method==='POST'&&path==='/admin/login')return 'Specific login success/failure event';
  if(policy.auditRead)return 'CSV export event (minimized)';
  if(policy.audit)return 'Generic path/permission event on successful response; legacy mutation is not transactionally coupled';
  if(['GET','HEAD','OPTIONS'].includes(method))return 'No event for ordinary read';
  if(route.file==='adminAccess.js'){
    if(path==='/admin/permissions/create'||path.startsWith('/admin/permissions/delete/'))return 'No event; protected 405/no-op';
    return 'Specific transactional staff/role audit event';
  }
  if(route.file==='phase08Admin.js')return 'Specific transactional Phase 08 domain audit event';
  if(route.file==='phase06.js')return 'Specific Phase 06 domain audit event (not atomic with every mutation)';
  if(route.file==='adminDashboard.js'&&path==='/admin/gemini-chat/refresh-context')return 'Acknowledgement only; no state or provider operation';
  if(route.file==='adminDashboard.js'&&['/admin/dashboard/dismiss-new-orders-popup','/admin/gemini-chat/send','/admin/gemini-chat/clear'].includes(path))return 'Specific minimized dashboard/assistant audit event';
  return 'NO AUDIT EVENT — review required';
}
const registrations=collectAdminRouteRegistrations();
const routes=collectAdminRoutes();
const duplicateRegistrations=registrations.length-routes.length;
const unmapped=routes.filter(route=>policyForAdminRoute(route.method,route.path).unmapped);
if(unmapped.length){console.error(`Unmapped legacy admin routes: ${unmapped.map(r=>`${r.method} ${r.path}`).join(', ')}`);process.exit(1);}
const methods={};for(const r of routes)methods[r.method]=(methods[r.method]||0)+1;
const out=[];
out.push('# Phase 09 — Legacy Admin Route Authorization Inventory');
out.push('');
out.push('Generated from route registrations in `src/routes/{adminAuth,adminAccess,adminDashboard,adminOrders,adminCatalog,adminOperations,adminSettings,phase06,phase08Admin}.js` and the `adminSettings.js` settings-page map. Exact method/path entries below are guarded by the global fail-closed middleware after session refresh; each route module also retains its existing `requireAdmin` where present. Unauthenticated requests continue to the module’s existing auth behavior. Effective permission checks are server-side; hidden links are not treated as authorization.');
out.push('');
out.push(`**Inventory:** ${routes.length} unique active method/path endpoints from ${registrations.length} route registrations (${duplicateRegistrations} duplicate method/path registrations, resolved by actual mount order); ${routes.filter(r=>!['GET','HEAD','OPTIONS'].includes(r.method)).length} state-changing endpoints; ${Object.entries(methods).map(([m,n])=>`${m} ${n}`).join(', ')}. ${unmapped.length} unmapped. The HTTP integration test sends each non-exempt listed method/path as a logged-in zero-grant user and requires 403; login/root/self-logout endpoints are exempt by design. A unit policy matrix tests allow/deny for each mapped entry. Representative full-stack allowed behavior is tested for dashboard, access lifecycle, polling, popup, assistant and audit. It does not claim successful business-operation coverage for every legacy handler.`);
out.push('');
out.push('## Enforcement and limits');
out.push('');
out.push('- All authenticated `/admin` paths except the existing login/root flow resolve through `policyForAdminRoute`; unmapped routes fail closed even if a role has unrelated keys. Current inventory is the source for reviewing new registrations.');
out.push('- Every authenticated non-safe `/admin` request requires the session-bound CSRF token. Admin templates add the token to legacy forms and same-origin `fetch`; existing per-route CSRF guards remain. `GET /admin/clear-cache` is now 405; the state change is POST + CSRF.');
out.push('- Existing explicit Phase 06/08/09 and dashboard audit writers are retained. Other successful legacy mutations emit a minimal `admin.legacy.<permission>.mutation` event before the response is sent; event contains method/path/permission/status, not submitted body. Audit failure returns 503 and explicitly warns that the mutation may already have applied; old callback-based mutation handlers are not transactionally coupled to that generic audit insert.');
out.push('- CSV report exports produce a minimized audit event. Ordinary reads are not all audited to avoid high-volume data collection.');
out.push('- Admin operations on vendor/reseller records are platform-wide administrative operations, not vendor-tenant scoped. Vendor/reseller self-service route modules are outside the `/admin` inventory and retain their own portal authentication. No tenant-scoped admin data boundary is claimed.');
out.push('- `BLOCKED`: role grants are owner-controlled and unassigned by migration. Non-Super-Admin operation requires approved grants. Business-level success tests are not exhaustive for every legacy route; the blanket HTTP deny sweep and per-route policy matrix are automated.');
out.push('');
out.push('## Route-by-route inventory');
out.push('');
out.push('| Method | Path | Authentication | Server-side permission | Sensitive data / mutation risk | Audit event | Automated coverage | Status |');
out.push('|---|---|---|---|---|---|---|---|');
for(const r of routes){
  const p=policyForAdminRoute(r.method,r.path);
  const auth=r.path==='/logout'?(r.method==='POST'?'Current admin session only; CSRF required':'No-op redirect; session not mutated'):r.path==='/admin/login'?'Login endpoint; session-bound CSRF required':r.path==='/admin'?'Existing root redirect; subsequent dashboard authorization':'Refreshed admin session + legacyAdminRbac; module requireAdmin also applies';
  const permission=r.path==='/logout'?'Self-only session route':p.exempt?'login/root policy':[p.key,...(p.also||[])].filter(Boolean).join(' + ')||'BLOCKED — unmapped';
  const test=r.path==='/admin/login'?'auth regression + policy exemption':r.method==='GET'&&r.path==='/admin/order/:status'?'MySQL authenticated status/search/unpaid/unknown-status HTTP success; persisted data, counts and descending-ID order; unauthenticated/zero-grant denials; forced sanitized DB-query failure':r.method==='GET'&&r.path==='/admin/order/invoice/:id'?'policy allow/deny matrix; MySQL authorized invoice/persisted-row/foreign-order isolation + missing-record redirect; unauthenticated and zero-grant HTTP denials':`policy allow/deny matrix; MySQL zero-grant direct HTTP sweep (${r.method} ${r.path})`;
  const auditRequirement=audit(r.method,r.path,p,r);
  const status=p.unmapped||auditRequirement.startsWith('NO AUDIT')?'BLOCKED':'COMPLETE';
  out.push(`| ${r.method} | \`${r.path}\` | ${auth} | \`${permission}\` | ${risk(r.method,r.path)} | ${auditRequirement} | ${test} | ${status} |`);
}
out.push('');
out.push('## Owner decisions still required');
out.push('');
out.push('- Approve which operational role/user receives each permission key. The migration inserts definitions only and grants none. Minimum grant matrix is recorded in `PHASE_09_ADMIN_DASHBOARD_USERS_PERMISSIONS.md`.');
out.push('- Decide audit retention/archival duration and any lawful erasure workflow. No retention period, automated deletion, or archive policy is implemented.');
out.push('- Confirm whether vendor/reseller administrative access should remain global platform scope or be further separated by tenant/partner. Current model provides global privileged administration.');
fs.writeFileSync(path.join(__dirname,'../docs/PHASE_09_LEGACY_ADMIN_ROUTE_INVENTORY.md'),out.join('\n')+'\n');
console.log(`Wrote inventory for ${routes.length} routes (${Object.entries(methods).map(([m,n])=>`${m}:${n}`).join(', ')}).`);
