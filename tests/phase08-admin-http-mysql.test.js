'use strict';

/** Live MySQL integration test for authenticated Phase 08 admin HTTP/RBAC/CSRF paths. */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { MYSQL_HOST, MYSQL_REQUIRED, MYSQL_SKIP_REASON } = (() => {
  const host=String(process.env.MYSQL_TEST_HOST||'').trim();
  return {MYSQL_HOST:host,MYSQL_REQUIRED:process.env.MYSQL_TEST_REQUIRED==='true',MYSQL_SKIP_REASON:'SKIPPED locally: no local mysqld/docker; required on GitHub Actions mysql:8.0 service'};
})();
if(MYSQL_REQUIRED&&!MYSQL_HOST)throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
process.env.NODE_ENV='test';process.env.LOG_SILENT='true';
if(MYSQL_HOST){process.env.DB_CLIENT='mysql';process.env.DB_HOST=MYSQL_HOST;process.env.DB_PORT=String(process.env.MYSQL_TEST_PORT||3306);process.env.DB_NAME=process.env.MYSQL_TEST_DB||'mrtumi_test';process.env.DB_USER=process.env.MYSQL_TEST_USER||'mrtumi_test';process.env.DB_PASSWORD=process.env.MYSQL_TEST_PASSWORD||'mrtumi_test_pw';}
const {getPool,createQueryClient,closePool}=require('../src/db/mysqlPool');
const {migrateUp,migrateDown}=require('../src/db/migrator');
const phase08=require('../src/repositories/phase08Repository');
const {attachCsrfToken}=require('../src/middleware/csrf');
const adminAuth=require('../src/routes/adminAuth');
const phase08Admin=require('../src/routes/phase08Admin');

