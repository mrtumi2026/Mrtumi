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
const { PRODUCT_CSV_COLUMNS,serializeCsv,parseCsv } = require('../src/utils/productCsv');

describe('Phase 09 — full-stack MySQL 8.0 dashboard, admin access, RBAC & audit HTTP', { skip: !MYSQL_HOST && !REQUIRED ? SKIP : false }, () => {
  let pool, db, server, baseUrl, dashboardCookie, csrfToken, productId, invoiceOrderId, dashboardUserId, limitedUserId, managerUserId, noGrantUserId, fullEmail='', limitedEmail='', managerEmail='', noGrantEmail='';
  let cachedNoGrantSession=null;
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
  async function noGrantSession(){
    if(!cachedNoGrantSession){
      const cookie=await login(noGrantEmail);
      cachedNoGrantSession={cookie,token:await fetchCsrf(cookie)};
    }
    return cachedNoGrantSession;
  }

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

  test('Phase 06 catalog edit UI and HTTP update enforce grants/CSRF and preserve inventory/variant state',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const path=`/admin/phase06/products/${productId}/edit`;
    assert.equal((await request(path,{cookie:'',accept:'text/html'})).status,302,'unauthenticated catalog edit redirects through the existing admin login flow');
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    assert.equal((await request(path,{cookie:noGrantCookie,accept:'text/html'})).status,403,'inventory.manage is required');
    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    const form=await request(path,{accept:'text/html'});
    assert.equal(form.status,200,form.text.slice(0,300));
    assert.match(form.text,/Catalog details|ক্যাটালগের বিবরণ/);
    const category=await db.queryOne('SELECT category_id FROM products WHERE id=?',[productId]);
    const original=await db.queryOne('SELECT * FROM products WHERE id=?',[productId]);
    const variantSku=`P09-EDIT-V-${Date.now()}`;
    const variant=await db.execute('INSERT INTO product_variants (product_id,variant_sku,size_label,color_label,price_paisa,stock_on_hand,stock_reserved,status) VALUES (?,?,?,?,?,?,?,1)',[productId,variantSku,'250 g','Red',7654,5,1]);
    const before=await db.queryOne('SELECT sku,stock_on_hand,stock_reserved,vendor_stock_on_hand FROM products WHERE id=?',[productId]);
    const ledgerBefore=Number((await db.queryOne('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?',[productId])).n);
    const input={name_bn:'পরীক্ষা পরিবর্তিত ড্যাশবোর্ড পণ্য',name_en:'Updated dashboard product',slug:`p09-edited-${productId}`,product_type:'grocery',
      category_id:Number(category.category_id),brand_id:'',unit_label:'250 g',regular_price_bdt:'125.00',sale_price_bdt:'105.00',
      cost_price_bdt:'55.00',wholesale_price_bdt:'0',wholesale_min_qty:'0',low_stock_threshold:'2',image_url:'/uploads/custom/p09-edited.webp',
      short_desc_bn:'বাংলা বিবরণ',short_desc_en:'Short English',description_bn:'বিস্তারিত বাংলা',description_en:'Full English'};
    assert.equal((await request(`/admin/phase06/products/${productId}`,{method:'POST',token:'',body:input})).status,403,'catalog update requires CSRF');
    assert.equal((await request(`/admin/phase06/products/${productId}`,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:input})).status,403,'catalog update requires inventory.manage');
    assert.equal((await request(`/admin/phase06/products/${productId}`,{method:'POST',body:{...input,sale_price_bdt:'126'}})).status,400,'sale price above regular price is rejected');
    const updated=await request(`/admin/phase06/products/${productId}`,{method:'POST',body:input});
    assert.equal(updated.status,200,updated.text.slice(0,300));
    assert.equal(updated.json.product.sku,before.sku,'catalog edit preserves the immutable SKU');
    const after=await db.queryOne('SELECT name_bn,name_en,slug,sale_price_paisa,stock_on_hand,stock_reserved,vendor_stock_on_hand FROM products WHERE id=?',[productId]);
    assert.deepEqual([after.name_bn,after.name_en,after.slug,Number(after.sale_price_paisa)],[input.name_bn,input.name_en,input.slug,10500]);
    assert.deepEqual([Number(after.stock_on_hand),Number(after.stock_reserved),Number(after.vendor_stock_on_hand)],[Number(before.stock_on_hand),Number(before.stock_reserved),Number(before.vendor_stock_on_hand)]);
    assert.equal(Number((await db.queryOne('SELECT price_paisa FROM product_variants WHERE id=?',[variant.insertId])).price_paisa),7654,'variant-level price is not overwritten by parent edit');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=?',[productId])).n),ledgerBefore,'catalog edit must not alter stock ledger');
    const audit=await db.queryOne("SELECT before_json,after_json FROM audit_logs WHERE action='product.update' AND entity_id=? ORDER BY id DESC LIMIT 1",[String(productId)]);
    assert.equal(JSON.parse(audit.before_json).sku,before.sku);
    assert.equal(JSON.parse(audit.after_json).nameBn,input.name_bn);
    const auditBefore=Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='product.update' AND entity_id=?",[String(productId)])).n);
    await db.execute("CREATE TRIGGER p09_http_fail_product_update BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture product audit failure'");
    try {
      const failure=await request(`/admin/phase06/products/${productId}`,{method:'POST',body:{...input,name_en:'Must roll back'}});
      assert.equal(failure.status,500,failure.text.slice(0,300));
    } finally {
      await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_product_update');
    }
    assert.equal((await db.queryOne('SELECT name_en FROM products WHERE id=?',[productId])).name_en,input.name_en,'audit failure must roll metadata back');
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='product.update' AND entity_id=?",[String(productId)])).n),auditBefore);
    await db.execute(`UPDATE products SET name_bn=?,name_en=?,slug=?,product_type=?,category_id=?,brand_id=?,regular_price_paisa=?,sale_price_paisa=?,cost_price_paisa=?,
      wholesale_price_paisa=?,wholesale_min_qty=?,low_stock_threshold=?,unit_label=?,image_url=?,short_desc_bn=?,short_desc_en=?,description_bn=?,description_en=? WHERE id=?`,
      [original.name_bn,original.name_en,original.slug,original.product_type,original.category_id,original.brand_id,original.regular_price_paisa,
        original.sale_price_paisa,original.cost_price_paisa,original.wholesale_price_paisa,original.wholesale_min_qty,original.low_stock_threshold,
        original.unit_label,original.image_url,original.short_desc_bn,original.short_desc_en,original.description_bn,original.description_en,productId]);
    await db.execute('DELETE FROM product_variants WHERE id=?',[variant.insertId]);
  });

  test('Phase 06 gallery reorder enforces product-local complete lists, safe paths, auth/CSRF, persistence and audit rollback',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    const base=`/admin/phase06/products/${productId}`;
    const first='/uploads/product/lychee-fresh.jpg', second='/uploads/product/lychee-box.jpg';
    const original=await db.queryOne('SELECT image_url,gallery_json FROM products WHERE id=?',[productId]);
    t.after(async()=>{
      await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_gallery_update');
      await db.execute('UPDATE products SET image_url=?,gallery_json=? WHERE id=?',[original.image_url,original.gallery_json,productId]);
    });
    await db.execute('UPDATE products SET image_url=?,gallery_json=? WHERE id=?',[first,JSON.stringify([first,second]),productId]);
    const imageFiles=[first,second].map((image)=>require('path').join(__dirname,'..','public',image.slice(1)));
    assert.ok(imageFiles.every((file)=>require('fs').existsSync(file)));
    assert.equal((await request(`${base}/gallery`,{method:'POST',cookie:'',token:'',body:{gallery_paths:[second,first]}})).status,401,'unauthenticated JSON gallery changes are rejected by the existing admin authentication gate');
    assert.equal((await request(`${base}/gallery`,{method:'POST',token:'',body:{gallery_paths:[second,first]}})).status,403,'gallery changes require session-bound CSRF');
    assert.equal((await request(`${base}/gallery`,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:{gallery_paths:[second,first]}})).status,403,'gallery changes require inventory.manage');
    const form=await request(`${base}/edit`,{accept:'text/html'});
    assert.equal(form.status,200);
    assert.match(form.text,/id="gallery-paths"/);
    assert.ok(form.text.includes(first)&&form.text.includes(second),'only the current product public image paths are shown');
    assert.equal((await request('/admin/phase06/products/999999999/gallery',{method:'POST',body:{gallery_paths:[first]}})).status,404,'missing product is not created or mutated');
    assert.equal((await request(`${base}/gallery`,{method:'POST',body:{gallery_paths:[first,'/uploads/product/../secret.jpg']}})).status,400,'traversal paths are rejected');
    assert.equal((await request(`${base}/gallery`,{method:'POST',body:{gallery_paths:[first,'/uploads/product/mango-organic.jpg']}})).status,400,'safe but unassigned/cross-product paths are rejected');
    assert.equal((await request(`${base}/gallery`,{method:'POST',body:{gallery_paths:[first]}})).status,400,'reorder requires every current item exactly once');
    const saved=await request(`${base}/gallery`,{method:'POST',body:{gallery_paths:[second,first]}});
    assert.equal(saved.status,200,saved.text.slice(0,300));
    assert.deepEqual(saved.json.gallery.galleryPaths,[second,first]);
    assert.deepEqual(await db.queryOne('SELECT image_url,gallery_json FROM products WHERE id=?',[productId]),
      {image_url:second,gallery_json:JSON.stringify([second,first])});
    const audit=await db.queryOne("SELECT before_json,after_json FROM audit_logs WHERE action='product.gallery.reorder' AND entity_id=? ORDER BY id DESC LIMIT 1",[String(productId)]);
    assert.deepEqual(JSON.parse(audit.before_json).galleryPaths,[first,second]);
    assert.deepEqual(JSON.parse(audit.after_json).galleryPaths,[second,first]);
    assert.ok(imageFiles.every((file)=>require('fs').existsSync(file)),'reorder never removes files');

    await db.execute("CREATE TRIGGER p09_http_fail_gallery_update BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture gallery audit failure'");
    try {
      const failed=await request(`${base}/gallery`,{method:'POST',body:{gallery_paths:[first,second]}});
      assert.equal(failed.status,500,failed.text.slice(0,300));
    } finally { await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_gallery_update'); }
    assert.deepEqual(await db.queryOne('SELECT image_url,gallery_json FROM products WHERE id=?',[productId]),
      {image_url:second,gallery_json:JSON.stringify([second,first])},'audit failure rolls both gallery columns back');

    await db.execute('UPDATE products SET gallery_json=? WHERE id=?',[JSON.stringify(['https://example.invalid/private?token=hidden']),productId]);
    const blocked=await request(`${base}/edit`,{accept:'text/html'});
    assert.equal(blocked.status,200);
    assert.doesNotMatch(blocked.text,/token=hidden/,'unsupported legacy URLs and query secrets are not rendered');
    assert.equal((await request(`${base}/gallery`,{method:'POST',body:{gallery_paths:[first]}})).status,400,'legacy or missing entries fail closed without overwriting them');
  });

  test('Phase 06 product CSV preview/commit/export is authorized, row-validated, atomic and spreadsheet-safe',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    const suffix=Date.now(),skuA=`P09-CSV-A-${suffix}`,skuB=`P09-CSV-B-${suffix}`;
    const categoryId=Number((await db.queryOne('SELECT category_id FROM products WHERE id=?',[productId])).category_id);
    let productA=null,productB=null,productAmbiguous=null,variantId=null;
    await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_product_csv_update');
    t.after(async()=>{
      await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_product_csv_update');
      if(variantId)await db.execute('DELETE FROM product_variants WHERE id=?',[variantId]);
      for(const id of [productAmbiguous,productA,productB])if(id)await db.execute('DELETE FROM products WHERE id=?',[id]);
    });
    productA=Number((await db.execute(`INSERT INTO products(sku,barcode,slug,name_bn,name_en,category_id,regular_price_paisa,sale_price_paisa,cost_price_paisa,
      stock_on_hand,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image_url,is_flash_sale,approval_status,status,is_archived)
      VALUES(?,?,?,?,?,?,10000,9000,6000,12,3,4,1,'/uploads/product/lychee-fresh.jpg',1,'pending',0,0)`,
      [skuA,`P09-BAR-A-${suffix}`,`p09-csv-a-${suffix}`,'CSV, "quoted"\nand line','=SUM(1,1)',categoryId])).insertId);
    productB=Number((await db.execute(`INSERT INTO products(sku,barcode,slug,name_bn,name_en,category_id,regular_price_paisa,sale_price_paisa,cost_price_paisa,
      stock_on_hand,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image_url,approval_status,status,is_archived)
      VALUES(?,?,?,?,?,?,20000,18000,12000,8,2,0,0,'/uploads/product/mango-organic.jpg','approved',1,0)`,
      [skuB,`P09-BAR-B-${suffix}`,`p09-csv-b-${suffix}`,'পুরোনো দুই','Old B',categoryId])).insertId);
    const variant=await db.execute('INSERT INTO product_variants(product_id,variant_sku,size_label,color_label,price_paisa,stock_on_hand,stock_reserved,status) VALUES(?,?,\'500 g\',\'Green\',5000,6,2,1)',[productA,`P09-CSV-V-${suffix}`]);
    variantId=Number(variant.insertId);
    const base=`/admin/phase06/products/import`;
    assert.equal((await request('/admin/phase06/products/export.csv',{cookie:'',token:''})).status,401,'CSV export requires admin authentication');
    assert.equal((await request('/admin/phase06/products/export.csv',{cookie:noGrantCookie,token:noGrantToken})).status,403,'CSV export requires inventory.manage');
    const exportResponse=await request('/admin/phase06/products/export.csv');
    assert.equal(exportResponse.status,200,exportResponse.text.slice(0,200));
    assert.match(exportResponse.headers.get('content-type'),/text\/csv/i);
    assert.match(exportResponse.headers.get('content-disposition'),/attachment; filename="products\.csv"/);
    const exportedRecords=parseCsv(exportResponse.text);
    const exportHeaders=exportedRecords[0].cells;
    assert.deepEqual(exportHeaders,PRODUCT_CSV_COLUMNS);
    assert.equal(exportHeaders.some((column)=>['image_url','gallery_json','stock_on_hand','stock_reserved','vendor_stock_on_hand','vendor_stock_reserved','approval_status','is_archived','status','variant_sku'].includes(column)),false,'export contains no media, stock, variants or state');
    const exportSkuIndex=exportHeaders.indexOf('sku'),exportBnIndex=exportHeaders.indexOf('name_bn'),exportEnIndex=exportHeaders.indexOf('name_en');
    const exportedA=exportedRecords.slice(1).find((record)=>record.cells[exportSkuIndex]===skuA);
    assert.ok(exportedA);
    assert.equal(exportedA.cells[exportEnIndex],"'=SUM(1,1)",'spreadsheet formula-leading text gets a safe apostrophe prefix');
    assert.equal(exportedA.cells[exportBnIndex],'CSV, "quoted"\nand line','CSV commas, quotes, and embedded newlines are quoted correctly');
    assert.ok(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='product.csv.export'")).n)>=1,'sensitive export is audited without logging cells');

    const makeRow=(sku,barcode,extra={})=>({sku,barcode,name_bn:'Imported name',name_en:'Imported English',slug:`${sku.toLowerCase()}-new`,product_type:'grocery',
      category_id:String(categoryId),brand_id:'',unit_label:'1 pc',regular_price_bdt:'125.50',sale_price_bdt:'110.25',cost_price_bdt:'70.00',wholesale_price_bdt:'0.00',
      wholesale_min_qty:'0',low_stock_threshold:'4',short_desc_bn:'',short_desc_en:'',description_bn:'',description_en:'',...extra});
    const csv=(rows)=>serializeCsv(PRODUCT_CSV_COLUMNS,rows);
    const path=`${base}/preview`,commitPath=`${base}/commit`;
    const initial=[makeRow(skuA,`P09-BAR-A-${suffix}`,{name_bn:'প্রিভিউ এক'}),makeRow(skuB,`P09-BAR-B-${suffix}`,{name_bn:'প্রিভিউ দুই'})];
    assert.equal((await request(path,{method:'POST',cookie:'',token:'',body:{csv_text:csv(initial)}})).status,401,'preview requires admin authentication');
    assert.equal((await request(path,{method:'POST',token:'',body:{csv_text:csv(initial)}})).status,403,'preview requires CSRF');
    assert.equal((await request(path,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:{csv_text:csv(initial)}})).status,403,'preview requires inventory.manage');
    const initialRows=await db.queryAll('SELECT id,name_bn,slug,regular_price_paisa,sale_price_paisa,cost_price_paisa,stock_on_hand,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image_url,is_flash_sale,approval_status,status,is_archived FROM products WHERE id IN (?,?) ORDER BY id',[productA,productB]);
    const preview=await request(path,{method:'POST',body:{csv_text:csv(initial)}});
    assert.equal(preview.status,200,preview.text.slice(0,300));
    assert.equal(preview.json.preview.valid,true,JSON.stringify(preview.json.preview.errors));
    assert.ok(preview.json.previewId);
    assert.deepEqual(await db.queryAll('SELECT id,name_bn,slug,regular_price_paisa,sale_price_paisa,cost_price_paisa,stock_on_hand,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image_url,is_flash_sale,approval_status,status,is_archived FROM products WHERE id IN (?,?) ORDER BY id',[productA,productB]),initialRows,'preview has no catalog mutations');
    const alteredCsv=csv([makeRow(skuA,`P09-BAR-A-${suffix}`,{name_bn:'Changed after preview'}),initial[1]]);
    assert.equal((await request(commitPath,{method:'POST',body:{preview_id:preview.json.previewId,csv_text:alteredCsv}})).status,409,'commit is bound to the exact previewed CSV');

    const mixed=csv([initial[0],makeRow(skuB,`P09-BAR-B-${suffix}`,{category_id:'999999'})]);
    const invalid=await request(path,{method:'POST',body:{csv_text:mixed}});
    assert.equal(invalid.json.preview.valid,false);
    assert.equal(invalid.json.previewId,null);
    assert.ok(invalid.json.preview.errors.some((item)=>item.row===3&&item.errors.some((message)=>message.includes('active category'))));
    assert.equal((await request(commitPath,{method:'POST',body:{preview_id:'',csv_text:mixed}})).status,409,'invalid mixed CSV cannot be committed');
    assert.deepEqual(await db.queryAll('SELECT id,name_bn,slug,regular_price_paisa,sale_price_paisa,cost_price_paisa,stock_on_hand,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image_url,is_flash_sale,approval_status,status,is_archived FROM products WHERE id IN (?,?) ORDER BY id',[productA,productB]),initialRows,'one invalid row blocks every otherwise valid row');

    const duplicateSku=await request(path,{method:'POST',body:{csv_text:csv([initial[0],makeRow(skuA.toLowerCase(),`P09-BAR-A2-${suffix}`)])}});
    assert.equal(duplicateSku.json.preview.valid,false);
    assert.ok(duplicateSku.json.preview.errors.some((item)=>item.errors.some((message)=>message.includes('Duplicate SKU'))));
    const duplicateBarcode=await request(path,{method:'POST',body:{csv_text:csv([makeRow(skuA,'SAME-BAR'),makeRow(skuB,'SAME-BAR')])}});
    assert.equal(duplicateBarcode.json.preview.valid,false);
    assert.ok(duplicateBarcode.json.preview.errors.some((item)=>item.errors.some((message)=>message.includes('Duplicate Barcode'))));
    productAmbiguous=Number((await db.execute(`INSERT INTO products(sku,barcode,slug,name_bn,name_en,category_id,regular_price_paisa,sale_price_paisa)
      VALUES(?,?,?, 'Ambiguous barcode fixture','Ambiguous',?,10000,9000)`,[`P09-CSV-AMB-${suffix}`,`P09-BAR-A-${suffix}`,`p09-csv-amb-${suffix}`,categoryId])).insertId);
    const ambiguousBarcode=await request(path,{method:'POST',body:{csv_text:csv([initial[0]])}});
    assert.equal(ambiguousBarcode.json.preview.valid,false);
    assert.ok(ambiguousBarcode.json.preview.errors.some((item)=>item.errors.some((message)=>message.includes('ambiguous'))));
    await db.execute('UPDATE products SET barcode=? WHERE id=?',[`P09-BAR-C-${suffix}`,productAmbiguous]);

    const valid=await request(path,{method:'POST',body:{csv_text:csv(initial)}});
    assert.equal(valid.status,200);
    assert.equal(valid.json.preview.valid,true);
    const saved=await request(commitPath,{method:'POST',body:{preview_id:valid.json.previewId,csv_text:csv(initial)}});
    assert.equal(saved.status,200,saved.text.slice(0,300));
    assert.equal(saved.json.updatedCount,2);
    const afterRows=await db.queryAll('SELECT id,sku,name_bn,slug,regular_price_paisa,sale_price_paisa,cost_price_paisa,stock_on_hand,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image_url,is_flash_sale,approval_status,status,is_archived FROM products WHERE id IN (?,?) ORDER BY id',[productA,productB]);
    assert.deepEqual(afterRows.map((row)=>[row.name_bn,row.regular_price_paisa,row.sale_price_paisa,row.cost_price_paisa]),[['প্রিভিউ এক',12550,11025,7000],['প্রিভিউ দুই',12550,11025,7000]]);
    assert.deepEqual(afterRows.map((row)=>[Number(row.stock_on_hand),Number(row.stock_reserved),Number(row.vendor_stock_on_hand),Number(row.vendor_stock_reserved),row.image_url,Number(row.is_flash_sale),row.approval_status,Number(row.status),Number(row.is_archived)]),
      [[12,3,4,1,'/uploads/product/lychee-fresh.jpg',1,'pending',0,0],[8,2,0,0,'/uploads/product/mango-organic.jpg',0,'approved',1,0]],'CSV preserves stock, reservations, media, approval, archive and status');
    assert.deepEqual(await db.queryOne('SELECT variant_sku,stock_on_hand,stock_reserved,status FROM product_variants WHERE id=?',[variantId]),
      {variant_sku:`P09-CSV-V-${suffix}`,stock_on_hand:6,stock_reserved:2,status:1},'variant records are untouched');
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='product.csv_import.update' AND entity_id IN (?,?)",[String(productA),String(productB)])).n),2);
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='product.csv_import.commit'")).n)>=1,true);

    const rollbackCsv=csv([makeRow(skuA,`P09-BAR-A-${suffix}`,{name_bn:'Rollback A',slug:`${skuA.toLowerCase()}-rollback`}),
      makeRow(skuB,`P09-BAR-B-${suffix}`,{name_bn:'Rollback B',slug:`${skuB.toLowerCase()}-rollback`})]);
    const rollbackPreview=await request(path,{method:'POST',body:{csv_text:rollbackCsv}});
    assert.equal(rollbackPreview.json.preview.valid,true,JSON.stringify(rollbackPreview.json.preview.errors));
    await db.execute(`CREATE TRIGGER p09_http_fail_product_csv_update BEFORE INSERT ON audit_logs FOR EACH ROW
      BEGIN IF NEW.action='product.csv_import.update' AND NEW.entity_id='${productB}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture CSV audit failure'; END IF; END`);
    try{
      const failed=await request(commitPath,{method:'POST',body:{preview_id:rollbackPreview.json.previewId,csv_text:rollbackCsv}});
      assert.equal(failed.status,500,failed.text.slice(0,300));
    }finally{await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_product_csv_update');}
    const rolledBack=await db.queryAll('SELECT id,name_bn,slug FROM products WHERE id IN (?,?) ORDER BY id',[productA,productB]);
    assert.deepEqual(rolledBack.map((row)=>[row.name_bn,row.slug]),[['প্রিভিউ এক',`${skuA.toLowerCase()}-new`],['প্রিভিউ দুই',`${skuB.toLowerCase()}-new`]],'later-row audit failure rolls back the entire batch');
  });

  test('Phase 06 variant HTTP management validates, audits, and preserves carts/orders/reservations/ledger',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    let variantId=null,customerId=null,cartId=null,orderLineId=null,reservationId=null,ledgerId=null;
    t.after(async()=>{
      await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_variant_update');
      await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_variant_create');
      if(cartId)await db.execute('DELETE FROM customer_cart_items WHERE id=?',[cartId]);
      if(orderLineId)await db.execute('DELETE FROM order_items WHERE id=?',[orderLineId]);
      if(reservationId)await db.execute('DELETE FROM stock_reservations WHERE id=?',[reservationId]);
      if(ledgerId)await db.execute('DELETE FROM stock_ledger WHERE id=?',[ledgerId]);
      if(customerId)await db.execute('DELETE FROM customers WHERE id=?',[customerId]);
      if(variantId)await db.execute('DELETE FROM product_variants WHERE id=?',[variantId]);
    });
    const base=`/admin/phase06/products/${productId}`;
    const createPage=await request('/admin/phase06',{accept:'text/html'});
    assert.equal(createPage.status,200,createPage.text.slice(0,300));
    const categoryId=Number((await db.queryOne('SELECT category_id FROM products WHERE id=?',[productId])).category_id);
    assert.match(createPage.text,/id="p-category" name="category_id"/);
    assert.match(createPage.text,new RegExp(`<option value="${categoryId}">`),'product creation form offers the active existing category by ID');
    assert.match(createPage.text,/id="p-brand" name="brand_id"/);
    const sku=`P09-VAR-${Date.now()}`;
    const createInput={variant_sku:sku,size_label:'500 g',color_label:'Green',price_bdt:'87.65'};
    assert.equal((await request(`${base}/variants`,{method:'POST',token:'',body:createInput})).status,403,'variant create requires CSRF');
    assert.equal((await request(`${base}/variants`,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:createInput})).status,403,'variant management requires inventory.manage');
    assert.equal((await request(`${base}/variants`,{method:'POST',body:{...createInput,price_bdt:'87.651'}})).status,400,'variant price must be integer paisa');
    const created=await request(`${base}/variants`,{method:'POST',body:createInput});
    assert.equal(created.status,201,created.text.slice(0,300));
    variantId=Number(created.json.variant.id);
    const createdRow=await db.queryOne('SELECT variant_sku,size_label,color_label,price_paisa,stock_on_hand,stock_reserved,status FROM product_variants WHERE id=?',[variantId]);
    assert.deepEqual({...createdRow,price_paisa:Number(createdRow.price_paisa),stock_on_hand:Number(createdRow.stock_on_hand),stock_reserved:Number(createdRow.stock_reserved),status:Number(createdRow.status)},
      {variant_sku:sku,size_label:'500 g',color_label:'Green',price_paisa:8765,stock_on_hand:0,stock_reserved:0,status:1});
    const duplicate=await request(`${base}/variants`,{method:'POST',body:{...createInput,size_label:'1 kg'}});
    assert.equal(duplicate.status,409,'database unique index rejects a duplicate global variant SKU');

    customerId=Number((await db.execute("INSERT INTO customers(name,phone,status) VALUES('P09 variant fixture',?,1)",[`017${String(Date.now()).slice(-8)}`])).insertId);
    const cart=await db.execute('INSERT INTO customer_cart_items(customer_id,product_id,variant_id,quantity) VALUES(?,?,?,1)',[customerId,productId,variantId]); cartId=Number(cart.insertId);
    const orderLine=await db.execute('INSERT INTO order_items(order_id,product_id,variant_id,product_name,unit_price_paisa,qty,line_total_paisa,size_label,color_label) VALUES(?,?,?,?,?,?,?, ?,?)',
      [invoiceOrderId,productId,variantId,'Dashboard product (500 g)',8765,1,8765,'500 g','Green']); orderLineId=Number(orderLine.insertId);
    const reservationKey=`p09-variant-${Date.now()}`;
    const reservation=await db.execute('INSERT INTO stock_reservations(product_id,variant_id,stock_pool,qty,reservation_key,request_hash,status,expires_at) VALUES(?,?,\'warehouse\',1,?,?,\'active\',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY))',
      [productId,variantId,reservationKey,'a'.repeat(64)]); reservationId=Number(reservation.insertId);
    await db.execute('UPDATE product_variants SET stock_on_hand=5,stock_reserved=1 WHERE id=?',[variantId]);
    const ledger=await db.execute("INSERT INTO stock_ledger(product_id,variant_id,stock_pool,movement_type,qty_delta,balance_after,reason) VALUES(?,?,'warehouse','opening',5,5,'P09 integration fixture')",[productId,variantId]); ledgerId=Number(ledger.insertId);
    const updateInput={size_label:'1 kg',color_label:'Blue',price_bdt:'0.00',status:'0'};
    const deniedUpdate=await request(`${base}/variants/${variantId}`,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:updateInput});
    assert.equal(deniedUpdate.status,403);
    const updated=await request(`${base}/variants/${variantId}`,{method:'POST',body:updateInput});
    assert.equal(updated.status,200,updated.text.slice(0,300));
    assert.deepEqual([updated.json.variant.variantSku,updated.json.variant.sizeLabel,updated.json.variant.colorLabel,updated.json.variant.pricePaisa,updated.json.variant.status],
      [sku,'1 kg','Blue',0,0]);
    const refs=await db.queryOne(`SELECT v.variant_sku,v.size_label,v.color_label,v.price_paisa,v.stock_on_hand,v.stock_reserved,v.status,
        (SELECT COUNT(*) FROM customer_cart_items c WHERE c.variant_id=v.id) AS cart_refs,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.variant_id=v.id) AS order_refs,
        (SELECT COUNT(*) FROM stock_reservations sr WHERE sr.variant_id=v.id AND sr.status='active') AS reservation_refs,
        (SELECT COUNT(*) FROM stock_ledger sl WHERE sl.variant_id=v.id) AS ledger_refs
      FROM product_variants v WHERE v.id=?`,[variantId]);
    assert.deepEqual([refs.variant_sku,refs.size_label,refs.color_label,Number(refs.price_paisa),Number(refs.stock_on_hand),Number(refs.stock_reserved),Number(refs.status),
      Number(refs.cart_refs),Number(refs.order_refs),Number(refs.reservation_refs),Number(refs.ledger_refs)],
      [sku,'1 kg','Blue',0,5,1,0,1,1,1,1],'metadata edit and soft deactivation preserve all inventory and historical references');
    const audit=await db.queryOne("SELECT before_json,after_json FROM audit_logs WHERE action='product.variant.update' AND entity_id=? ORDER BY id DESC LIMIT 1",[String(variantId)]);
    assert.equal(JSON.parse(audit.before_json).variant_sku,sku);
    assert.equal(JSON.parse(audit.after_json).stockReserved,1);

    await db.execute("CREATE TRIGGER p09_http_fail_variant_update BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture variant update audit failure'");
    try {
      const failed=await request(`${base}/variants/${variantId}`,{method:'POST',body:{...updateInput,size_label:'Must roll back',status:'1'}});
      assert.equal(failed.status,500,failed.text.slice(0,300));
    } finally { await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_variant_update'); }
    assert.deepEqual(await db.queryOne('SELECT size_label,status,stock_on_hand,stock_reserved FROM product_variants WHERE id=?',[variantId]),
      {size_label:'1 kg',status:0,stock_on_hand:5,stock_reserved:1},'audit failure rolls variant edit back');

    await db.execute("CREATE TRIGGER p09_http_fail_variant_create BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture variant create audit failure'");
    try {
      const failed=await request(`${base}/variants`,{method:'POST',body:{...createInput,variant_sku:`${sku}-ROLLBACK`}});
      assert.equal(failed.status,500,failed.text.slice(0,300));
    } finally { await db.execute('DROP TRIGGER IF EXISTS p09_http_fail_variant_create'); }
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM product_variants WHERE variant_sku=?',[`${sku}-ROLLBACK`])).n),0,'audit failure rolls variant create back');
    assert.ok(cartId&&orderLineId&&reservationId&&ledgerId);
  });

  test('legacy blog admin routes use MySQL persistence, permission/CSRF checks, and transactional audit',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    assert.equal((await request('/admin/blogs',{cookie:noGrantCookie,accept:'text/html'})).status,403,'content.manage is required to read blogs');
    assert.equal((await request('/admin/blog/create',{accept:'text/html'})).status,200,'authorized content managers can load the create form');
    assert.equal((await request('/admin/blog/create',{method:'POST',token:'',body:{title:'CSRF denied',content:'No write'}})).status,403,'blog mutations require CSRF');
    assert.equal((await request('/admin/blog/create',{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:{title:'Denied',content:'No write'}})).status,403,'content.manage is required to create blogs');
    assert.equal((await request('/admin/blog/create',{method:'POST',body:{title:'',content:'Invalid'}})).status,400,'required title validation is enforced');

    const title=`P09 MySQL blog ${Date.now()}`;
    const created=await request('/admin/blog/create',{method:'POST',body:{title,category:'Test content',image:'/uploads/test-blog.jpg',excerpt:'Safe excerpt',content:'A blog body used to exercise the MySQL admin route.'}});
    assert.equal(created.status,302,created.text.slice(0,300));
    assert.equal(created.headers.get('location'),'/admin/blogs');
    const persisted=await db.queryOne('SELECT id,title,slug,category,image_url,excerpt,content,status FROM blogs WHERE title=?',[title]);
    assert.ok(persisted); assert.equal(persisted.image_url,'/uploads/test-blog.jpg'); assert.equal(Number(persisted.status),1);
    const createAudit=await db.queryOne("SELECT actor_id,action,after_json FROM audit_logs WHERE action='admin.blog.created' AND entity_id=?",[String(persisted.id)]);
    assert.equal(Number(createAudit.actor_id),dashboardUserId);
    assert.deepEqual(JSON.parse(createAudit.after_json).fields,['title','category','image_url','excerpt','content']);
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'admin.legacy.content.manage.mutation' AND entity_id='POST /admin/blog/create' AND actor_id=?",[dashboardUserId])).n),0,'transactional domain audit suppresses the generic duplicate event');
    const listing=await request('/admin/blogs',{accept:'text/html'});
    assert.equal(listing.status,200); assert.match(listing.text,new RegExp(title));

    const missingDelete=await request('/admin/blog/delete/999999999',{method:'POST',body:{}});
    assert.equal(missingDelete.status,404,'unknown blog IDs are not reported as successful deletes');
    const rollbackTitle=`P09 Blog rollback ${Date.now()}`;
    await db.execute("CREATE TRIGGER p09_blog_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture blog audit failure'");
    let failedCreate;
    let failedDelete;
    try {
      failedCreate=await request('/admin/blog/create',{method:'POST',body:{title:rollbackTitle,content:'This insert must roll back with the audit failure.'}});
      failedDelete=await request(`/admin/blog/delete/${persisted.id}`,{method:'POST',body:{}});
    } finally {
      await db.execute('DROP TRIGGER IF EXISTS p09_blog_fail_audit');
    }
    assert.equal(failedCreate.status,500,'audit failure is surfaced rather than reporting successful blog creation');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM blogs WHERE title=?',[rollbackTitle])).n),0,'blog row is rolled back when its audit event fails');
    assert.equal(failedDelete.status,500,'audit failure is surfaced rather than reporting successful blog deletion');
    assert.ok(await db.queryOne('SELECT id FROM blogs WHERE id=?',[persisted.id]),'delete row is restored when its audit insert fails');
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='admin.blog.deleted' AND entity_id=?",[String(persisted.id)])).n),0,'failed delete audit leaves no partial audit event');

    const deleted=await request(`/admin/blog/delete/${persisted.id}`,{method:'POST',body:{}});
    assert.equal(deleted.status,302);
    assert.equal(await db.queryOne('SELECT id FROM blogs WHERE id=?',[persisted.id]),null,'delete persists in MySQL');
    assert.ok(await db.queryOne("SELECT id FROM audit_logs WHERE action='admin.blog.deleted' AND entity_id=?",[String(persisted.id)]),'delete is auditable');
  });

  test('Phase 06 inventory adjustment HTTP requires permission and CSRF; stock, ledger and audit commit or roll back together',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const path='/admin/phase06/inventory/adjust';
    const base={product_id:productId,stock_pool:'warehouse',qty_delta:2,reason:'Phase 06 HTTP count correction'};
    assert.equal((await request(path,{method:'POST',cookie:'',token:'',body:base})).status,401,'inventory adjustment requires an authenticated admin');
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    assert.equal((await request(path,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:base})).status,403,'inventory.manage is required');
    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    assert.equal((await request(path,{method:'POST',token:'',body:base})).status,403,'inventory adjustment requires CSRF');
    assert.equal((await request(path,{method:'POST',body:{...base,qty_delta:0}})).status,400,'zero movements are rejected');
    assert.equal((await request(path,{method:'POST',body:{...base,product_id:999999999}})).status,404,'missing products are rejected');
    const before=await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId]);
    const success=await request(path,{method:'POST',body:base});
    assert.equal(success.status,200,success.text.slice(0,300));
    assert.deepEqual(success.json.movement,{productId,stockPool:'warehouse',previousBalance:Number(before.stock_on_hand),qtyDelta:2,balanceAfter:Number(before.stock_on_hand)+2});
    const persisted=await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId]);
    assert.equal(Number(persisted.stock_on_hand),Number(before.stock_on_hand)+2);
    const movement=await db.queryOne("SELECT qty_delta,balance_after,reason FROM stock_ledger WHERE product_id=? AND movement_type='adjustment' ORDER BY id DESC LIMIT 1",[productId]);
    assert.deepEqual([Number(movement.qty_delta),Number(movement.balance_after),movement.reason],[2,Number(persisted.stock_on_hand),'Phase 06 HTTP count correction']);
    const audit=await db.queryOne("SELECT actor_id,after_json FROM audit_logs WHERE action='inventory.adjust' AND entity_id=? ORDER BY id DESC LIMIT 1",[String(productId)]);
    assert.equal(Number(audit.actor_id),dashboardUserId);
    assert.equal(JSON.parse(audit.after_json).balanceAfter,Number(persisted.stock_on_hand));

    const ledgerCount=Number((await db.queryOne("SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=? AND movement_type='adjustment'",[productId])).n);
    const auditCount=Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='inventory.adjust' AND entity_id=?",[String(productId)])).n);
    await db.execute("CREATE TRIGGER p06_http_fail_inventory_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture inventory audit failure'");
    try {
      const failed=await request(path,{method:'POST',body:{...base,qty_delta:3,reason:'Must roll back'}});
      assert.equal(failed.status,500,failed.text.slice(0,300));
    } finally {
      await db.execute('DROP TRIGGER IF EXISTS p06_http_fail_inventory_audit');
    }
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),Number(persisted.stock_on_hand),'audit failure must roll back stock');
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id=? AND movement_type='adjustment'",[productId])).n),ledgerCount,'audit failure must roll back the stock ledger');
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='inventory.adjust' AND entity_id=?",[String(productId)])).n),auditCount,'failed audit must not be partially recorded');
  });

  test('Phase 06 supplier create HTTP enforces auth, inventory permission and CSRF; persists and audits atomically',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const path='/admin/phase06/suppliers';
    const suffix=Date.now();
    const input={name:'Phase 06 HTTP Supplier',supplier_code:`P06-HTTP-${suffix}`,phone:'+8801712345678',email:`supplier-${suffix}@example.invalid`,company:'Fixture supplier'};
    assert.equal((await request(path,{method:'POST',cookie:'',token:'',body:input})).status,401,'supplier create requires authentication');
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    assert.equal((await request(path,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:input})).status,403,'inventory.manage is required');
    dashboardCookie=await login(fullEmail); csrfToken=await fetchCsrf(dashboardCookie);
    assert.equal((await request(path,{method:'POST',token:'',body:input})).status,403,'supplier create requires CSRF');
    assert.equal((await request(path,{method:'POST',body:{...input,email:'invalid'}})).status,400,'invalid email is rejected');
    const created=await request(path,{method:'POST',body:input});
    assert.equal(created.status,201,created.text.slice(0,300));
    const id=Number(created.json.supplier.id);
    const persisted=await db.queryOne('SELECT name,supplier_code,phone,email,company FROM suppliers WHERE id=?',[id]);
    assert.deepEqual(persisted,{name:input.name,supplier_code:input.supplier_code,phone:input.phone,email:input.email,company:input.company});
    const audit=await db.queryOne("SELECT actor_id,after_json FROM audit_logs WHERE action='supplier.create' AND entity_id=?",[String(id)]);
    assert.equal(Number(audit.actor_id),dashboardUserId);
    assert.equal(JSON.parse(audit.after_json).code,input.supplier_code,'supplier audit stores the normalized supplier code');

    const rollbackCode=`P06-ROLLBACK-${suffix}`;
    await db.execute("CREATE TRIGGER p06_http_fail_supplier_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture supplier audit failure'");
    try {
      const failed=await request(path,{method:'POST',body:{...input,supplier_code:rollbackCode}});
      assert.equal(failed.status,500,failed.text.slice(0,300));
    } finally {
      await db.execute('DROP TRIGGER IF EXISTS p06_http_fail_supplier_audit');
    }
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM suppliers WHERE supplier_code=?',[rollbackCode])).n),0,'audit failure must roll back supplier persistence');
  });

  test('Phase 06 supplier edit and activation HTTP preserves purchase history/balance and audits atomically',async(t)=>{
    if(!MYSQL_HOST)return t.skip(SKIP);
    const suffix=Date.now();
    const createPath='/admin/phase06/suppliers';
    const supplierInput={name:'Phase 06 Lifecycle Supplier',supplier_code:`P06-LIFE-${suffix}`,phone:'+8801712345678',email:`life-${suffix}@example.invalid`,company:'Lifecycle fixture'};
    const created=await request(createPath,{method:'POST',body:supplierInput});
    assert.equal(created.status,201,created.text.slice(0,250));
    const supplierId=Number(created.json.supplier.id);
    const editPath=`/admin/phase06/suppliers/${supplierId}`;
    const pagePath=`${editPath}/edit`;
    const editInput={...supplierInput,name:'Phase 06 Lifecycle Supplier Updated',company:'Updated company',contact_person:'Buyer',phone:'+8801712345679',
      email:`updated-${suffix}@example.invalid`,address:'Updated address',tax_or_trade_id:'BD-LIFECYCLE',notes:'Contact details only',status:'0'};
    assert.equal((await request(pagePath,{cookie:''})).status,401,'supplier editor requires admin authentication');
    const {cookie:noGrantCookie,token:noGrantToken}=await noGrantSession();
    assert.equal((await request(pagePath,{cookie:noGrantCookie,token:noGrantToken})).status,403,'supplier editor requires inventory.manage');
    const editor=await request(pagePath,{accept:'text/html'}); assert.equal(editor.status,200,editor.text.slice(0,250));
    assert.doesNotMatch(editor.text,/balance_due_paisa|balance_due/,'supplier editor does not expose payable balance fields');
    assert.match(editor.text,new RegExp(supplierInput.supplier_code));
    assert.equal((await request(editPath,{method:'POST',token:'',body:editInput})).status,403,'supplier update requires CSRF');
    assert.equal((await request(editPath,{method:'POST',body:{...editInput,email:'invalid'}})).status,400,'invalid email is rejected');
    assert.equal((await request(editPath,{method:'POST',body:{...editInput,status:'2'}})).status,400,'unsupported supplier status is rejected');
    const otherSupplier=await request(createPath,{method:'POST',body:{name:'Other lifecycle supplier',supplier_code:`P06-OTHER-${suffix}`,phone:'+8801712345680'}});
    assert.equal(otherSupplier.status,201,otherSupplier.text.slice(0,200));
    assert.equal((await request(editPath,{method:'POST',body:{...editInput,supplier_code:`P06-OTHER-${suffix}`}})).status,409,'supplier code conflict is rejected');
    assert.equal((await request(`/admin/phase06/suppliers/999999999`,{method:'POST',body:editInput})).status,404,'unknown supplier cannot be created implicitly');

    const ref=`P06-LIFE-PO-${suffix}`;
    await db.execute('INSERT INTO purchases(reference_no,supplier_id,purchase_date) VALUES(?,?,CURRENT_DATE())',[ref,supplierId]);
    const historyPath=`/admin/phase06/suppliers/${supplierId}/purchases`;
    assert.equal((await request(historyPath,{cookie:''})).status,401,'supplier purchase history requires admin authentication');
    assert.equal((await request(historyPath,{cookie:noGrantCookie,token:noGrantToken})).status,403,'supplier purchase history requires inventory.manage');
    assert.equal((await request('/admin/phase06/suppliers/999999999/purchases')).status,404,'unknown supplier history is not exposed');
    assert.equal((await request(`${historyPath}?page=0`)).status,400,'invalid purchase-history page is rejected');
    const historyLedgerBefore=Number((await db.queryOne('SELECT COUNT(*) AS n FROM stock_ledger')).n);
    const historyAuditBefore=Number((await db.queryOne('SELECT COUNT(*) AS n FROM audit_logs')).n);
    const history=await request(historyPath);
    assert.equal(history.status,200,history.text.slice(0,250));
    assert.equal(history.json.supplier.id,supplierId);
    assert.equal(history.json.purchases.length,1);
    assert.equal(history.json.purchases[0].referenceNo,ref);
    assert.equal(history.json.purchases[0].lineCount,0);
    assert.doesNotMatch(JSON.stringify(history.json),/balance_due|payable|settlement|paid_amount|total_cost/,'history response excludes financial settlement data');
    const historyHtml=await request(historyPath,{accept:'text/html'});
    assert.equal(historyHtml.status,200,historyHtml.text.slice(0,250));
    assert.match(historyHtml.text,/ইতিহাসটি শুধু-পঠন/,'Bangla is the default localized history view after the page explains its read-only history and separate receipt action');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM stock_ledger')).n),historyLedgerBefore,'history GET cannot mutate the stock ledger');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM audit_logs')).n),historyAuditBefore,'history GET cannot mutate audit records');
    const balanceBefore=Number((await db.queryOne('SELECT balance_due_paisa FROM suppliers WHERE id=?',[supplierId])).balance_due_paisa);
    const changed=await request(editPath,{method:'POST',body:editInput});
    assert.equal(changed.status,200,changed.text.slice(0,300));
    assert.equal(Number(changed.json.supplier.status),0);
    const saved=await db.queryOne('SELECT supplier_code,name,company,contact_person,phone,email,address,tax_or_trade_id,notes,status,balance_due_paisa FROM suppliers WHERE id=?',[supplierId]);
    assert.deepEqual({name:saved.name,company:saved.company,contact_person:saved.contact_person,phone:saved.phone,email:saved.email,address:saved.address,tax_or_trade_id:saved.tax_or_trade_id,notes:saved.notes,status:Number(saved.status)},
      {name:editInput.name,company:editInput.company,contact_person:editInput.contact_person,phone:editInput.phone,email:editInput.email,address:editInput.address,tax_or_trade_id:editInput.tax_or_trade_id,notes:editInput.notes,status:0});
    assert.equal(Number(saved.balance_due_paisa),balanceBefore,'supplier profile/status update preserves payable balance');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM purchases WHERE supplier_id=?',[supplierId])).n),1,'linked purchase history is retained');
    const updateAudit=await db.queryOne("SELECT actor_id,before_json,after_json FROM audit_logs WHERE action='supplier.update' AND entity_id=? ORDER BY id DESC LIMIT 1",[String(supplierId)]);
    assert.equal(Number(updateAudit.actor_id),dashboardUserId);
    assert.equal(JSON.parse(updateAudit.before_json).status,1);
    assert.equal(JSON.parse(updateAudit.after_json).status,0);
    assert.equal(JSON.stringify(updateAudit.after_json).includes('balance_due'),false,'audit excludes financial balance fields');

    const purchaseInput={supplier_id:supplierId,reference_no:`P06-INACTIVE-${suffix}`,lines:JSON.stringify([{product_id:productId,ordered_qty:1,unit_cost_bdt:'1.00'}]),discount_bdt:'0',shipping_charge_bdt:'0',paid_amount_bdt:'0'};
    assert.equal((await request('/admin/phase06/purchases',{method:'POST',body:purchaseInput})).status,404,'inactive supplier cannot be used for a new PO');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM purchases WHERE reference_no=?',[purchaseInput.reference_no])).n),0,'blocked PO creates no purchase row');

    const active=await request(editPath,{method:'POST',body:{...editInput,status:'1'}});
    assert.equal(active.status,200,active.text.slice(0,250));
    assert.equal(Number(active.json.supplier.status),1,'supplier may be reactivated');
    const stockBefore=Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand);
    const newPo=await request('/admin/phase06/purchases',{method:'POST',body:purchaseInput});
    assert.equal(newPo.status,201,newPo.text.slice(0,300));
    assert.equal(newPo.json.purchase.status,'draft');
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),stockBefore,'PO creation does not mutate stock');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM purchases WHERE supplier_id=?',[supplierId])).n),2,'both historical and new purchase references remain linked');
    const newPurchaseId=Number(newPo.json.purchase.id);
    const purchaseItem=await db.queryOne('SELECT id FROM purchase_items WHERE purchase_id=?',[newPurchaseId]);
    const historyWithReceiveForm=await request(historyPath,{accept:'text/html'});
    assert.equal(historyWithReceiveForm.status,200);
    assert.match(historyWithReceiveForm.text,new RegExp(`/admin/phase06/purchases/${newPurchaseId}/receive`),'history page exposes the separate guarded receipt workflow');
    const receiptPath=`/admin/phase06/purchases/${newPurchaseId}/receive`;
    const receiptInput={idempotency_key:`P06-HTTP-RECEIPT-${suffix}`,history_page:'1',lines:JSON.stringify([{purchase_item_id:Number(purchaseItem.id),received_qty:1}]),note:'HTTP receipt fixture'};
    assert.equal((await request(receiptPath,{method:'POST',cookie:'',body:receiptInput})).status,401,'receipt requires admin authentication');
    assert.equal((await request(receiptPath,{method:'POST',cookie:noGrantCookie,token:noGrantToken,body:receiptInput})).status,403,'receipt requires inventory.manage');
    assert.equal((await request(receiptPath,{method:'POST',token:'',body:receiptInput})).status,403,'receipt requires CSRF');
    assert.equal((await request('/admin/phase06/purchases/999999999/receive',{method:'POST',body:receiptInput})).status,404,'missing purchase cannot be received');
    const overReceipt=await request(receiptPath,{method:'POST',body:{...receiptInput,lines:JSON.stringify([{purchase_item_id:Number(purchaseItem.id),received_qty:2}])}});
    assert.equal(overReceipt.status,409,'receipt quantity cannot exceed the PO line remainder');
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),stockBefore,'invalid receipt leaves stock unchanged');
    const formReceipt=await fetch(`${baseUrl}${receiptPath}`,{method:'POST',headers:{accept:'text/html','content-type':'application/x-www-form-urlencoded',cookie:dashboardCookie,'x-csrf-token':csrfToken},body:new URLSearchParams(receiptInput).toString(),redirect:'manual'});
    assert.equal(formReceipt.status,302,await formReceipt.text());
    assert.equal(formReceipt.headers.get('location'),`/admin/phase06/suppliers/${supplierId}/purchases?page=1`,'successful HTML receipt returns to the supplier history page');
    const replayReceipt=await request(receiptPath,{method:'POST',body:receiptInput});
    assert.equal(replayReceipt.status,200,replayReceipt.text.slice(0,250));
    assert.equal(replayReceipt.json.receipt.replayed,true,'same idempotency key replays without another stock receipt');
    assert.equal(Number((await db.queryOne('SELECT stock_on_hand FROM products WHERE id=?',[productId])).stock_on_hand),stockBefore+1,'receipt changes stock once despite replay');
    const historyAfterReceipt=await request(historyPath);
    const receivedPurchase=historyAfterReceipt.json.purchases.find((row)=>Number(row.id)===newPurchaseId);
    assert.equal(receivedPurchase.receivedQty,1);
    assert.equal(receivedPurchase.receipts.length,1);
    assert.equal(receivedPurchase.receipts[0].note,'HTTP receipt fixture');

    const nameBefore=String((await db.queryOne('SELECT name FROM suppliers WHERE id=?',[supplierId])).name);
    const auditCount=Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='supplier.update' AND entity_id=?",[String(supplierId)])).n);
    await db.execute("CREATE TRIGGER p06_http_fail_supplier_update_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture supplier update audit failure'");
    try {
      const failed=await request(editPath,{method:'POST',body:{...editInput,name:'Must roll back',status:'0'}});
      assert.equal(failed.status,500,failed.text.slice(0,300));
    } finally { await db.execute('DROP TRIGGER IF EXISTS p06_http_fail_supplier_update_audit'); }
    assert.equal(String((await db.queryOne('SELECT name FROM suppliers WHERE id=?',[supplierId])).name),nameBefore,'audit failure rolls supplier edits back');
    assert.equal(Number((await db.queryOne('SELECT status FROM suppliers WHERE id=?',[supplierId])).status),1,'audit failure rolls activation state back');
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='supplier.update' AND entity_id=?",[String(supplierId)])).n),auditCount,'failed audit is not persisted');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM purchases WHERE supplier_id=?',[supplierId])).n),2,'supplier rollback does not disturb purchase history');
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
    const {cookie:noGrantCookie}=await noGrantSession();
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
    const {cookie:noGrantCookie}=await noGrantSession();
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
    const {cookie:noGrantCookie}=await noGrantSession();
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
    const {cookie:noGrantCookie}=await noGrantSession(); const noGrantCsrf=await fetchCsrf(noGrantCookie);
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
    const {cookie:deniedCookie}=await noGrantSession();
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
