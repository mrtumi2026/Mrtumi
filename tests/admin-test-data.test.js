'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {policyForAdminRoute}=require('../src/middleware/legacyAdminRbac');
const {requirePermission}=require('../src/middleware/rbac');
const repo=require('../src/repositories/adminTestDataRepository');
const root=path.join(__dirname,'..');
const up=fs.readFileSync(path.join(root,'src/db/migrations/0028_admin_test_data_management.up.sql'),'utf8');
const down=fs.readFileSync(path.join(root,'src/db/migrations/0028_admin_test_data_management.down.sql'),'utf8');

test('test-data marker migration is additive, nullable, indexed, permissioned, and never backfills existing business rows',()=>{
  for(const table of ['categories','customers','vendors','products','orders'])assert.ok(up.includes(`ALTER TABLE \`${table}\``)&&up.includes('ADD COLUMN `test_data_group_id` BIGINT UNSIGNED DEFAULT NULL'),`missing additive marker on ${table}`);
  assert.match(up,/CREATE TABLE IF NOT EXISTS `test_data_groups`/);assert.match(up,/CREATE TABLE IF NOT EXISTS `test_data_cleanup_runs`/);assert.match(up,/test_data\.manage/);
  assert.doesNotMatch(up,/UPDATE `?(customers|vendors|products|orders|categories)`?\s+SET\s+`?test_data_group_id/i);
  assert.match(down,/DROP COLUMN `test_data_group_id`/);
});

test('only supported entities can be explicitly marked; no heuristic name/email classification exists',()=>{
  assert.deepEqual(Object.keys(repo.ENTITY_TABLE).sort(),['categories','customers','orders','products','vendors']);
  const searchSource=fs.readFileSync(path.join(root,'src/repositories/adminTestDataRepository.js'),'utf8');
  assert.match(searchSource,/WHERE test_data_group_id IS NULL/);assert.doesNotMatch(searchSource,/@example|DEMO-|test@|LIKE.*demo/i);
});

test('Admin test-data HTTP paths require dedicated permission and writes are CSRF guarded',()=>{
  assert.equal(policyForAdminRoute('GET','/admin/test-data').key,'test_data.manage');
  assert.equal(policyForAdminRoute('POST','/admin/test-data/groups/1/cleanup').key,'test_data.manage');
  const route=fs.readFileSync(path.join(root,'src/routes/adminTestData.js'),'utf8');
  assert.match(route,/requireAdmin/);assert.match(route,/requirePermission\('test_data\.manage'\)/);assert.match(route,/requireCsrf/);assert.match(route,/CLEAN \$\{group\.group_key\}/);
  assert.match(fs.readFileSync(path.join(root,'views/admin/test-data.ejs'),'utf8'),/Test Data Management/);
  const detail=fs.readFileSync(path.join(root,'views/admin/test-data-group.ejs'),'utf8');
  for(const text of ['টেস্ট ডেটা গ্রুপ পরিদর্শন','চিহ্নিত মূল রেকর্ড','পরিষ্কারের প্রিভিউ','পরিষ্কারের অডিট ইতিহাস','Cleanup preview','Cleanup audit history'])assert.ok(detail.includes(text),`missing bilingual UI text ${text}`);
  assert.match(detail,/name="_csrf"/);assert.match(detail,/cleanup-confirm/);assert.match(detail,/Marked root records/);
});


test('non-owner staff without test_data.manage receives a server-side forbidden result',()=>{
  const middleware=requirePermission('test_data.manage');let nextError=null;
  middleware({adminUser:{id:91,role_slug:'operator',permissions:['orders.manage']}},null,error=>{nextError=error;});
  assert.equal(nextError?.code,'FORBIDDEN');
});

test('cleanup repository performs a transaction, rechecks scope, uses fixed table allowlists and retains audit history',()=>{
  const source=fs.readFileSync(path.join(root,'src/repositories/adminTestDataRepository.js'),'utf8');
  assert.match(source,/mysql\.withTransaction\(async tx=>\{\s*const group=await tx\.queryOne\('SELECT \* FROM test_data_groups WHERE id=\? FOR UPDATE'/);
  assert.match(source,/blockersFor\(tx,id,counts\)/);assert.match(source,/INSERT INTO test_data_cleanup_runs/);assert.match(source,/test_data\.cleanup\.completed/);
  assert.doesNotMatch(source,/DELETE FROM audit_logs|DELETE FROM .*financial_ledger|DELETE FROM (order_payments|refunds|vendor_transactions|vendor_settlement)/);
  assert.match(fs.readFileSync(path.join(root,'src/routes/adminTestData.js'),'utf8'),/Type the exact cleanup confirmation/);
  assert.match(source,/const ENTITY_TABLE = Object\.freeze/);
});

const MYSQL_HOST=String(process.env.MYSQL_TEST_HOST||'').trim();const REQUIRED=process.env.MYSQL_TEST_REQUIRED==='true';const SKIP='SKIPPED locally: no disposable MySQL/MariaDB service; required in exact database CI.';
if(REQUIRED&&!MYSQL_HOST)throw new Error('MYSQL_TEST_REQUIRED=true but MYSQL_TEST_HOST was not provided.');
if(MYSQL_HOST){process.env.NODE_ENV='test';process.env.DB_CLIENT='mysql';process.env.DB_HOST=MYSQL_HOST;process.env.DB_PORT=String(process.env.MYSQL_TEST_PORT||3306);process.env.DB_NAME=process.env.MYSQL_TEST_DB||'mrtumi_test';process.env.DB_USER=process.env.MYSQL_TEST_USER||'mrtumi_test';process.env.DB_PASSWORD=process.env.MYSQL_TEST_PASSWORD||'mrtumi_test_pw';}
const mysql=require('../src/db/mysqlPool');const {resetDisposableMysqlDatabase}=require('../scripts/qa/mysql-test-database');
test('live disposable MySQL/MariaDB test-data marking, blocker preview, rollback, and idempotent cleanup', {skip:!MYSQL_HOST?SKIP:false},async t=>{
  const pool=mysql.getPool(),db=mysql.createQueryClient(pool);t.after(()=>mysql.closePool());await resetDisposableMysqlDatabase(pool);
  const role=await db.execute("INSERT INTO roles(name,slug,status) VALUES('Test Data CI Admin','admin',1)");
  const admin=await db.execute("INSERT INTO users(role_id,name,email,password_hash,role_label,status) VALUES(?,'QA admin',?,'hash','Admin',1)",[role.insertId,`qa-${Date.now()}@example.invalid`]);
  const groupId=await repo.createGroup({label:'Explicit marked QA group',description:'Deterministic repository integration.'},{id:null},{pool});
  const categoryId=(await db.execute('INSERT INTO categories(name_bn,name_en,slug,status,test_data_group_id) VALUES(?,?,?,1,?)',['টেস্ট ক্যাটাগরি','QA Category',`qa-${Date.now()}`,groupId])).insertId;
  const customer=(await db.execute("INSERT INTO customers(name,phone,email,password_hash,test_data_group_id) VALUES('QA marked customer',?,?, '',?)",[`017${String(Date.now()).slice(-8)}`,`marked-${Date.now()}@example.invalid`,groupId])).insertId;
  const customer2=(await db.execute("INSERT INTO customers(name,phone,email,password_hash) VALUES('QA genuine-like unmarked',?,?, '')",[`018${String(Date.now()).slice(-8)}`,`real-looking-${Date.now()}@example.invalid`])).insertId;
  const vendor=(await db.execute("INSERT INTO vendors(shop_name,owner_name,phone,password_hash,test_data_group_id) VALUES('QA marked vendor','QA owner',?,'',?)",[`016${String(Date.now()).slice(-8)}`,groupId])).insertId;
  const product=(await db.execute("INSERT INTO products(sku,slug,name_bn,name_en,category_id,vendor_id,test_data_group_id,regular_price_paisa,sale_price_paisa) VALUES(?,?,?,?,?,?,?,100,100)",[ `qa-${Date.now()}`,`qa-product-${Date.now()}`,'টেস্ট পণ্য','QA Product',categoryId,vendor,groupId])).insertId;
  await db.execute("INSERT INTO customer_addresses(customer_id,label,recipient_name,recipient_phone,street_address) VALUES(?,'QA','QA',?,'Disposable fixture')",[customer,`017${String(Date.now()).slice(-8)}`]);
  await db.execute('INSERT INTO product_variants(product_id,variant_sku) VALUES(?,?)',[product,`QA-V-${Date.now()}`]);
  await assert.rejects(()=>repo.markEntity(groupId,'customers',customer,{id:Number(admin.insertId)},{pool}),{code:'CONFLICT'});
  const counts=(await repo.groupDetail(groupId,{pool})).counts;assert.equal(counts.customers,1);assert.equal(counts.vendors,1);assert.equal(counts.products,1);assert.equal(counts.categories,1);assert.equal(counts.addresses,1);assert.equal(counts.variants,1);
  const candidates=await repo.searchUnmarked('customers','QA genuine-like unmarked',{pool});assert.ok(candidates.some(x=>Number(x.id)===Number(customer2)),'unmarked row remains discoverable and is not inferred to be test data');
  const detail=await repo.groupDetail(groupId,{pool});assert.equal(detail.blockers.length,0);assert.equal(detail.canClean,true);
  const trigger=`fail_testdata_delete_${Date.now()}`;await db.execute(`CREATE TRIGGER ${trigger} BEFORE DELETE ON products FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional rollback test'`);
  try{await assert.rejects(()=>repo.cleanupGroup(groupId,{id:null},{pool}));}finally{await db.execute(`DROP TRIGGER IF EXISTS ${trigger}`);}
  assert.ok(await db.queryOne('SELECT id FROM products WHERE id=?',[product]));assert.equal((await db.queryOne('SELECT status FROM test_data_groups WHERE id=?',[groupId])).status,'active');assert.equal((await db.queryOne('SELECT result FROM test_data_cleanup_runs WHERE group_id=? ORDER BY id DESC LIMIT 1',[groupId])).result,'failed','rolled-back failure is recorded only after the cleanup transaction fails');assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM audit_logs WHERE action=\'test_data.cleanup.failed\' AND entity_id=?',[String(groupId)])).n),1,'failed cleanup audit is retained');
  const result=await repo.cleanupGroup(groupId,{id:Number(admin.insertId)},{pool});assert.equal(result.status,'completed');assert.equal(result.deleted.products,1);assert.equal(result.deleted.customers,1);assert.equal(result.deleted.vendors,1);assert.equal(result.deleted.categories,1);
  assert.ok(await db.queryOne('SELECT id FROM customers WHERE id=?',[customer2]),'unmarked record is unchanged');
  assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM test_data_cleanup_runs WHERE group_id=? AND result=\'completed\'',[groupId])).n),1);
  await assert.rejects(()=>repo.cleanupGroup(groupId,{id:Number(admin.insertId)},{pool}),{code:'CONFLICT'});
  const empty=await repo.createGroup({label:'Empty QA group'},{id:Number(admin.insertId)},{pool});assert.equal((await repo.cleanupGroup(empty,{id:Number(admin.insertId)},{pool})).status,'empty');
  // Financial and order history are never removed, even when a group marker is present.
  const protectedGroup=await repo.createGroup({label:'Protected order QA'},{id:Number(admin.insertId)},{pool});
  const protectedCustomer=(await db.execute("INSERT INTO customers(name,phone,password_hash,test_data_group_id) VALUES('Protected QA customer',?,'',?)",[`015${String(Date.now()).slice(-8)}`,protectedGroup])).insertId;
  const protectedOrder=(await db.execute("INSERT INTO orders(invoice_no,customer_id,customer_name,customer_phone,shipping_address,total_paisa,test_data_group_id) VALUES(?,?,'Protected QA','01500000000','QA address',100,?)",[`TDM-${Date.now()}`,protectedCustomer,protectedGroup])).insertId;
  await db.execute('INSERT INTO order_status_history(order_id,to_status) VALUES(?,?)',[protectedOrder,'pending']);const blocked=await repo.groupDetail(protectedGroup,{pool});assert.ok(blocked.blockers.some(b=>b.entity==='orders'));assert.equal((await repo.cleanupGroup(protectedGroup,{id:Number(admin.insertId)},{pool})).status,'blocked');assert.ok(await db.queryOne('SELECT id FROM orders WHERE id=?',[protectedOrder]));
  await mysql.closePool();
});
