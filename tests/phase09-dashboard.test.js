'use strict';

process.env.LOG_SILENT = 'true';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const repo = require('../src/repositories/adminDashboardRepository');
const { policyForAdminRoute,legacyAdminRbac,legacyAdminCsrf } = require('../src/middleware/legacyAdminRbac');
const { createLegacyAdminAudit } = require('../src/middleware/legacyAdminAudit');
const { collectAdminRoutes } = require('./helpers/adminRouteInventory');

describe('Phase 09 dashboard repository contract', () => {
  test('dashboard route delegates MySQL-mode reads to repository; SQLite calls stay only in explicit local branches', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/adminDashboard.js'), 'utf8');
    assert.match(source, /if \(env\.db\.client === 'mysql'\)\s*\{\s*return res\.render\('admin\/dashboard', await dashboardRepository\.getDashboardData\(\)\)/);
    assert.match(source, /router\.use\('\/admin', requireAdmin\)/);
    assert.match(source, /router\.get\('\/admin\/dashboard', requirePermission\('dashboard\.view'\)/);
    assert.match(source, /router\.get\('\/admin\/orders\/poll-new', requirePermission\('orders\.poll'\)/);
    assert.match(source, /router\.post\('\/admin\/gemini-chat\/send', requirePermission\('assistant\.report'\), requireCsrf/);
    assert.match(source, /dashboardRepository\.getPollNewOrders/);
    assert.match(source, /dashboardRepository\.getUnseenOrders/);
    assert.doesNotMatch(source, /18420|1485\.50|342 \/ 5,000|25 Nov 2026|Pro Business Plan/);
  });

  test('route inventory has an explicit allow/deny permission decision and CSRF policy for every unique active admin endpoint', () => {
    const routes=collectAdminRoutes();
    assert.ok(routes.length>=250);
    for(const route of routes){
      const policy=policyForAdminRoute(route.method,route.path);
      if(policy.exempt)continue;
      assert.ok(policy.key,`${route.method} ${route.path} has a policy key`);
      assert.notEqual(policy.unmapped,true,`${route.method} ${route.path} must not fall through to unmapped policy`);
      let allowedError=null; legacyAdminRbac({method:route.method,path:route.path,adminUser:{id:1,role_slug:'p09_test',permissions:[policy.key,...(policy.also||[])]}},{},err=>{allowedError=err||null;});
      assert.equal(allowedError,null,`${route.method} ${route.path} allows its assigned permission`);
      let deniedError=null; legacyAdminRbac({method:route.method,path:route.path,adminUser:{id:2,role_slug:'p09_no_grants',permissions:[]}},{},err=>{deniedError=err||null;});
      assert.equal(deniedError.statusCode,403,`${route.method} ${route.path} denies a user without grants`);
    }
    let csrfError=null; legacyAdminCsrf({method:'POST',path:'/admin/order/create',adminUser:{id:1},session:{}},{},err=>{csrfError=err||null;});
    assert.equal(csrfError.statusCode,403,'authenticated state-changing admin requests require CSRF');
    let safeError=null; legacyAdminCsrf({method:'GET',path:'/admin/order/create',adminUser:{id:1},session:{}},{},err=>{safeError=err||null;});
    assert.equal(safeError,null,'safe methods do not require CSRF');
    let uploadParseError=null;
    legacyAdminCsrf({method:'POST',path:'/admin/phase06/products/12/gallery/upload',adminUser:{id:3},session:{},headers:{'content-type':'multipart/form-data; boundary=fixture'}},{},err=>{uploadParseError=err||null;});
    assert.equal(uploadParseError,null,'the exact multipart gallery endpoint defers CSRF validation until Multer parses its body');
    let unrelatedMultipartError=null;
    legacyAdminCsrf({method:'POST',path:'/admin/phase06/products/12/gallery',adminUser:{id:3},session:{},headers:{'content-type':'multipart/form-data; boundary=fixture'}},{},err=>{unrelatedMultipartError=err||null;});
    assert.equal(unrelatedMultipartError.statusCode,403,'the multipart CSRF exception does not extend to other admin routes');
  });

  test('order-status repository validates definition fields and legacy admin routes delegate MySQL CRUD safely', () => {
    const orderStatuses = require('../src/repositories/adminOrderStatusRepository');
    assert.equal(orderStatuses.normalizeSlug({name:'Needs Review'}),'needs-review');
    assert.equal(orderStatuses.normalizeColor({color:'#AABBCC'}),'#aabbcc');
    assert.equal(orderStatuses.normalizeSortOrder('0'),0);
    assert.throws(()=>orderStatuses.normalizeSlug({slug:'---'}),{code:'VALIDATION_ERROR'});
    assert.throws(()=>orderStatuses.normalizeColor({color:'url(javascript:alert(1))'}),{code:'VALIDATION_ERROR'});
    assert.throws(()=>orderStatuses.normalizeSortOrder('-1'),{code:'VALIDATION_ERROR'});
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/adminOrders.js'), 'utf8');
    assert.match(source, /adminOrderStatusRepository\.listOrderStatuses\(\)/);
    assert.match(source, /adminOrderStatusRepository\.createOrderStatus\(req\.body/);
    assert.match(source, /adminOrderStatusRepository\.deactivateOrderStatus\(req\.params\.id/);
    assert.match(source, /Order-status definitions are retained to preserve historical order labels/);
  });

  test('MySQL POS normalizes unique product quantities and rejects invalid or excessive cart input before persistence', () => {
    const pos = require('../src/repositories/adminPosRepository');
    assert.deepEqual(pos.parsePosLines(JSON.stringify([{id:9,qty:2},{product_id:'3',qty:1},{id:9,qty:3}])),[
      {productId:3,qty:1},{productId:9,qty:5},
    ]);
    for(const input of [[],{},'not-json',JSON.stringify([{id:1,qty:0}]),JSON.stringify([{id:1,qty:1.5}]),JSON.stringify([{id:-1,qty:1}]),JSON.stringify([{id:1,qty:100001}])]) {
      assert.throws(()=>pos.parsePosLines(input),{code:'VALIDATION_ERROR'});
    }
    assert.throws(()=>pos.parsePosLines([{id:1,qty:100000},{id:1,qty:1}]),{code:'VALIDATION_ERROR'});
    const source=fs.readFileSync(path.join(__dirname,'../src/routes/adminOrders.js'),'utf8');
    assert.match(source,/adminPosRepository\.listPosFormData\(\)/);
    assert.match(source,/adminPosRepository\.createPosOrder\(req\.body/);
    assert.match(source,/id: req\.adminUser\?\.id[\s\S]{0,100}userAgent: req\.get\('user-agent'\)/);
    const view=fs.readFileSync(path.join(__dirname,'../views/admin/pos.ejs'),'utf8');
    assert.match(view,/name="_csrf" value="<%= csrfToken/);
  });

  test('MySQL order mutation routes delegate to transactional repositories and shared state-machine transitions', () => {
    const orders = require('../src/repositories/adminOrderMutationRepository');
    assert.equal(orders.normalizeOrderQty('3'),3);
    assert.throws(()=>orders.normalizeOrderQty('1.25'),{code:'VALIDATION_ERROR'});
    assert.throws(()=>orders.normalizeOrderQty('-1'),{code:'VALIDATION_ERROR'});
    assert.equal(orders.recalculateTotals({subtotalPaisa:10000,shippingPaisa:2500,discountPaisa:500,paidPaisa:0}).totalPaisa,12000);
    assert.throws(()=>orders.recalculateTotals({subtotalPaisa:1000,shippingPaisa:0,discountPaisa:0,paidPaisa:1001}),{code:'CONFLICT'});
    const route=fs.readFileSync(path.join(__dirname,'../src/routes/adminOrders.js'),'utf8');
    assert.match(route,/adminOrderMutationRepository\.addOrderItem/);
    assert.match(route,/adminOrderMutationRepository\.updateOrderItem/);
    assert.match(route,/adminOrderMutationRepository\.updateAdminOrder/);
    assert.match(route,/adminOrderMutationRepository\.transitionOrder\(/);
    assert.match(route,/adminOrderMutationRepository\.bulkOrderAction/);
    const lifecycle=require('../src/repositories/phase08Repository');
    assert.equal(typeof lifecycle.transitionOrderTx,'function','compound order updates reuse the established transition transaction behavior');
    const detail=fs.readFileSync(path.join(__dirname,'../views/admin/order-detail.ejs'),'utf8');
    assert.match(detail,/name="request_key"/,'order-detail writes carry retry-stable request keys');
    const list=fs.readFileSync(path.join(__dirname,'../views/admin/orders.ejs'),'utf8');
    assert.match(list,/name="request_key"/,'quick and bulk status writes carry retry-stable request keys');
  });

  test('MySQL finance and payment read routes delegate to canonical integer-paisa queries and remain read-only', () => {
    const finance=require('../src/repositories/adminFinanceReadRepository');
    for(const method of ['listPaymentRecords','listFundTransactions','getFundSummary','listExpenses','getReport'])assert.equal(typeof finance[method],'function');
    const operations=fs.readFileSync(path.join(__dirname,'../src/routes/adminOperations.js'),'utf8');
    assert.match(operations,/adminFinanceReadRepository\.listPaymentRecords/);
    assert.match(operations,/adminFinanceReadRepository\.listFundTransactions/);
    assert.match(operations,/adminFinanceReadRepository\.getFundSummary/);
    assert.match(operations,/adminFinanceReadRepository\.listExpenses/);
    const settings=fs.readFileSync(path.join(__dirname,'../src/routes/adminSettings.js'),'utf8');
    assert.match(settings,/adminFinanceReadRepository\.getReport\(type\)/);
    const policy=policyForAdminRoute('GET','/admin/payment-records');
    assert.equal(policy.key,'finance.view');assert.equal(policy.auditRead,true);
    const routeInventory=collectAdminRoutes();
    assert.ok(routeInventory.some((route)=>route.method==='GET'&&route.path==='/admin/payment-records'));
    assert.doesNotMatch(operations,/router\.post\('\/admin\/payment-records/,'payment record page exposes no mutation endpoint');
  });

  test('complaint repository validates before persistence and MySQL admin routes delegate safe actions', async () => {
    const complaints = require('../src/repositories/adminComplaintRepository');
    await assert.rejects(complaints.createComplaint({name:'A',phone:'bad',invoice_id:'',details:'issue'}), { code:'VALIDATION_ERROR', statusCode:400 });
    await assert.rejects(complaints.createComplaint({name:'Valid Name',phone:'01712345678',invoice_id:'',details:'x'}), { code:'VALIDATION_ERROR', statusCode:400 });
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/adminOperations.js'), 'utf8');
    assert.match(source, /env\.db\.client === 'mysql'[\s\S]{0,120}adminComplaintRepository\.listComplaints\(\)/);
    assert.match(source, /adminComplaintRepository\.createComplaint\(req\.body/);
    assert.match(source, /adminComplaintRepository\.resolveComplaint\(req\.params\.id/);
    assert.match(source, /router\.post\('\/admin\/complaints\/delete\/:id', \(req, res, next\)/,'complaint deletion is retained only as an explicit guarded route');
    assert.match(source, /Complaint deletion is disabled pending an approved data-retention policy/);
    assert.match(source, /adminComplaintRepository\.listContactMessages\(\)/);
    assert.match(source, /Contact-message deletion is disabled pending an approved data-retention policy/);
  });

  test('HR employee repository validates calendar dates and MySQL admin routes delegate reads and writes', () => {
    const employeeRepository = require('../src/repositories/hrmEmployeeRepository');
    assert.equal(employeeRepository.dateOnly('2024-02-29'), '2024-02-29');
    for (const value of ['', '2023-02-29', '2024-13-01', '2024-1-01', 'not-a-date']) {
      assert.throws(() => employeeRepository.dateOnly(value), { code: 'VALIDATION_ERROR' });
    }
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/adminOperations.js'), 'utf8');
    assert.match(source, /env\.db\.client === 'mysql'[\s\S]{0,100}hrmEmployeeRepository\.listEmployees\(\)/);
    assert.match(source, /hrmEmployeeRepository\.createEmployee\(req\.body/);
    assert.match(source, /hrmEmployeeRepository\.deactivateEmployee\(req\.params\.id/);
  });

  test('legacy admin audit writer failure does not report a successful mutation', async () => {
    let writtenEvent=null;
    const app=express();
    app.use((req,_res,next)=>{req.adminUser={id:17};req.adminRoutePolicy={key:'catalog.manage',audit:true};req.id='test-request';next();});
    app.use(createLegacyAdminAudit({writer:async event=>{writtenEvent=event;throw new Error('sensitive backend detail');},loggerInstance:{error(){}}}));
    app.post('/admin/products/create',(req,res)=>res.redirect('/admin/products/manage'));
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    try{
      const response=await fetch(`http://127.0.0.1:${server.address().port}/admin/products/create`,{method:'POST',headers:{accept:'application/json'}});
      const body=await response.json();
      assert.equal(response.status,503);assert.equal(body.error,'AUDIT_UNAVAILABLE');
      assert.match(body.message,/may have been applied/);
      assert.equal(writtenEvent.actorId,17);assert.equal(writtenEvent.action,'admin.legacy.catalog.manage.mutation');
      assert.equal(Object.hasOwn(writtenEvent,'requestBody'),false);
    }finally{await new Promise(resolve=>server.close(resolve));}
  });

  test('sensitive CSV exports emit a minimized audit event before response', async () => {
    let event=null;
    const app=express();
    app.use((req,_res,next)=>{req.adminUser={id:19};req.adminRoutePolicy={key:'reports.view',auditRead:true};next();});
    app.use(createLegacyAdminAudit({writer:async value=>{event=value;},loggerInstance:{error(){}}}));
    app.get('/admin/reports/orders',(req,res)=>res.type('text/csv').send('id\\n1'));
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    try{
      const response=await fetch(`http://127.0.0.1:${server.address().port}/admin/reports/orders?export=csv`);
      assert.equal(response.status,200);assert.match(await response.text(),/id/);
      assert.equal(event.action,'admin.legacy.reports.export');assert.equal(event.entityType,'admin_report');
      assert.deepEqual(event.afterState,{method:'GET',path:'/admin/reports/orders',permission:'reports.view',status:200,format:'csv'});
    }finally{await new Promise(resolve=>server.close(resolve));}
  });

  test('MySQL repository uses bound params, converts paisa, and sanitizes database failures', async () => {
    const calls = [];
    const pool = { async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM orders') && sql.includes('total_orders')) return [[{ total_orders: 0, pending_orders: 0, delivered_count: 0, delivered_paisa: 0 }]];
      if (sql.includes('FROM orders WHERE created_at >=')) return [[{ order_count: 0, revenue_paisa: 0, delivered_paisa: 0 }]];
      if (sql.includes('GROUP BY dhaka_day')) return [[]];
      if (sql.includes('GROUP BY source')) return [[]];
      if (sql.includes('FROM order_statuses')) return [[]];
      if (sql.includes('FROM products WHERE')) return [[{ count: 0 }]];
      if (sql.includes('FROM products p')) return [[]];
      if (sql.includes('FROM categories c')) return [[]];
      if (sql.includes('FROM orders o')) return [[]];
      if (sql.includes('FROM fund_transactions')) return [[{ credits: 0, debits: 0 }]];
      if (sql.includes('FROM expenses')) return [[{ total: 0, today: 0, monthly: 0 }]];
      throw new Error(`Unexpected SQL in test: ${sql}`);
    } };
    const data = await repo.getDashboardData({ pool, now: new Date('2026-10-26T06:00:00Z') });
    assert.equal(data.totalOrders, 0);
    assert.equal(data.totalRevenue, 0);
    assert.equal(data.totalProducts, 0);
    assert.equal(data.dashboardProducts.length, 0);
    assert.equal(data.trendData.length, 7);
    assert.deepEqual(data.trendData, Array(7).fill(0));
    assert.ok(calls.every((c) => Array.isArray(c.params)), 'repository parameterizes all DB calls');
    assert.ok(calls.some((c) => c.sql.includes('total_paisa')));
    assert.ok(calls.some((c) => c.sql.includes('amount_paisa')));
    const failingPool = { async query() { const err = new Error('private connection string'); err.code = 'ER_NO_SUCH_TABLE'; throw err; } };
    await assert.rejects(repo.getDashboardData({ pool: failingPool }), (err) => {
      assert.equal(err.code, 'DB_QUERY_FAILED');
      assert.doesNotMatch(err.message, /private connection string|SELECT/);
      return true;
    });
  });
});
