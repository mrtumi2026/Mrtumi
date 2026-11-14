'use strict';

process.env.LOG_SILENT='true';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const repo=require('../src/repositories/adminCatalogRepository');

function poolFixture({failAudit=false,duplicate=false,missingParent=false,hasDependents=false}={}){
  const calls=[];const state={began:false,committed:false,rolledBack:false};
  const connection={
    async beginTransaction(){state.began=true;},async commit(){state.committed=true;},async rollback(){state.rolledBack=true;},release(){},
    async query(sql,params=[]){
      calls.push({sql,params});
      if(sql.includes('INSERT INTO')){
        if(duplicate){const error=new Error('duplicate');error.code='ER_DUP_ENTRY';throw error;}
        if(sql.includes('audit_logs')&&failAudit){const error=new Error('audit fail');error.code='ER_SIGNAL_EXCEPTION';throw error;}
        return [{insertId:42,affectedRows:1},[]];
      }
      if(sql.trimStart().startsWith('UPDATE'))return [{affectedRows:1},[]];
      if(sql.trimStart().startsWith('DELETE'))return [{affectedRows:1},[]];
      if(sql.includes('SELECT COUNT(*) AS total')){
        return [[{total: hasDependents ? 3 : 0}],[]];
      }
      if(sql.includes('SELECT id,status FROM reviews'))return [[{id:7,status:'pending'}],[]];
      if(sql.includes('FROM categories')||sql.includes('FROM subcategories')||sql.includes('FROM products')||sql.includes('FROM childcategories')||sql.includes('FROM brands')||sql.includes('FROM colors')||sql.includes('FROM sizes')){
        if(missingParent)return [[],[]];
        return [[{id:7,category_id:3,subcategory_id:5,status:1,name_bn:'Organic Fruits',name_en:'Organic Fruits',slug:'organic-fruits',icon:'🍎',sort_order:2,is_archived:0,approval_status:'pending',vendor_id:9,vendor_status:1,lifecycle_status:'active'}],[]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool={calls,state,async getConnection(){return connection;},async query(sql,params=[]){calls.push({sql,params});return [[],[]];}};
  return pool;
}

test('admin catalog product listings bind search and mode filters without exposing raw SQL inputs',async()=>{
  const pool=poolFixture();
  await repo.listProducts({mode:'pending',search:'name%_'},{pool});
  const {sql,params}=pool.calls[0];
  assert.match(sql,/approval_status='pending'/);assert.match(sql,/vendor_id IS NOT NULL/);assert.match(sql,/LIKE \?/);
  assert.deepEqual(params,['%name!%!_%','%name!%!_%','%name!%!_%']);
  assert.doesNotMatch(sql,/DELETE\s/i);
});

test('taxonomy list uses a closed table allowlist and parameter-free reads',async()=>{
  const pool=poolFixture();
  await repo.listTaxonomy('subcategories',{pool});
  assert.match(pool.calls[0].sql,/FROM subcategories/);assert.match(pool.calls[0].sql,/JOIN categories/);
  await assert.rejects(repo.listTaxonomy('categories; DROP TABLE users',{pool}),{code:'VALIDATION_ERROR'});
});

test('taxonomy creation validates and transactionally audits parameterized parent-linked records',async()=>{
  const pool=poolFixture();
  const created=await repo.createTaxonomy('subcategories',{category_id:'3',name:' Fresh Produce ',slug:'fresh-produce'},{id:5},{pool});
  assert.equal(created.id,42);assert.equal(pool.state.committed,true);assert.equal(pool.state.rolledBack,false);
  const insert=pool.calls.find(({sql})=>sql.includes('INSERT INTO subcategories'));
  assert.deepEqual(insert.params,[3,'Fresh Produce','','fresh-produce']);
  assert.ok(pool.calls.some(({sql})=>sql.includes('INSERT INTO')&&sql.includes('audit_logs')));
  const badParent=poolFixture({missingParent:true});
  await assert.rejects(repo.createTaxonomy('subcategories',{category_id:'999',name:'Bad parent'},{},{pool:badParent}),{code:'VALIDATION_ERROR'});
  assert.equal(badParent.state.rolledBack,true);
});

test('taxonomy create maps duplicate slug conflicts and rolls back when audit writing fails',async()=>{
  const duplicate=poolFixture({duplicate:true});
  await assert.rejects(repo.createTaxonomy('categories',{name:'Duplicate'},{},{pool:duplicate}),{code:'CONFLICT'});
  assert.equal(duplicate.state.rolledBack,true);
  const fail=poolFixture({failAudit:true});
  await assert.rejects(repo.createTaxonomy('brands',{name:'Brand'},{},{pool:fail}),{code:'DB_QUERY_FAILED'});
  assert.equal(fail.state.rolledBack,true);assert.equal(fail.state.committed,false);
});

test('product review creation/moderation is validated, transactional, audited and has no destructive API',async()=>{
  const pool=poolFixture();
  const created=await repo.createReview({product_id:'7',customer_name:'Test Customer',rating:'4',comment:'Good quality.'},{id:5},{pool});
  assert.deepEqual(created,{id:42,product_id:7,customer_name:'Test Customer',rating:4,status:'approved'});
  assert.ok(pool.calls.some(({sql})=>sql.includes('INSERT INTO reviews')));
  const approved=await repo.approveReview('7',{id:5},{pool:poolFixture()});
  assert.deepEqual(approved,{id:7,status:'approved',replayed:false});
  const invalid=poolFixture();
  await assert.rejects(repo.createReview({product_id:'7',customer_name:'Test',rating:'8',comment:'Bad rating'},{},{pool:invalid}),{code:'VALIDATION_ERROR'});
  assert.equal(invalid.state.began,false);
  assert.equal(repo.deleteReview,undefined);
});

test('product status and vendor approval are audited in transactions and reject invalid states',async()=>{
  const pool=poolFixture();
  const changed=await repo.toggleProductStatus(12,{id:5},{pool});
  assert.deepEqual(changed,{id:12,status:0});assert.equal(pool.state.committed,true);
  const approvalPool=poolFixture();
  assert.deepEqual(await repo.approvePendingVendorProduct(12,{id:5},{pool:approvalPool}),{id:12,status:1,approval_status:'approved'});
  const rejectionPool=poolFixture();
  assert.deepEqual(await repo.rejectPendingVendorProduct(12,'Missing required safety details',{id:5},{pool:rejectionPool}),{id:12,status:0,approval_status:'rejected',reason:'Missing required safety details'});
  assert.equal(rejectionPool.state.committed,true);
  await assert.rejects(repo.rejectPendingVendorProduct(12,'no',{id:5},{pool:poolFixture()}),{code:'VALIDATION_ERROR'});
  const missing=poolFixture({missingParent:true});
  await assert.rejects(repo.toggleProductStatus(999,{id:5},{pool:missing}),{code:'NOT_FOUND'});
  assert.equal(repo.deleteProduct,undefined,'catalog repository deliberately exposes no destructive delete API');
});

test('taxonomy update validates, preserves references, and writes transactional audit',async()=>{
  const pool=poolFixture();
  const updated=await repo.updateTaxonomy('categories',7,{name:'Updated Fruits',name_en:'Updated Fruits En',slug:'updated-fruits',icon:'🍊',sort_order:'3'},{id:5},{pool});
  assert.equal(updated.id,7);
  assert.equal(updated.name_bn,'Updated Fruits');
  assert.equal(updated.slug,'updated-fruits');
  assert.equal(pool.state.committed,true);
  const updateCall=pool.calls.find(({sql})=>sql.includes('UPDATE categories'));
  assert.deepEqual(updateCall.params,['Updated Fruits','Updated Fruits En','updated-fruits','🍊',3,7]);
  assert.ok(pool.calls.some(({sql,params})=>sql.includes('audit_logs')&&params.includes('catalog.categories.update')));

  const duplicate=poolFixture({duplicate:true});
  await assert.rejects(repo.updateTaxonomy('categories',7,{name:'Duplicate'},{},{pool:duplicate}),{code:'CONFLICT'});
});

test('taxonomy toggle status updates status atomically and writes audit log',async()=>{
  const pool=poolFixture();
  const result=await repo.toggleTaxonomyStatus('categories',7,{id:5},{pool});
  assert.deepEqual(result,{id:7,status:0});
  assert.equal(pool.state.committed,true);
  const updateCall=pool.calls.find(({sql})=>sql.includes('UPDATE categories SET status=?'));
  assert.deepEqual(updateCall.params,[0,7]);
  assert.ok(pool.calls.some(({sql,params})=>sql.includes('audit_logs')&&params.includes('catalog.categories.toggleStatus')));
});

test('taxonomy delete safely blocks deletion when dependents exist and deletes when clean',async()=>{
  const blockedPool=poolFixture({hasDependents:true});
  await assert.rejects(
    repo.deleteTaxonomy('categories',7,{id:5},{pool:blockedPool}),
    (err)=>{
      assert.equal(err.code,'CONFLICT');
      assert.match(err.message,/Cannot delete category.*product.*subcategory/);
      return true;
    }
  );
  assert.equal(blockedPool.state.rolledBack,true);

  const cleanPool=poolFixture({hasDependents:false});
  const result=await repo.deleteTaxonomy('categories',7,{id:5},{pool:cleanPool});
  assert.deepEqual(result,{id:7,deleted:true});
  assert.equal(cleanPool.state.committed,true);
  assert.ok(cleanPool.calls.some(({sql})=>sql.includes('DELETE FROM categories WHERE id=?')));
  assert.ok(cleanPool.calls.some(({sql,params})=>sql.includes('audit_logs')&&params.includes('catalog.categories.delete')));
});
