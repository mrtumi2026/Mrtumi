'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const MYSQL_HOST = String(process.env.MYSQL_TEST_HOST || '').trim();
const REQUIRED = process.env.MYSQL_TEST_REQUIRED === 'true';
const SKIP_REASON = 'SKIPPED locally: no disposable MySQL/MariaDB service; required in exact database CI.';
if (REQUIRED && !MYSQL_HOST) throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
process.env.NODE_ENV='test'; process.env.LOG_SILENT='true';
if(MYSQL_HOST){process.env.DB_CLIENT='mysql';process.env.DB_HOST=MYSQL_HOST;process.env.DB_PORT=String(process.env.MYSQL_TEST_PORT||3306);process.env.DB_NAME=process.env.MYSQL_TEST_DB||'mrtumi_test';process.env.DB_USER=process.env.MYSQL_TEST_USER||'mrtumi_test';process.env.DB_PASSWORD=process.env.MYSQL_TEST_PASSWORD||'mrtumi_test_pw';}
const {getPool,createQueryClient,closePool,withTransaction}=require('../src/db/mysqlPool');
const {migrateUp,migrateDown}=require('../src/db/migrator');
const repo=require('../src/repositories/resellerPortalRepository');
describe('Reseller portal canonical MySQL/MariaDB integration',()=>{
 let pool,client;
 before(async()=>{if(!MYSQL_HOST)return;pool=getPool();client=createQueryClient(pool);await migrateDown(pool,{steps:11});await migrateUp(pool);});
 after(async()=>{if(MYSQL_HOST)await closePool();});
 test('authentication, audited profile rollback, tenant-owned orders/details, and integer-paisa transactions',{skip:!MYSQL_HOST?SKIP_REASON:false},async()=>{
   const suffix=String(Date.now()).slice(-8),hash=await bcrypt.hash('ResellerIntegrationPassword!2026',10);
   const a=await client.execute('INSERT INTO resellers(name,shop_name,phone,email,password_hash,verified,status) VALUES(?,?,?,?,?,1,1)',[`Reseller A ${suffix}`,'Shop A',`013${suffix}112`,`ra-${suffix}@example.invalid`,hash]);
   const b=await client.execute('INSERT INTO resellers(name,shop_name,phone,email,password_hash,verified,status) VALUES(?,?,?,?,?,1,1)',[`Reseller B ${suffix}`,'Shop B',`014${suffix}112`,`rb-${suffix}@example.invalid`,hash]);
   let orderA,orderB,registered;
   try{
    assert.equal((await repo.authenticate(`ra-${suffix}@example.invalid`,'ResellerIntegrationPassword!2026')).id,a.insertId);
    assert.equal(await repo.authenticate(`ra-${suffix}@example.invalid`,'wrong password'),null);
    registered=await repo.register({name:'Registered reseller',shop_name:'Registration shop',phone:`017${suffix.slice(-8)}`,email:`registered-${suffix}@example.invalid`,password:'ResellerIntegrationPassword!2026'});
    const registrationAudit=await client.queryOne("SELECT action FROM audit_logs WHERE actor_type='reseller' AND actor_id=? AND action='reseller.account.registered'",[registered.id]);assert.ok(registrationAudit);
    const profile=await repo.getProfile(a.insertId);assert.equal(Number(profile.id),a.insertId);
    orderA=(await client.execute("INSERT INTO orders(invoice_no,reseller_id,customer_name,customer_phone,shipping_address,total_paisa,reseller_margin_paisa,order_status) VALUES(?,?,?,?,'A address',12345,2345,'pending')",[`RPA-${suffix}`,a.insertId,'A Customer',`015${suffix}112`])).insertId;
    orderB=(await client.execute("INSERT INTO orders(invoice_no,reseller_id,customer_name,customer_phone,shipping_address,total_paisa,reseller_margin_paisa,order_status) VALUES(?,?,?,?,'B address',9876,1234,'delivered')",[`RPB-${suffix}`,b.insertId,'B Customer',`016${suffix}112`])).insertId;
    const product=(await client.execute('INSERT INTO products(sku,slug,name_bn,name_en,status) VALUES(?,?,?, ?,1)',[`RP-${suffix}`,`rp-${suffix}`,'Test product','Test product'])).insertId;
    try{await client.execute("INSERT INTO order_items(order_id,product_id,product_name,unit_price_paisa,qty,line_total_paisa,size_label,color_label) VALUES(?,?,?,12345,1,12345,'Small','Blue')",[orderA,product,'A line']);}catch(e){await client.execute('DELETE FROM products WHERE id=?',[product]);throw e;}
    await client.execute("INSERT INTO reseller_transactions(reseller_id,tx_type,amount_paisa,method,trx_id,status) VALUES(?,'deposit',12345,'test',?,'pending')",[a.insertId,`T-${suffix}`]);
    const orders=await repo.listOrders(a.insertId,{page:1,perPage:10});assert.deepEqual(orders.orders.map(x=>Number(x.id)),[orderA]);assert.equal(orders.total,1);
    await assert.rejects(()=>repo.getOrderDetails(b.insertId,orderA),{code:'NOT_FOUND'});
    const detail=await repo.getOrderDetails(a.insertId,orderA);assert.equal(Number(detail.items[0].line_total_paisa),12345);
    const tx=await repo.listTransactions(a.insertId,'deposit');assert.equal(String(tx.transactions[0].amount_paisa),'12345');
    await assert.rejects(()=>withTransaction(async tx=>{await tx.execute('UPDATE resellers SET name=? WHERE id=?',['Changed A',a.insertId]);throw new Error('intentional transaction rollback');},{pool}));
    const afterRollback=await repo.getProfile(a.insertId);assert.equal(afterRollback.name,profile.name,'MySQL transaction rolls profile update back after a subsequent failure');
    await repo.updateProfile(a.insertId,{name:'Updated A',shop_name:'Updated shop',email:`ra-${suffix}@example.invalid`});
    const profileAudit=await client.queryOne("SELECT before_json,after_json FROM audit_logs WHERE actor_type='reseller' AND actor_id=? AND action='reseller.profile.updated'",[a.insertId]);assert.ok(profileAudit);assert.match(profileAudit.after_json,/Updated A/);
   }finally{
    if(orderA){await client.execute('DELETE FROM order_items WHERE order_id=?',[orderA]);await client.execute('DELETE FROM orders WHERE id=?',[orderA]);}
    if(orderB)await client.execute('DELETE FROM orders WHERE id=?',[orderB]);
    await client.execute("DELETE FROM reseller_transactions WHERE reseller_id IN (?,?) AND trx_id=?",[a.insertId,b.insertId,`T-${suffix}`]);
    await client.execute("DELETE FROM audit_logs WHERE actor_type='reseller' AND actor_id IN (?,?,?)",[a.insertId,b.insertId,registered&&registered.id||0]);
    await client.execute('DELETE FROM resellers WHERE id IN (?,?,?)',[a.insertId,b.insertId,registered&&registered.id||0]);
    await client.execute('DELETE FROM products WHERE sku=?',[`RP-${suffix}`]);
   }
 });
});