describe('Phase 08 — authenticated MySQL admin HTTP, RBAC, CSRF, replay and audit',{skip:!MYSQL_HOST&&!MYSQL_REQUIRED?MYSQL_SKIP_REASON:false},()=>{
  let pool,db,server,baseUrl,productId,orderId,invoice,staff={};
  const testPassword=crypto.randomBytes(18).toString('hex');
  const grantMap={
    orders:['orders.manage'],refunds:['refunds.review'],recoveryView:['checkout.recovery.view'],
    recoveryManager:['checkout.recovery.view','checkout.recovery.manage'],settings:['settings.manage'],
  };
  before(async()=>{
    if(!MYSQL_HOST)return;
    pool=getPool();db=createQueryClient(pool);await migrateDown(pool,{steps:12});await migrateUp(pool);
    for(const [key,permissions] of Object.entries(grantMap)){
      const suffix=`${Date.now()}-${key}`;
      const role=(await db.execute('INSERT INTO roles (name,slug,status) VALUES (?,?,1)',[`P08 ${key}`,`p08_${suffix}`])).insertId;
      for(const permission of permissions){
        await db.execute('INSERT INTO permissions (name,module,description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',[permission,'phase08','CI-scoped Phase 08 permission']);
        const perm=await db.queryOne('SELECT id FROM permissions WHERE name=?',[permission]);
        await db.execute('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)',[role,perm.id]);
      }
      const email=`${key}-${suffix}@example.invalid`;
      const user=(await db.execute('INSERT INTO users (role_id,name,email,phone,password_hash,role_label,status) VALUES (?,?,?,?,?,?,1)',[role,`P08 ${key}`,email,'01712345678',bcrypt.hashSync(testPassword,8),'Staff'])).insertId;
      staff[key]={email,userId:user,roleId:role};
    }
    const product=(await db.execute("INSERT INTO products (sku,slug,name_bn,name_en,regular_price_paisa,sale_price_paisa,stock_on_hand,stock_reserved,approval_status,status) VALUES ('P08-HTTP-001','p08-http-product','পরীক্ষা পণ্য','HTTP test product',10000,8000,8,0,'approved',1)")).insertId;
    productId=Number(product);
    invoice=`P08HTTP-${Date.now()}`;
    orderId=Number((await db.execute("INSERT INTO orders (invoice_no,customer_name,customer_phone,shipping_address,subtotal_paisa,total_paisa,paid_paisa,cod_due_paisa,order_status,payment_status) VALUES (?,'Admin HTTP Customer','01712345678','Authorized test fixture address',5000,5000,5000,0,'pending','unpaid')",[invoice])).insertId);
    await db.execute('INSERT INTO order_items (order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa) VALUES (?,?,?,5000,1,5000)',[orderId,productId,'Admin HTTP fixture']);
    const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));app.use(session({secret:'phase08-http-test-session-secret',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax'}}));app.use(attachCsrfToken);
    app.use((req,res,next)=>{req.adminUser=req.session.adminUser||null;req.locale='en';req.flash=()=>{};res.render=(view,locals={})=>res.json({view,locals});next();});
    app.get('/__test/csrf',(req,res)=>res.json({token:req.csrfToken()}));
    app.use(adminAuth);app.use(phase08Admin);
    app.use((err,req,res,_next)=>res.status(err.statusCode||500).json({error:err.code||'ERROR',message:err.message}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));baseUrl=`http://127.0.0.1:${server.address().port}`;
  });
  after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(MYSQL_HOST)await closePool();});

  async function request(path,{method='GET',cookie='',body=null,csrf='',headers={}}={}){
    const h={accept:'application/json',...headers};if(cookie)h.cookie=cookie;if(csrf)h['x-csrf-token']=csrf;
    if(body!==null&&!h['content-type']){h['content-type']='application/json';body=JSON.stringify(body);}
    const response=await fetch(`${baseUrl}${path}`,{method,headers:h,body:body===null?undefined:body,redirect:'manual'});
    const text=await response.text();let json=null;try{json=JSON.parse(text);}catch{}
    return{status:response.status,headers:response.headers,text,json};
  }
  async function login(user){
    const csrfResponse=await request('/__test/csrf');const csrfCookie=csrfResponse.headers.get('set-cookie');
    const csrf=csrfResponse.json.token;
    const response=await request('/admin/login',{method:'POST',cookie:csrfCookie.split(';')[0],csrf,body:new URLSearchParams({email:user.email,password:testPassword}).toString(),headers:{'content-type':'application/x-www-form-urlencoded'}});
    assert.equal(response.status,302,'real admin login should create the test role session');
    const raw=response.headers.get('set-cookie');assert.ok(raw);return raw.split(';')[0];
  }
  async function token(cookie){const r=await request('/__test/csrf',{cookie});assert.equal(r.status,200);return r.json.token;}

  test('real login-backed role permissions protect orders, refunds, recovery, settings and OTP status over HTTP',async t=>{
    if(!MYSQL_HOST)return t.skip(MYSQL_SKIP_REASON);
    const unauth=await request('/admin/phase08/orders');assert.equal(unauth.status,401);
    const orderStaff=await login(staff.orders),orderToken=await token(orderStaff);
    const refundStaff=await login(staff.refunds),refundToken=await token(refundStaff);
    const viewStaff=await login(staff.recoveryView),viewToken=await token(viewStaff);
    const recoveryStaff=await login(staff.recoveryManager),recoveryToken=await token(recoveryStaff);
    const settingsStaff=await login(staff.settings),settingsToken=await token(settingsStaff);

    assert.equal((await request('/admin/phase08/orders',{cookie:refundStaff})).status,403,'refund-only role cannot view orders');
    assert.equal((await request('/admin/phase08/refunds',{cookie:orderStaff})).status,403,'order role cannot review refunds');
    assert.equal((await request('/admin/phase08/incomplete',{cookie:orderStaff})).status,403,'order role cannot view recovery PII');
    assert.equal((await request('/admin/phase08/settings',{cookie:orderStaff})).status,403,'order role cannot edit policy settings');
    assert.equal((await request(`/admin/phase08/orders/${orderId}/otp`,{cookie:refundStaff})).status,403,'OTP status follows orders.manage permission');
    assert.equal((await request('/admin/phase08/orders',{cookie:orderStaff})).status,200);

    const deniedCsrf=await request(`/admin/phase08/orders/${orderId}/status`,{method:'POST',cookie:orderStaff,body:{status:'confirmed',reason:'no csrf',request_key:'p08-http-nocsrf'}});
    assert.equal(deniedCsrf.status,403);
    const badTransition=await request(`/admin/phase08/orders/${orderId}/status`,{method:'POST',cookie:orderStaff,csrf:orderToken,body:{status:'shipped',reason:'invalid jump',request_key:'p08-http-invalid'}});
    assert.equal(badTransition.status,409);
    const auditBefore = Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='order.status.confirmed' AND entity_id=?",[String(orderId)])).n);
    const key=`p08-http-confirm-${orderId}`;
    const concurrent=await Promise.all([1,2].map(()=>request(`/admin/phase08/orders/${orderId}/status`,{method:'POST',cookie:orderStaff,csrf:orderToken,body:{status:'confirmed',reason:'confirm fixture',request_key:key}})));
    assert.ok(concurrent.every(x=>x.status===200));assert.equal(concurrent.filter(x=>x.json.replayed).length,1,'concurrent same-key transition has one replay');
    const changedReplay=await request(`/admin/phase08/orders/${orderId}/status`,{method:'POST',cookie:orderStaff,csrf:orderToken,body:{status:'processing',reason:'same key changed',request_key:key}});
    assert.equal(changedReplay.status,409);
    const otp=await phase08.createOrderOtp('01712345678',{orderId,policy:{enabled:true,expirySeconds:300,maxAttempts:3,cooldownSeconds:30,maxPerHour:3}});
    assert.equal(otp.deliveryRequired,true);
    const otpStatus=await request(`/admin/phase08/orders/${orderId}/otp`,{cookie:orderStaff});
    assert.equal(otpStatus.status,200);assert.equal(otpStatus.json.issuedCount,1);assert.equal(otpStatus.json.status,'not_required');
    assert.doesNotMatch(otpStatus.text,/otp_hash|01712345678|"code"/,'OTP admin status exposes no secret or customer phone');
    const cancelled=await request(`/admin/phase08/orders/${orderId}/status`,{method:'POST',cookie:orderStaff,csrf:orderToken,body:{status:'cancelled',reason:'release CI stock before refund review',request_key:`p08-http-cancel-${orderId}`}});
    assert.equal(cancelled.status,200);assert.equal(Number((await db.queryOne('SELECT stock_reserved FROM products WHERE id=?',[productId])).stock_reserved),0,'admin cancellation releases inventory');

    const refund=await phase08.requestRefund(orderId,3000,'HTTP review fixture',`p08-http-refund-${orderId}`);
    assert.equal((await request('/admin/phase08/refunds',{cookie:refundStaff})).status,200);
    assert.equal((await request(`/admin/phase08/refunds/${refund.id}/decision`,{method:'POST',cookie:refundStaff,body:{status:'approved',reason:'missing csrf',request_key:'p08-http-refund-nocsrf'}})).status,403);
    const invalidRefund=await request(`/admin/phase08/refunds/${refund.id}/decision`,{method:'POST',cookie:refundStaff,csrf:refundToken,body:{status:'succeeded',reason:'cannot settle',request_key:'p08-http-refund-invalid'}});
    assert.equal(invalidRefund.status,400,'admin HTTP rejects provider settlement status because only approve/reject is available');
    const decisionKey=`p08-http-approve-${refund.id}`;
    const approved=await request(`/admin/phase08/refunds/${refund.id}/decision`,{method:'POST',cookie:refundStaff,csrf:refundToken,body:{status:'approved',reason:'manual evidence review',request_key:decisionKey}});
    assert.equal(approved.status,200);assert.equal(approved.json.status,'approved');
    assert.equal((await request(`/admin/phase08/refunds/${refund.id}/decision`,{method:'POST',cookie:refundStaff,csrf:refundToken,body:{status:'approved',reason:'manual evidence review',request_key:decisionKey}})).json.replayed,true);
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM order_payments WHERE order_id=?',[orderId])).n),0,'admin approval records a decision only; no external refund/payment settlement occurs');

    const capture=await phase08.recordIncompleteCheckout({consent:true,notificationConsent:false,sessionSid:`admin-http-session-${Date.now()}-abcdefghijkl`,phone:'01812345678',name:'Recovery HTTP Customer',cart:[{product_id:productId,qty:2,price:1}]});
    assert.equal(capture.recorded,true);
    assert.equal((await request('/admin/phase08/incomplete',{cookie:orderStaff})).status,403);
    const recoveryList=await request('/admin/phase08/incomplete?status=abandoned',{cookie:viewStaff});assert.equal(recoveryList.status,200);
    assert.ok(recoveryList.json.locals.rows.some(row=>Number(row.id)===capture.id));
    const deniedRecovery=await request(`/admin/phase08/incomplete/${capture.id}/status`,{method:'POST',cookie:viewStaff,body:{status:'contacted',reason:'no manage grant'}});assert.equal(deniedRecovery.status,403);
    const noRecoveryCsrf=await request(`/admin/phase08/incomplete/${capture.id}/status`,{method:'POST',cookie:recoveryStaff,body:{status:'contacted',reason:'no token'}});assert.equal(noRecoveryCsrf.status,403);
    const recovered=await request(`/admin/phase08/incomplete/${capture.id}/status`,{method:'POST',cookie:recoveryStaff,csrf:recoveryToken,body:{status:'contacted',reason:'consent-based manual contact'}});assert.equal(recovered.status,200);assert.equal(recovered.json.status,'contacted');
    assert.equal(Number((await db.queryOne('SELECT notification_allowed FROM incomplete_orders WHERE id=?',[capture.id])).notification_allowed),0,'no recovery message consent is implied');

    const noSettingsCsrf=await request('/admin/phase08/settings',{method:'POST',cookie:settingsStaff,body:{advance_payment_mode:'percent',advance_payment_value:20}});assert.equal(noSettingsCsrf.status,403);
    const invalidSettings=await request('/admin/phase08/settings',{method:'POST',cookie:settingsStaff,csrf:settingsToken,body:{advance_payment_mode:'unverified',advance_payment_value:20}});assert.equal(invalidSettings.status,400);
    assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action='order.status.confirmed' AND entity_id=?",[String(orderId)])).n),auditBefore+1,'order transition audit is written once despite HTTP replay');
  });
});
