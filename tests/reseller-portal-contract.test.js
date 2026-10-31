'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.NODE_ENV='test';process.env.DB_CLIENT='mysql';process.env.LOG_SILENT='true';
const repo=require('../src/repositories/resellerPortalRepository');
function fakePool(responses){const calls=[];return {calls,async query(sql,params){calls.push({sql,params});const result=responses(sql,params);return [result,[]];}};}
test('reseller order list pagination/filter binds tenant first and returns only the tenant-bound rows',async()=>{
 const pool=fakePool((sql)=>sql.includes('COUNT(*)')?[{total:1}]:[{id:71,invoice_id:'OWN-71'}]);
 const result=await repo.listOrders(11,{page:2,perPage:10,status:'pending',search:'own'},pool);
 assert.equal(result.total,1);assert.equal(result.orders[0].id,71);
 const [count,rows]=pool.calls;assert.match(count.sql,/WHERE reseller_id=\?/);assert.deepEqual(count.params,[11,'pending','%own%','%own%']);
 assert.match(rows.sql,/o\.reseller_id|reseller_id/);assert.match(rows.sql,/LIMIT \? OFFSET \?/);assert.equal(rows.params[0],11);assert.deepEqual(rows.params.slice(-2),[10,0]);assert.ok(!/LIMIT \s*\d/.test(rows.sql));
});
test('reseller order detail denies a foreign tenant and queries canonical order items only after ownership succeeds',async()=>{
 const denied=fakePool(()=>[]);await assert.rejects(()=>repo.getOrderDetails(22,71,denied),{code:'NOT_FOUND'});assert.match(denied.calls[0].sql,/id=\? AND reseller_id=\?/);assert.deepEqual(denied.calls[0].params,[71,22]);assert.equal(denied.calls.length,1);
 const own=fakePool(sql=>sql.includes('FROM orders')?[{id:71}]:[{product_name:'item'}]);const detail=await repo.getOrderDetails(11,71,own);assert.equal(detail.items.length,1);assert.match(own.calls[1].sql,/FROM order_items WHERE order_id=\?/);assert.deepEqual(own.calls[1].params,[71]);
});
test('reseller transaction reads use canonical tx_type and integer amount_paisa with a tenant predicate',async()=>{
 const pool=fakePool(sql=>sql.includes('COUNT(*)')?[{total:1}]:[{id:8,amount_paisa:'12345'}]);const result=await repo.listTransactions(11,'deposit',{page:1},pool);const data=pool.calls[1];assert.match(data.sql,/tx_type,amount_paisa/);assert.match(data.sql,/reseller_id=\? AND tx_type=\?/);assert.ok(!/amount_paisa\s*\//.test(data.sql));assert.deepEqual(data.params,[11,'deposit',20,0]);assert.equal(result.transactions[0].amount_paisa,'12345');
});
test('reseller order and wallet mutations stay CSRF protected and fail closed in MySQL mode',()=>{
 const fs=require('node:fs');const source=fs.readFileSync(require.resolve('../src/routes/resellerPanel'),'utf8');
 for(const route of ['/reseller/orders/create','/reseller/deposits/create','/reseller/withdrawals/create','/reseller/profile','/reseller/logout']) assert.match(source,new RegExp(`router\\.post\\(['"]${route.replaceAll('/','\\/')}['"],\\s*requireCsrf`));
 assert.match(source,/if \(mysqlActive\(\)\) return res\.status\(409\)\.render\('reseller\/unsupported-operation'/);
 assert.match(source,/rotateResellerSession\(req, reseller/);assert.match(source,/rotateResellerSession\(req, null/);
});
