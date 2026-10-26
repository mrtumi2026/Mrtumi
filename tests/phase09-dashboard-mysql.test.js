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
const { startServer } = require('../server');

describe('Phase 09 — full-stack MySQL 8.0 dashboard, admin access, RBAC & audit HTTP', { skip: !MYSQL_HOST && !REQUIRED ? SKIP : false }, () => {
  let pool, db, server, baseUrl, dashboardCookie, csrfToken, productId, dashboardUserId, limitedUserId, managerUserId, fullEmail='', limitedEmail='', managerEmail='';
  const password = 'Phase09IntegrationPassword!2026';
  const roleIds = {};
  const permissionNames = ['dashboard.view','orders.poll','orders.popup.view','orders.popup.dismiss','assistant.report','staff.manage','staff.assign_role','roles.manage','roles.grants.manage','audit_logs.view'];
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
    const grantSet = new Set(['dashboard.view','orders.poll','orders.popup.view','orders.popup.dismiss','assistant.report','staff.manage','staff.assign_role','roles.manage','roles.grants.manage','audit_logs.view']);
    for (const [slug,grants] of [['p09_full', [...grantSet]],['p09_limited',['dashboard.view']],['p09_manager',['dashboard.view','staff.manage','roles.manage']]]) {
      const role=(await db.execute('INSERT INTO roles(name,slug,status) VALUES(?,?,1)',[`P09 ${slug} ${Date.now()}`,`${slug}_${Date.now()}`])).insertId;
      roleIds[slug]=Number(role);
      for (const key of grants) {
        const permission=permissions.find((p)=>p.name===key);
        await db.execute('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?)',[role,permission.id]);
      }
    }
    const fullRole=await db.queryOne('SELECT slug FROM roles WHERE id=?',[roleIds.p09_full]);
    const limitedRole=await db.queryOne('SELECT slug FROM roles WHERE id=?',[roleIds.p09_limited]);
    fullEmail=`p09-dashboard-${Date.now()}@example.invalid`; limitedEmail=`p09-limited-${Date.now()}@example.invalid`; managerEmail=`p09-manager-${Date.now()}@example.invalid`;
    dashboardUserId=Number((await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[roleIds.p09_full,'P09 dashboard admin',fullEmail,'01711112222',bcrypt.hashSync(password,8),'Staff'])).insertId);
    limitedUserId=Number((await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[roleIds.p09_limited,'P09 limited admin',limitedEmail,'01711113333',bcrypt.hashSync(password,8),'Staff'])).insertId);
    managerUserId=Number((await db.execute('INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,?,?,?,1)',[roleIds.p09_manager,'P09 access manager',managerEmail,'01711114444',bcrypt.hashSync(password,8),'Staff'])).insertId);
    // Verify the authentication repository's real grant resolution, not a fabricated session permission array.
    const {findActiveAdminById}=require('../src/repositories/authRepository');
    const fullActor=await findActiveAdminById(dashboardUserId);
    assert.equal(fullActor.role_slug,fullRole.slug); assert.ok(permissionNames.every((key)=>fullActor.permissions.includes(key)));
    assert.equal((await findActiveAdminById(limitedUserId)).role_slug,limitedRole.slug);

    const suffix=Date.now();
    const cat=await db.execute("INSERT INTO categories(name_bn,name_en,slug,status) VALUES('ড্যাশবোর্ড','Dashboard',?,1)",[`p09-dash-${suffix}`]);
    productId=Number((await db.execute("INSERT INTO products(sku,slug,name_bn,name_en,category_id,regular_price_paisa,sale_price_paisa,stock_on_hand,stock_reserved,approval_status,status) VALUES(?,?,?,?,?,12000,10000,9,2,'approved',1)",[ `P09-${suffix}`,`p09-dash-product-${suffix}`,'পরীক্ষা','Dashboard product',cat.insertId])).insertId);
    await db.execute("INSERT INTO order_statuses(name,slug,badge_class,color,sort_order,status) VALUES('Completed','completed','sb-2','#00aa00',1,1) ON DUPLICATE KEY UPDATE name=VALUES(name)");
    const orderId=Number((await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 fixture','01712345678','Test address',10000,10000,0,10000,'completed','phase09-test',UTC_TIMESTAMP())",[`P09-${suffix}`])).insertId);
    const {start:dayStart,end:dayEnd}=dashboardRepo.dhakaDayUtcBounds(today);
    for(const [invoice,status,source,paisa,created] of [[`P09-start-${suffix}`,'pending','phase09-boundary',1200,dayStart],[`P09-end-${suffix}`,'pending','phase09-after-day',1300,dayEnd],[`P09-cancel-${suffix}`,'cancelled','phase09-cancelled',1400,dayStart]])
      await db.execute("INSERT INTO orders(invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,traffic_source,created_at) VALUES(?, 'P09 boundary','01712345678','Test address',?,?,0,?,?,?,?)",[invoice,paisa,paisa,paisa,status,source,created]);
    await db.execute('INSERT INTO order_items(order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES(?,?,?,10000,1,10000)',[orderId,productId,'Dashboard product']);
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
    const response=await fetch(`${baseUrl}/admin/login`,{method:'POST',headers:{accept:'text/html','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email,password:passwordValue}).toString(),redirect:'manual'});
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
    const poll=await request('/admin/orders/poll-new?init=1'); assert.equal(poll.status,200); assert.equal(poll.json.init,true);
    const popup=await request('/admin/dashboard/new-orders-popup'); assert.equal(popup.status,200); assert.ok(Array.isArray(popup.json.orders));
    assert.equal((await request('/admin/dashboard/dismiss-new-orders-popup',{method:'POST',token:'',body:{}})).status,403);
    const dismiss=await request('/admin/dashboard/dismiss-new-orders-popup',{method:'POST',body:{}}); assert.equal(dismiss.status,200);
    assert.equal((await request('/admin/gemini-chat/send',{method:'POST',token:'',body:{message:'today orders'}})).status,403);
    assert.equal((await request('/admin/gemini-chat/send',{method:'POST',body:{message:'  '}})).status,400);
    const assistant=await request('/admin/gemini-chat/send',{method:'POST',body:{message:'today orders'}}); assert.equal(assistant.status,200); assert.equal(assistant.json.success,true);
    for(const path of ['/admin/smsgeteway/balance','/admin/bdcourier/my-plan','/admin/steadfast/dashboard-widget']){
      const response=await request(path); assert.equal(response.status,503); assert.equal(response.json.status,'unavailable'); assert.equal(response.json.success,false);
    }
    const audit=await db.queryAll("SELECT action,after_json FROM audit_logs WHERE actor_id=? AND action IN ('admin.dashboard.popup.dismissed','admin.assistant.report') ORDER BY id",[dashboardUserId]);
    assert.ok(audit.some(r=>r.action==='admin.dashboard.popup.dismissed'));
    assert.ok(audit.some(r=>r.action==='admin.assistant.report'));
    const promptLeak=await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id=? AND action='admin.assistant.report' AND JSON_SEARCH(after_json,'one','%today orders%') IS NOT NULL",[dashboardUserId]);
    assert.equal(Number(promptLeak.n),0,'assistant audit stores intent only, not customer/user prompt text');
    assert.equal((await request('/admin/audit-logs',{cookie:limited})).status,403);
    assert.equal((await request('/admin/audit-logs')).status,200);
    assert.equal((await request('/admin/audit-logs',{method:'DELETE'})).status,404);
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
    const grant=await request(`/admin/phase09/access/roles/${roleId}/permissions`,{method:'PUT',body:{permissions:['dashboard.view']}});
    assert.equal(grant.status,200); assert.deepEqual(grant.json.data.permissions,['dashboard.view']);
    const token=csrfToken;
    const staffEmail=`p09-staff-${Date.now()}@example.invalid`;
    const createdStaff=await request('/admin/phase09/access/staff',{method:'POST',body:{name:'P09 Test Staff',email:staffEmail,phone:'01712345678',password:'ValidPhase09Password!2026',roleId}});
    assert.equal(createdStaff.status,201); assert.equal(Object.hasOwn(createdStaff.json.data,'password_hash'),false);
    const persistedStaff=await db.queryOne('SELECT email,status,role_id,password_hash FROM users WHERE id=?',[createdStaff.json.data.id]);
    assert.equal(persistedStaff.email,staffEmail.toLowerCase()); assert.equal(Number(persistedStaff.status),1); assert.equal(Number(persistedStaff.role_id),Number(roleId));
    assert.equal(await bcrypt.compare('ValidPhase09Password!2026',persistedStaff.password_hash),true,'new staff password must be bcrypt-verifiable');
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
    assert.equal((await migrateDown(pool,{steps:1})).length,1);
    const retained=await db.queryOne(`SELECT COUNT(*) AS n FROM permissions WHERE name IN (${permissionNames.map(()=>'?').join(',')})`,permissionNames);
    assert.equal(Number(retained.n),permissionNames.length,'down migration preserves catalog entries referenced by role grants');
    await migrateUp(pool);
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=?',[roleIds.p09_full])).n),grantsBefore);
    assert.ok(token);
  });
});
