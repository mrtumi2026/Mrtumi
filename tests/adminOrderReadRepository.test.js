'use strict';
process.env.LOG_SILENT='true';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const repository=require('../src/repositories/adminOrderReadRepository');

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
