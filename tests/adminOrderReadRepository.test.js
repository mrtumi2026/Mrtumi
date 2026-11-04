'use strict';
process.env.LOG_SILENT='true';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const repository=require('../src/repositories/adminOrderReadRepository');
const { allowedAdminTransitionTargets }=require('../src/repositories/adminOrderMutationRepository');
const { loadMigrationPairs,splitSqlStatements }=require('../src/db/migrator');

test('admin order list applies bound status/search filters, bounded pagination, and real counts',async()=>{
  const calls=[];
  const pool={async query(sql,params=[]){calls.push({sql,params});
    if(sql.includes('SELECT COUNT(*) AS c FROM orders o'))return [[{c:31}],[]];
    if(sql.includes('SELECT COUNT(*) AS c FROM orders'))return [[{c:81}],[]];
    if(sql.includes('order_status AS status'))return [[{status:'pending',c:12}],[]];
    if(sql.includes('slug,name,badge_class,color'))return [[],[]];
    return [[],[]];
  }};
  const result=await repository.listAdminOrders({statusParam:'pending',searchQuery:'MT-abc',page:2,perPage:10},pool);
  const pageQuery=calls.find(({sql})=>sql.includes('LIMIT ? OFFSET ?'));
  assert.match(pageQuery.sql,/LIMIT \? OFFSET \?/);
  assert.deepEqual(pageQuery.params,['pending','%MT-abc%','%MT-abc%','%MT-abc%',10,10]);
  assert.deepEqual(result.pagination,{page:2,perPage:10,total:31,totalPages:4});
  assert.equal(result.statusCounts.all,81);assert.equal(result.statusCounts.pending,12);
});

test('admin order action targets are the intersection of lifecycle transitions and admin-safe targets',()=>{
  assert.deepEqual(allowedAdminTransitionTargets('pending'),['confirmed']);
  assert.deepEqual(allowedAdminTransitionTargets('confirmed'),['processing']);
  assert.deepEqual(allowedAdminTransitionTargets('processing'),['shipped']);
  for(const terminal of ['shipped','delivered','cancelled','failed','returned','completed','unknown'])
    assert.deepEqual(allowedAdminTransitionTargets(terminal),[]);
});

test('admin list returns localized-definition records separately from each order legal targets',async()=>{
  const statuses=[
    {slug:'pending',name:'Pending'}, {slug:'confirmed',name:'Confirmed'},
    {slug:'processing',name:'Processing'}, {slug:'shipped',name:'Shipped'},
  ];
  const pool={async query(sql){
    if(sql.includes('SELECT o.id,o.invoice_no'))return [[
      {id:1,status:'pending',total_paisa:5000}, {id:2,status:'processing',total_paisa:6000},
    ],[]];
    if(sql.includes('SELECT slug,name,badge_class,color,sort_order FROM order_statuses'))return [statuses,[]];
    if(sql.includes('order_status AS status'))return [[{status:'pending',c:1},{status:'processing',c:1}],[]];
    if(sql.includes('SELECT COUNT(*) AS c FROM orders o'))return [[{c:2}],[]];
    if(sql.includes('SELECT COUNT(*) AS c FROM orders'))return [[{c:2}],[]];
    return [[],[]];
  }};
  const result=await repository.listAdminOrders({},pool);
  assert.deepEqual(result.statuses,statuses);
  assert.deepEqual(result.orders.map(order=>order.allowed_status_targets.map(status=>status.slug)),[['confirmed'],['shipped']]);
});

test('canonical status seed migration is additive, idempotent and preserves display rows on rollback',()=>{
  const migration=loadMigrationPairs().find(pair=>pair.version==='0026');
  assert.ok(migration);
  assert.match(migration.name,/seed_canonical_order_statuses/);
  const up=splitSqlStatements(migration.upSql);
  assert.equal(up.length,1);
  assert.match(up[0],/INSERT IGNORE INTO `order_statuses`/);
  const slugs=['pending','confirmed','processing','shipped','delivered','return_requested','cancelled','failed','returned','completed'];
  for(const slug of slugs)assert.match(up[0],new RegExp(`'${slug}'`));
  assert.doesNotMatch(up[0],/'(on-the-way|in-courier|unpaid)'/);
  assert.deepEqual(splitSqlStatements(migration.downSql),['SELECT 1']);
  assert.doesNotMatch(migration.downSql,/DELETE FROM `order_statuses`|DROP TABLE/i);
});

test('admin order detail includes the canonical status history projection',async()=>{
  const calls=[];
  const pool={async query(sql,params=[]){calls.push({sql,params});
    if(sql.includes('FROM orders o')&&sql.includes('WHERE o.id=?'))return [[{id:4,subtotal_paisa:10000,shipping_paisa:500,discount_paisa:0,total_paisa:10500}],[]];
    if(sql.trimStart().startsWith('UPDATE orders'))return [{affectedRows:1},[]];
    if(sql.includes('order_status_history'))return [[{id:8,from_status:'pending',to_status:'cancelled',note:'Customer request'}],[]];
    return [[],[]];
  }};
  const result=await repository.getAdminOrderDetail(4,pool);
  assert.deepEqual(result.statusHistory,[{id:8,from_status:'pending',to_status:'cancelled',note:'Customer request'}]);
  assert.ok(calls.some(({sql})=>sql.includes('LEFT JOIN users u')));
});
