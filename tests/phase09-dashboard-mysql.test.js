'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const SKIP = 'SKIPPED locally: no local mysqld/docker; required on GitHub Actions mysql:8.0 service';
if (REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true but MYSQL_TEST_HOST is missing.');
process.env.NODE_ENV = 'test'; process.env.LOG_SILENT = 'true';
if (MYSQL_HOST) {
  process.env.DB_CLIENT = 'mysql'; process.env.DB_HOST = MYSQL_HOST;
  process.env.DB_PORT = String(process.env.MYSQL_TEST_PORT || 3306);
  process.env.DB_NAME = process.env.MYSQL_TEST_DB || 'mrtumi_test';
  process.env.DB_USER = process.env.MYSQL_TEST_USER || 'mrtumi_test';
  process.env.DB_PASSWORD = process.env.MYSQL_TEST_PASSWORD || 'mrtumi_test_pw';
}
const { getPool, createQueryClient, closePool } = require('../src/db/mysqlPool');
const { migrateUp, migrateDown } = require('../src/db/migrator');
const dashboardRepo = require('../src/repositories/adminDashboardRepository');
const { policyForAdminRoute } = require('../src/middleware/legacyAdminRbac');
const { collectAdminRoutes,concretePath } = require('./helpers/adminRouteInventory');
const { startServer } = require('../server');

describe('Phase 09 — full-stack MySQL 8.0 dashboard, admin access, RBAC & audit HTTP', { skip: !MYSQL_HOST && !REQUIRED ? SKIP : false }, () => {
  let pool, db, server, baseUrl, dashboardCookie, csrfToken, productId, invoiceOrderId, dashboardUserId, limitedUserId, managerUserId, noGrantUserId, fullEmail='', limitedEmail='', managerEmail='', noGrantEmail='';
  const password = 'Phase09IntegrationPassword!2026';
  const roleIds = {};
  const permissionNames = ['dashboard.view','orders.poll','orders.popup.view','orders.popup.dismiss','assistant.report','staff.manage','staff.assign_role','roles.manage','roles.grants.manage','audit_logs.view','orders.manage','refunds.review','checkout.recovery.view','checkout.recovery.manage','catalog.view','catalog.manage','inventory.manage','content.manage','customers.manage','security.manage','hr.manage','finance.view','finance.manage','vendors.manage','resellers.manage','delivery.manage','settings.manage','integrations.manage','communications.send','analytics.view','reports.view','error_logs.view','error_logs.manage'];
  const day = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit',day:'2-digit' }).format(day);

  before(async () => {
    if (!MYSQL_HOST) return;
    pool = getPool(); db = createQueryClient(pool);
    await migrateDown(pool,{steps:10}); await migrateUp(pool);
    const permissions = await db.queryAll(`SELECT id,name FROM permissions WHERE name IN (${permissionNames.map(()=>'?').join(',')})`,permissionNames);
    assert.equal(permissions.length,permissionNames.length,'0008 permission catalog is applied');
    const preexistingGrants=await db.queryOne(`SELECT COUNT(*) AS n FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.name IN (${permissionNames.map(()=>'?').join(',')})`,permissionNames);
    assert.equal(Number(preexistingGrants.n),0,'migration does not assign permission grants to any pre-existing role');
    const grantSet = new Set(permissionNames);
    for (const [slug,grants] of [['p09_full', [...grantSet]],['p09_limited',['dashboard.view']],['p09_manager',['dashboard.view','staff.manage','roles.manage']],['p09_no_grants',[]]]) {
      const role=(await db.execute('INSERT INTO roles(name,slug,status) VALUES(?,?,1)',[`P09 ${slug} ${Date.now()}`,`${slug}_${Date.now()}`])).insertId;
      roleIds[slug]=Number(role);
      for (const key of grants) {
        const permission=permissions.find((p)=>p.name===key);
        await db.execute('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?)',[role,permission.id]);
      }
    }
    const fullRole=await db.queryOne('SELECT slug FROM roles WHERE id=?',[roleIds.p09_full]);
    const limitedRole=await db.queryOne('SELECT slug FROM roles WHERE id=?',[roleIds.p09_limited]);
    fullEmail=`p09-dashboard-${Date.now()}@example.invalid`; limitedEmail=`p09-limited-${Date.now()}@example.invalid`; managerEmail=`p09-manager-${Date.now()}@example.invalid`; noGrantEmail=`p09-deny-${Date.now()}@example.invalid`;
    dashboardUserId=Number((await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[roleIds.p09_full,'P09 dashboard admin',fullEmail,'01711112222',bcrypt.hashSync(password,8),'Staff'])).insertId);
    limitedUserId=Number((await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[roleIds.p09_limited,'P09 limited admin',limitedEmail,'01711113333',bcrypt.hashSync(password,8),'Staff'])).insertId);
    managerUserId=Number((await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[roleIds.p09_manager,'P09 access manager',managerEmail,'01711114444',bcrypt.hashSync(password,8),'Staff'])).insertId);
    noGrantUserId=Number((await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[roleIds.p09_no_grants,'P09 no-grant staff',noGrantEmail,'01711115555',bcrypt.hashSync(password,8),'Staff'])).insertId);
    // Verify the authentication repository's real grant resolution, not a fabricated session permission array.
    const {findActiveAdminById}=require('../src/repositories/authRepository');
    const fullActor=await findActiveAdminById(dashboardUserId);
    assert.equal(fullActor.role_slug,fullRole.slug); assert.ok(permissionNames.every((key)=>fullActor.permissions.includes(key)));
    assert.equal((await findActiveAdminById(limitedUserId)).role_slug,limitedRole.slug);
    assert.deepEqual((await findActiveAdminById(noGrantUserId)).permissions,[]);

    const suffix=Date.now();
    const cat=await db.execute("INSERT INTO categories(name_bn,name_en,slug,status) VALUES('ড্যাশবোর্ড','Dashboard',?,1)",[`p09-dash-${suffix}`]);
    productId=Number((await db.execute("INSERT INTO products(sku,slug,name_bn,name_en,category_id,regular_price_paisa,sale_price_paisa,stock_on_hand,stock_reserved,approval_status,status) VALUES(?,?,?,?,?,12000,10000,9,2,'approved',1)",[ `P09-${suffix}`,`p09-dash-product-${suffix}`,'পরীক্ষা','Dashboard product',cat.insertId])).insertId);
    await db.execute("INSERT INTO order_statuses(name,slug,badge_class,color,sort_order,status) VALUES('Completed','completed','sb-2','#00aa00',1,1) ON DUPLICATE KEY UPDATE name=VALUES(name)");
    const orderId=Number((await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 fixture','01712345678','Test address',10000,10000,0,10000,'completed','phase09-test',UTC_TIMESTAMP())",[`P09-${suffix}`])).insertId); invoiceOrderId=orderId;
    const courierCode=`p09-courier-${suffix}`;
    const courierName='P09 Test Courier';
    await db.execute('INSERT INTO courier_apis(name,code,status) VALUES(?,?,1)',[courierName,courierCode]);
    const riderId=Number((await db.execute("INSERT INTO delivery_boys(name,phone,status) VALUES('P09 Test Rider','01711116666',1)")).insertId);
    await db.execute('UPDATE orders SET courier_code=?,courier_tracking_id=?,delivery_boy_id=?,shipping_zone=?,customer_note=?,admin_note=?,coupon_code=? WHERE id=?',[courierCode,`P09-TRACK-${suffix}`,riderId,'Inside Dhaka','P09 customer note','P09 internal note','P09COUPON',orderId]);
    await db.execute("INSERT INTO order_payments(order_id,gateway_code,provider_trx_id,sender_number,amount_paisa,status) VALUES(?, 'p09-test',?,?,10000,'pending')",[orderId,`P09-TRX-${suffix}`,'01799990000']);
    const {start:dayStart,end:dayEnd}=dashboardRepo.dhakaDayUtcBounds(today);
    for(const [invoice,status,source,paisa,created] of [[`P09-start-${suffix}`,'pending','phase09-boundary',1200,dayStart],[`P09-end-${suffix}`,'pending','phase09-after-day',1300,dayEnd],[`P09-cancel-${suffix}`,'cancelled','phase09-cancelled',1400,dayStart]])
      await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 boundary','01712345678','Test address',?,?,0,?,?,?,?)",[invoice,paisa,paisa,paisa,status,source,created]);
    await db.execute('INSERT INTO order_items(order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES(?,?,?,10000,1,10000)',[orderId,productId,'Dashboard product']);
    const unrelatedOrder=Number((await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,order_status,created_at) VALUES(?, 'P09 unrelated','01712345679','Other address',5000,5000,'pending','2000-01-01 00:00:00')",[`P09-OTHER-${suffix}`])).insertId);
    await db.execute('INSERT INTO order_items(order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES(?,?,?,5000,1,5000)',[unrelatedOrder,productId,'Unrelated invoice sentinel']);
    await db.execute("INSERT INTO fund_transactions(account_name,tx_type,amount_paisa,note,tx_date) VALUES('test','credit',2500,'fixture',?)",[today]);
    await db.execute("INSERT INTO expenses(title,category,amount_paisa,note,expense_date) VALUES('test','test',500,'fixture',?)",[today]);
    server=startServer(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
    baseUrl=`http://127.0.0.1:${server.address().port}`;
    dashboardCookie=await login(fullEmail);
  });
  after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(MYSQL_HOST)await closePool();});

  async function request(path,{method='GET',cookie=dashboardCookie,body=null,token=csrfToken,accept='application/json'}={}){
    const headers={accept}; if(cookie)headers.cookie=cookie;
    if(body!==null){headers['content-type']='application/json';}
    if(token)headers['x-csrf-token']=token;
    const response=await fetch(`${baseUrl}${path}`,{method,headers,body:body===null?undefined:JSON.stringify(body),redirect:'manual'});
    const text=await response.text(); let json=null; try{json=JSON.parse(text);}catch{}
    return {status:response.status,headers:response.headers,text,json};
  }
  async function login(email,passwordValue=password){
    const loginPage=await fetch(`${baseUrl}/admin/login`,{headers:{accept:'text/html'},redirect:'manual'});
    const loginCookie=(loginPage.headers.get('set-cookie')||'').split(';')[0];
    const csrfResponse=await fetch(`${baseUrl}/api/v1/csrf-token`,{headers:{cookie:loginCookie,accept:'application/json'}});
    const csrfJson=await csrfResponse.json();
    const response=await fetch(`${baseUrl}/admin/login`,{method:'POST',headers:{accept:'text/html','content-type':'application/x-www-form-urlencoded',cookie:loginCookie,'x-csrf-token':csrfJson.data.csrfToken},body:new URLSearchParams({email,password:passwordValue}).toString(),redirect:'manual'});
    const body=await response.text();
    assert.equal(response.status,302,`real admin password login should redirect (received ${response.status}: ${body.slice(0,240)})`);
    const cookie=(response.headers.get('set-cookie')||'').split(';')[0]; assert.ok(cookie); return cookie;
  }
  async function fetchCsrf(cookie){const r=await request('/api/v1/csrf-token',{cookie});assert.equal(r.status,200);return r.json.data.csrfToken;}

  test('live repository preserves MySQL summaries, Dhaka boundaries, statuses, limits and paisa',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const data=await dashboardRepo.getDashboardData({now:new Date()});
    assert.ok(data.totalOrders>=4); assert.ok(data.pendingOrders>=2); assert.equal(data.todayOrders,2);
    assert.ok(data.todayRevenue>=112); assert.ok(data.deliveredCount>=1); assert.ok(data.totalRevenue>=100);
    assert.ok(data.dashboardProducts.some(p=>p.id===productId&&p.stock===7&&p.new_price===100));
    assert.ok(data.statusBreakdown.some(s=>s.name==='Completed'&&s.cnt>=1));
    assert.equal(data.trendData.length,7); assert.ok(data.recentOrders.length<=8);
    assert.ok(data.trafficSources.some(s=>s.source==='phase09-test'));
    assert.ok(data.todayExpenses>=5); assert.ok(data.totalExpenses>=data.todayExpenses);
  });

  test('real application routes enforce role grants, CSRF, safe errors, provider unavailable, popup audit and assistant audit',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    assert.equal((await request('/admin/dashboard',{cookie:''})).status,401);
    const limited=await login(limitedEmail); const limitedCsrf=await fetchCsrf(limited);
    const limitedDashboard=await request('/admin/dashboard',{cookie:limited});
    assert.equal(limitedDashboard.status,200);
    assert.doesNotMatch(limitedDashboard.text,/\/admin\/users\/manage/);
    assert.equal((await request('/admin/orders/poll-new?init=1',{cookie:limited})).status,403);
    assert.equal((await request('/admin/dashboard/new-orders-popup',{cookie:limited})).status,403);
    assert.equal((await request('/admin/gemini-chat/send',{method:'POST',cookie:limited,body:{message:'today orders'}})).status,403);
    assert.equal((await request('/admin/phase09/access/staff',{cookie:limited})).status,403);
    assert.equal((await request('/admin/phase09/access/roles',{cookie:limited})).status,403);

    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    const dashboard=await request('/admin/dashboard'); assert.equal(dashboard.status,200);
    assert.match(dashboard.text,/পরীক্ষা/); assert.match(dashboard.text,/Order Status/);
    assert.match(dashboard.text,/\/admin\/users\/manage/); assert.match(dashboard.text,/\/admin\/audit-logs/);
    assert.equal((await request('/admin/products/create',{method:'POST',token:'',body:{}})).status,403,'global legacy-admin CSRF gate rejects a direct URL write');
    assert.equal((await request('/admin/clear-cache',{method:'GET'})).status,405,'legacy state-changing GET has been removed');
    const poll=await request('/admin/orders/poll-new?init=1'); assert.equal(poll.status,200); assert.equal(poll.json.init,true);
    const popup=await request('/admin/dashboard/new-orders-popup'); assert.equal(popup.status,200); assert.ok(Array.isArray(popup.json.orders));
    assert.equal((await request('/admin/dashboard/dismiss-new-orders-popup',{method:'POST',token:'',body:{}})).status,403);
    const dismiss=await request('/admin/dashboard/dismiss-new-orders-popup',{method:'POST',body:{}}); assert.equal(dismiss.status,200);
    assert.equal((await request('/admin/gemini-chat/send',{method:'POST',token:'',body:{message:'today orders'}})).status,403);
    assert.equal((await request('/admin/gemini-chat/send',{method:'POST',body:{message:'  '}})).status,400);
    const assistant=await request('/admin/gemini-chat/send',{method:'POST',body:{message:'today orders'}}); assert.equal(assistant.status,200); assert.equal(assistant.json.success,true);
    const assistantClear=await request('/admin/gemini-chat/clear',{method:'POST',body:{}});assert.equal(assistantClear.status,200);
    for(const path of ['/admin/smsgeteway/balance','/admin/bdcourier/my-plan','/admin/steadfast/dashboard-widget']){
      const response=await request(path); assert.equal(response.status,503); assert.equal(response.json.status,'unavailable'); assert.equal(response.json.success,false);
    }
    const audit=await db.queryAll("SELECT action,after_json FROM audit_logs WHERE actor_id=? AND action IN ('admin.dashboard.popup.dismissed','admin.assistant.report','admin.assistant.context.cleared') ORDER BY id",[dashboardUserId]);
    assert.ok(audit.some(r=>r.action==='admin.dashboard.popup.dismissed'));
    assert.ok(audit.some(r=>r.action==='admin.assistant.report'));
    assert.ok(audit.some(r=>r.action==='admin.assistant.context.cleared'));
    const promptLeak=await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id=? AND action='admin.assistant.report' AND JSON_SEARCH(after_json,'one','%today orders%') IS NOT NULL",[dashboardUserId]);
    assert.equal(Number(promptLeak.n),0,'assistant audit stores intent only, not customer/user prompt text');
    assert.equal((await request('/admin/audit-logs',{cookie:''})).status,401);
    assert.equal((await request('/admin/audit-logs',{cookie:limited})).status,403);
    assert.equal((await request('/admin/audit-logs')).status,200);
    assert.equal((await request('/admin/audit-logs',{method:'DELETE'})).status,404);
    const auditRow=await db.queryOne("SELECT id,action FROM audit_logs WHERE actor_id=? AND action='admin.assistant.report' ORDER BY id DESC LIMIT 1",[dashboardUserId]);
    assert.ok(auditRow,'assistant action is audited before testing append-only protection');
    const updateRoute=await request(`/admin/audit-logs/${auditRow.id}`,{method:'PUT',body:{action:'tampered'}});
    const deleteRoute=await request(`/admin/audit-logs/${auditRow.id}`,{method:'DELETE'});
    assert.equal(updateRoute.status,404);assert.equal(deleteRoute.status,404);
    await assert.rejects(db.execute("UPDATE audit_logs SET action='tampered' WHERE id=?",[auditRow.id]),err=>err.mysqlCode==='ER_SIGNAL_EXCEPTION'||err.code==='ER_SIGNAL_EXCEPTION'||Number(err.errno)===1644);
    await assert.rejects(db.execute('DELETE FROM audit_logs WHERE id=?',[auditRow.id]),err=>err.mysqlCode==='ER_SIGNAL_EXCEPTION'||err.code==='ER_SIGNAL_EXCEPTION'||Number(err.errno)===1644);
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM audit_logs WHERE id=?',[auditRow.id])).n),1,'UPDATE and DELETE triggers preserve historical events');
    const triggerCount=await db.queryOne("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('trg_audit_logs_no_update','trg_audit_logs_no_delete')");
    assert.equal(Number(triggerCount.n),2);
  });

  test('legacy printable order invoice reads canonical MySQL rows with existing auth and redirect contracts',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    assert.equal((await request(`/admin/order/invoice/${invoiceOrderId}`,{cookie:''})).status,401,'invoice requires an authenticated admin');
    const noGrantCookie=await login(noGrantEmail);
    assert.equal((await request(`/admin/order/invoice/${invoiceOrderId}`,{cookie:noGrantCookie})).status,403,'invoice requires orders.manage');
    const persisted=await db.queryOne('SELECT invoice_no,customer_name,customer_phone,total_paisa FROM orders WHERE id=?',[invoiceOrderId]);
    const response=await request(`/admin/order/invoice/${invoiceOrderId}`,{accept:'text/html'});
    assert.equal(response.status,200);
    assert.match(response.text,new RegExp(`INVOICE #${persisted.invoice_no}`));
    assert.match(response.text,new RegExp(persisted.customer_name));
    assert.match(response.text,new RegExp(persisted.customer_phone));
    assert.match(response.text,/Dashboard product/);
    assert.doesNotMatch(response.text,/Unrelated invoice sentinel/,'invoice line query must not leak another order’s items');
    assert.match(response.text,/৳100\.00/);
    const missing=await request('/admin/order/invoice/999999999',{accept:'text/html'});
    assert.equal(missing.status,302); assert.equal(missing.headers.get('location'),'/admin/order/all');
    const invalid=await request('/admin/order/invoice/not-a-number',{accept:'text/html'});
    assert.equal(invalid.status,302); assert.equal(invalid.headers.get('location'),'/admin/order/all');
  });

  test('legacy order detail renders related MySQL data, preserves mark-seen, and handles denial/missing/error cases',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    // Earlier dashboard popup coverage intentionally marks every unseen order as seen.
    // Reset only this disposable fixture, preserving updated_at, to isolate the detail-route behavior.
    await db.execute('UPDATE orders SET is_seen=0,updated_at=updated_at WHERE id=?',[invoiceOrderId]);
    const before=await db.queryOne('SELECT invoice_no,is_seen,updated_at FROM orders WHERE id=?',[invoiceOrderId]);
    assert.equal(Number(before.is_seen),0,'detail fixture begins unseen');
    assert.equal((await request(`/admin/order/view/${invoiceOrderId}`,{cookie:''})).status,401,'order detail requires an authenticated admin');
    const noGrantCookie=await login(noGrantEmail);
    assert.equal((await request(`/admin/order/view/${invoiceOrderId}`,{cookie:noGrantCookie,accept:'text/html'})).status,403,'order detail requires orders.manage');
    const deniedSeen=await db.queryOne('SELECT is_seen FROM orders WHERE id=?',[invoiceOrderId]);
    assert.equal(Number(deniedSeen.is_seen),0,'authentication and permission denials do not acknowledge the order');
    const persistedItems=await db.queryAll('SELECT id,product_name FROM order_items WHERE order_id=? ORDER BY id ASC',[invoiceOrderId]);
    const response=await request(`/admin/order/view/${invoiceOrderId}`,{accept:'text/html'});
    assert.equal(response.status,200,'authorized detail request renders HTML');
    const heading=response.text.match(/<h4 id="order-detail-heading"[^>]*>([\s\S]*?)<\/h4>/)?.[1]||'';
    assert.match(heading,new RegExp(`#${before.invoice_no}`));
    assert.match(heading,/Completed/);

    const itemContainer=response.text.match(/<tbody id="order-detail-items">([\s\S]*?)<\/tbody>/)?.[1];
    assert.ok(itemContainer,'detail view exposes a scoped item container');
    const renderedItemIds=[...itemContainer.matchAll(/data-order-item-id="(\d+)"/g)].map((match)=>Number(match[1]));
    assert.deepEqual(renderedItemIds,persistedItems.map((item)=>Number(item.id)),'every rendered item belongs to the requested persisted order, in item-ID order');
    assert.match(itemContainer,/Dashboard product/);
    assert.doesNotMatch(itemContainer,/Unrelated invoice sentinel/,'a different order item must not appear in this detail container');

    const orderFields=response.text.match(/<form id="order-detail-fields"[\s\S]*?<\/form>/)?.[0]||'';
    assert.match(orderFields,/name="customer_name" value="P09 fixture"/);
    assert.match(orderFields,/name="phone" value="01712345678"/);
    assert.match(orderFields,/P09 internal note/);
    assert.match(orderFields,/P09 Test Courier/);
    assert.match(orderFields,/P09-TRACK-/);
    assert.match(orderFields,/P09 Test Rider/);
    const paymentDetails=response.text.match(/<div id="order-detail-payment"[^>]*>([\s\S]*?)<\/div>/)?.[1]||'';
    assert.match(paymentDetails,/P09-TRX-/);
    assert.match(paymentDetails,/01799990000/);
    assert.match(paymentDetails,/P09 customer note/);
    const totals=response.text.match(/<div id="order-detail-totals"[^>]*>([\s\S]*?)<\/div>/)?.[1]||'';
    assert.match(totals,/100\.00/,'integer-paisa totals are formatted at the view boundary');
    const productOptions=response.text.match(/<form id="order-detail-product-options"[\s\S]*?<\/form>/)?.[0]||'';
    assert.match(productOptions,/Dashboard product — ৳100\.00/,'active product choice uses the canonical product projection');

    const seen=await db.queryOne('SELECT is_seen,updated_at FROM orders WHERE id=?',[invoiceOrderId]);
    assert.equal(Number(seen.is_seen),1,'opening the detail page preserves the legacy is_seen acknowledgement');
    assert.equal(String(seen.updated_at),String(before.updated_at),'read tracking does not change the order business updated_at timestamp');
    for(const invalidId of ['not-a-number','-1','999999999']){
      const missing=await request(`/admin/order/view/${invalidId}`,{accept:'text/html'});
      assert.equal(missing.status,302,`invalid/nonexistent order ${invalidId} redirects`);
      assert.equal(missing.headers.get('location'),'/admin/order/all');
    }

    const originalQuery=pool.query; const hadOwnQuery=Object.hasOwn(pool,'query');
    pool.query=function(sql,...args){
      if(String(sql).includes('FROM orders o')&&String(sql).includes('o.invoice_no AS invoice_id')){
        const forced=new Error('forced order-detail database failure'); forced.code='ER_ACCESS_DENIED_ERROR';
        return Promise.reject(forced);
      }
      return originalQuery.call(this,sql,...args);
    };
    let failed;
    try{failed=await request(`/admin/order/view/${invoiceOrderId}`,{accept:'application/json'});}
    finally{if(hadOwnQuery)pool.query=originalQuery;else delete pool.query;}
    assert.equal(failed.status,503);
    assert.equal(failed.json.ok,false);
    assert.equal(failed.json.error.code,'DB_CONNECTION_FAILED');
    assert.doesNotMatch(failed.text,/forced order-detail database failure|SELECT |password|01712345678/i,'DB failure response must not disclose SQL or customer data');
  });

  test('legacy status-filtered order list uses MySQL with search, status counts and safe failure handling',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const invoice=await db.queryOne('SELECT invoice_no FROM orders WHERE id=?',[invoiceOrderId]);
    const encodedInvoice=encodeURIComponent(invoice.invoice_no);
    assert.equal((await request(`/admin/order/completed?q=${encodedInvoice}`,{cookie:''})).status,401,'order list requires authentication');
    const noGrantCookie=await login(noGrantEmail);
    assert.equal((await request(`/admin/order/completed?q=${encodedInvoice}`,{cookie:noGrantCookie})).status,403,'order list requires orders.manage');

    const completed=await request(`/admin/order/completed?q=${encodedInvoice}`,{accept:'text/html'});
    assert.equal(completed.status,200);
    assert.match(completed.text,new RegExp(`#${invoice.invoice_no}`));
    assert.match(completed.text,/P09 fixture/);
    assert.match(completed.text,/৳100/);
    const orderTable=completed.text.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]||'';
    assert.match(orderTable,new RegExp(`#${invoice.invoice_no}`));
    assert.doesNotMatch(orderTable,/P09 unrelated/,'filtered order table must exclude another customer/order; global pending notifications are outside this table');
    const renderedOrderIds=[...orderTable.matchAll(/href="\/admin\/order\/view\/(\d+)"/g)].map((match)=>match[1]);
    assert.deepEqual([...new Set(renderedOrderIds)],[String(invoiceOrderId)],'filtered table must contain only the matching persisted order');
    assert.match(completed.text,/Completed/);
    const customerSearch=await request('/admin/order/all?q=P09%20fixture',{accept:'text/html'});
    assert.equal(customerSearch.status,200); assert.match(customerSearch.text,new RegExp(`#${invoice.invoice_no}`));
    const phoneSearch=await request('/admin/order/completed?q=01712345678',{accept:'text/html'});
    assert.equal(phoneSearch.status,200); assert.match(phoneSearch.text,new RegExp(`#${invoice.invoice_no}`));

    const pending=await request(`/admin/order/pending?q=${encodedInvoice}`,{accept:'text/html'});
    assert.equal(pending.status,200);
    assert.doesNotMatch(pending.text,new RegExp(`#${invoice.invoice_no}`),'status filter excludes a matching invoice in another status');
    const unpaid=await request(`/admin/order/unpaid?q=${encodedInvoice}`,{accept:'text/html'});
    assert.equal(unpaid.status,200);
    assert.match(unpaid.text,new RegExp(`#${invoice.invoice_no}`),'unpaid filter includes payment_status=unpaid even when order status is completed');

    const ordered=await request('/admin/order/all?q=P09-',{accept:'text/html'});
    assert.equal(ordered.status,200);
    const expectedOrder=await db.queryAll("SELECT id FROM orders WHERE invoice_no LIKE ? ORDER BY id DESC",['P09-%']);
    const orderedTable=ordered.text.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]||'';
    const renderedRows=[...orderedTable.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([row])=>Number(row.match(/name="order_ids" value="(\d+)"/)?.[1])).filter(Number.isSafeInteger);
    assert.deepEqual(renderedRows,expectedOrder.map((row)=>Number(row.id)),'legacy order list remains complete and sorted by descending order ID');

    const all=await request('/admin/order/all?q=%27%20OR%201%3D1%20--',{accept:'text/html'});
    assert.equal(all.status,200);
    assert.match(all.text,/কোনো অর্ডার পাওয়া যায়নি/,'search text is bound as data, not interpreted as SQL');
    const invalidStatus=await request('/admin/order/not-a-real-status',{accept:'text/html'});
    assert.equal(invalidStatus.status,200);
    assert.match(invalidStatus.text,/কোনো অর্ডার পাওয়া যায়নি/,'unknown legacy status preserves the existing empty-list behavior');

    const originalQuery=pool.query; const hadOwnQuery=Object.hasOwn(pool,'query');
    pool.query=function(sql,...args){
      if(String(sql).includes('FROM orders o')){
        const forced= new Error('forced order-list database failure'); forced.code='ER_ACCESS_DENIED_ERROR';
        return Promise.reject(forced);
      }
      return originalQuery.call(this,sql,...args);
    };
    let failed;
    try { failed=await request('/admin/order/all',{accept:'application/json'}); }
    finally { if(hadOwnQuery)pool.query=originalQuery; else delete pool.query; }
    assert.equal(failed.status,503);
    assert.equal(failed.json.ok,false);
    assert.equal(failed.json.error.code,'DB_CONNECTION_FAILED');
    assert.doesNotMatch(failed.text,/forced order-list database failure|SELECT |password/i,'sanitized HTTP error must not disclose SQL or driver details');
  });

  test('legacy general settings save uses transactional MySQL persistence and value-free audit',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const key=`p09_route_setting_${Date.now()}`;
    const secret='phase09-sensitive-test-value';
    assert.equal((await request('/admin/settings/save',{method:'POST',cookie:dashboardCookie,token:'',body:{[key]:secret,_redirect:'/admin/settings/manage'}})).status,403,'settings writes require CSRF');
    const noGrantCookie=await login(noGrantEmail); const noGrantCsrf=await fetchCsrf(noGrantCookie);
    assert.equal((await request('/admin/settings/save',{method:'POST',cookie:noGrantCookie,token:noGrantCsrf,body:{[key]:secret}})).status,403,'settings writes require settings.manage');
    try {
      const response=await request('/admin/settings/save',{method:'POST',body:{[key]:secret,_redirect:'/admin/settings/manage'}});
      assert.equal(response.status,302); assert.equal(response.headers.get('location'),'/admin/settings/manage');
      const stored=await db.queryOne('SELECT setting_value FROM settings WHERE setting_key=?',[key]);
      assert.equal(stored.setting_value,secret);
      const audit=await db.queryOne("SELECT action,entity_type,after_json FROM audit_logs WHERE actor_id=? AND action='admin.settings.updated' AND entity_id='legacy_form' ORDER BY id DESC LIMIT 1",[dashboardUserId]);
      assert.ok(audit); assert.equal(audit.entity_type,'settings');
      assert.deepEqual(JSON.parse(audit.after_json).keys,[key]);
      assert.doesNotMatch(audit.after_json, new RegExp(secret));
    } finally {
      await db.execute('DELETE FROM settings WHERE setting_key=?',[key]);
    }
  });

  test('all unique non-exempt legacy admin method/path pairs deny a logged-in zero-grant staff account',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const deniedCookie=await login(noGrantEmail);
    const routes=collectAdminRoutes().filter(r=>!policyForAdminRoute(r.method,r.path).exempt);
    assert.ok(routes.length>=240,'inventory covers every unique non-exempt active admin endpoint plus dynamic settings pages');
    const unmapped=routes.filter(r=>policyForAdminRoute(r.method,r.path).unmapped);
    assert.deepEqual(unmapped,[],'every registered legacy route has a named policy');
    for(const route of routes){
      const target=concretePath(route.path);
      const response=await request(target,{method:route.method,cookie:deniedCookie,token:'',body:['POST','PUT','PATCH','DELETE'].includes(route.method)?{}:null});
      assert.equal(response.status,403,`${route.method} ${route.path} must be denied to zero-grant staff`);
    }
  });

  test('MySQL role/staff lifecycle validates, audits, avoids hard deletion and revokes sessions',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const role=await request('/admin/phase09/access/roles',{cookie:dashboardCookie}); assert.equal(role.status,200);
    const createdRole=await request('/admin/phase09/access/roles',{method:'POST',body:{name:'P09 Least Privilege',slug:`p09_test_${Date.now()}`}});
    assert.equal(createdRole.status,201); const roleId=createdRole.json.data.id;
    const managerCookie=await login(managerEmail); const managerCsrf=await fetchCsrf(managerCookie);
    const managerStaffPage=await request('/admin/users/manage',{cookie:managerCookie,accept:'text/html'});
    assert.equal(managerStaffPage.status,200); assert.doesNotMatch(managerStaffPage.text,/name="password"/);
    assert.equal((await request('/admin/phase09/access/staff',{method:'POST',cookie:managerCookie,token:managerCsrf,body:{name:'Should not create',email:`deny-${Date.now()}@example.invalid`,password:'ValidPhase09Password!2026',roleId}})).status,403);
    assert.equal((await request(`/admin/phase09/access/roles/${roleId}/permissions`,{method:'PUT',cookie:managerCookie,token:managerCsrf,body:{permissions:['dashboard.view']}})).status,403,'role managers cannot grant permissions without the separate grant-management key');
    assert.equal((await request(`/admin/phase09/access/roles/${roleId}/permissions`,{method:'PUT',body:{permissions:['admin.nonexistent']}})).status,400,'permission grant allow-list rejects undefined keys');
    const grant=await request(`/admin/phase09/access/roles/${roleId}/permissions`,{method:'PUT',body:{permissions:['dashboard.view']}});
    assert.equal(grant.status,200); assert.deepEqual(grant.json.data.permissions,['dashboard.view']);
    const token=csrfToken;
    const staffEmail=`p09-staff-${Date.now()}@example.invalid`;
    const createdStaff=await request('/admin/phase09/access/staff',{method:'POST',body:{name:'P09 Test Staff',email:staffEmail,phone:'01712345678',password:'ValidPhase09Password!2026',roleId}});
    assert.equal(createdStaff.status,201); assert.equal(Object.hasOwn(createdStaff.json.data,'password_hash'),false);
    const persistedStaff=await db.queryOne('SELECT email,status,role_id,password_hash FROM users WHERE id=?',[createdStaff.json.data.id]);
    assert.equal(persistedStaff.email,staffEmail.toLowerCase()); assert.equal(Number(persistedStaff.status),1); assert.equal(Number(persistedStaff.role_id),Number(roleId));
    assert.equal(await bcrypt.compare('ValidPhase09Password!2026',persistedStaff.password_hash),true,'new staff password must be bcrypt-verifiable');
    const auditFailureEmail=`p09-audit-fail-${Date.now()}@example.invalid`;
    await db.execute("CREATE TRIGGER p09_test_fail_audit_insert BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture audit failure'");
    let failedCreate;
    try{failedCreate=await request('/admin/phase09/access/staff',{method:'POST',body:{name:'Audit failure fixture',email:auditFailureEmail,password:'ValidPhase09Password!2026',roleId}});}
    finally{await db.execute('DROP TRIGGER p09_test_fail_audit_insert');}
    assert.equal(failedCreate.status,500,'transaction-backed staff mutation fails when its required audit insert fails');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM users WHERE email=?',[auditFailureEmail])).n),0,'failed audit insert rolls back the staff row');
    const selfDisable=await request(`/admin/phase09/access/staff/${dashboardUserId}`,{method:'PATCH',body:{status:0}}); assert.equal(selfDisable.status,409);
    const badSlug=await request('/admin/phase09/access/roles',{method:'POST',body:{name:'Bad role',slug:'not allowed'}}); assert.equal(badSlug.status,400);
    const next=await request(`/admin/phase09/access/roles/${roleId}/permissions`,{method:'PUT',body:{permissions:['dashboard.view','assistant.report']}}); assert.equal(next.status,200);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=?',[roleId])).n,2);
    const newStaffCookie=await login(staffEmail,'ValidPhase09Password!2026');
    const deactivate=await request(`/admin/phase09/access/staff/${createdStaff.json.data.id}`,{method:'PATCH',cookie:dashboardCookie,body:{status:0}}); assert.equal(deactivate.status,200);
    assert.equal((await request('/admin/dashboard',{cookie:newStaffCookie})).status,401,'deactivation deletes database-backed sessions and blocks the next request');
    const accessAudit=await db.queryAll("SELECT action,after_json FROM audit_logs WHERE entity_type IN ('admin_user','role') ORDER BY id DESC LIMIT 20");
    assert.ok(accessAudit.some(r=>r.action==='admin.staff.created'));
    assert.ok(accessAudit.some(r=>r.action==='admin.staff.deactivated'));
    const grantsBefore=Number((await db.queryOne('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=?',[roleIds.p09_full])).n);
    const auditRowsBeforeRollback=Number((await db.queryOne('SELECT COUNT(*) AS n FROM audit_logs')).n);
    await db.execute('CREATE TRIGGER p09_unrelated_fixture BEFORE UPDATE ON orders FOR EACH ROW SET @p09_unrelated_fixture=NEW.id');
    try{
      // Migration 0010 now sits above 0009, so roll back both to exercise 0009's trigger cleanup.
      assert.equal((await migrateDown(pool,{steps:2})).length,2);
      const attributionColumnsAfterDown=await db.queryOne("SELECT COUNT(*) AS n FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME IN ('analytics_consent_at','analytics_consent_version')");
      assert.equal(Number(attributionColumnsAfterDown.n),0,'0010 rollback removes only its nullable consent columns');
      const triggersAfterDown=await db.queryOne("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('trg_audit_logs_no_update','trg_audit_logs_no_delete')");
      assert.equal(Number(triggersAfterDown.n),0,'0009 rollback removes its two audit triggers');
      assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='p09_unrelated_fixture'")).n),1,'0009 rollback preserves an unrelated trigger');
      assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM audit_logs')).n),auditRowsBeforeRollback,'0009 rollback never deletes audit history');
      const retained=await db.queryOne(`SELECT COUNT(*) AS n FROM permissions WHERE name IN (${permissionNames.map(()=>'?').join(',')})`,permissionNames);
      assert.equal(Number(retained.n),permissionNames.length,'down migration preserves catalog entries referenced by role grants');
      await migrateUp(pool);
      assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=?',[roleIds.p09_full])).n),grantsBefore);
      const attributionColumnsAfterReapply=await db.queryOne("SELECT COUNT(*) AS n FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME IN ('analytics_consent_at','analytics_consent_version')");
      assert.equal(Number(attributionColumnsAfterReapply.n),2,'migration reapplication restores both Phase 14 consent columns');
      const triggersAfterReapply=await db.queryOne("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('trg_audit_logs_no_update','trg_audit_logs_no_delete')");
      assert.equal(Number(triggersAfterReapply.n),2,'reapplying 0009 restores both audit triggers');
    }finally{await db.execute('DROP TRIGGER IF EXISTS p09_unrelated_fixture');}
    assert.equal((await request('/logout',{method:'POST',cookie:dashboardCookie,token:''})).status,403,'logout is a CSRF-protected POST');
    const logout=await request('/logout',{method:'POST',cookie:dashboardCookie,token:csrfToken});
    assert.equal(logout.status,302);assert.equal(logout.headers.get('location'),'/admin/login');
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id=? AND action='admin.logout'",[dashboardUserId])).n),1);
    assert.equal((await request('/admin/dashboard',{cookie:dashboardCookie})).status,401,'logout destroys the database-backed session');
    assert.ok(token);
  });
});
