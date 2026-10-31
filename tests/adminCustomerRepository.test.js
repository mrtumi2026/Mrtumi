'use strict';

process.env.LOG_SILENT='true';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const repo=require('../src/repositories/adminCustomerRepository');

function transactionalPool({failAudit=false,duplicate=false}={}) {
  const calls=[];const state={began:false,committed:false,rolledBack:false};
  const connection={
    async beginTransaction(){state.began=true;},async commit(){state.committed=true;},async rollback(){state.rolledBack=true;},release(){},
    async query(sql,params=[]){
      calls.push({sql,params});
      if(sql.includes('INSERT INTO customers')||sql.includes('INSERT INTO ip_blocks')){
        if(duplicate){const error=new Error('duplicate target');error.code='ER_DUP_ENTRY';throw error;}
        return [{insertId:42,affectedRows:1},[]];
      }
      if(sql.includes('INSERT INTO audit_logs')){
        if(failAudit){const error=new Error('audit trigger failed');error.code='ER_SIGNAL_EXCEPTION';throw error;}
        return [{insertId:99,affectedRows:1},[]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return {calls,state,async getConnection(){return connection;},async query(sql,params=[]){calls.push({sql,params});return [[{id:7,name:'Customer',phone:'01712345678',address:'Dhaka',total_orders:3,status:1}],[]];}};
}

test('admin customer list selects minimized customer profile fields and binds search filters',async()=>{
  const pool=transactionalPool();
  const rows=await repo.listCustomers({search:'0171234'},{pool});
  assert.equal(rows.length,1);assert.equal(rows[0].total_orders,3);
  assert.match(pool.calls[0].sql,/FROM customers/);assert.match(pool.calls[0].sql,/name LIKE \?/);
  assert.deepEqual(pool.calls[0].params,Array(2).fill('%0171234%'));
  assert.doesNotMatch(pool.calls[0].sql,/password_hash|DELETE\s/i);
});

test('admin customer creation validates/normalizes before one transaction and writes minimized audit evidence',async()=>{
  const pool=transactionalPool();
  const created=await repo.createCustomer({name:'  New Customer  ',phone:'+8801712345678',address:' Dhaka '},{id:5,ip:'127.0.0.1',userAgent:'test'},{pool});
  assert.deepEqual(created,{id:42,name:'New Customer',phone:'01712345678'});
  assert.equal(pool.state.began,true);assert.equal(pool.state.committed,true);assert.equal(pool.state.rolledBack,false);
  const insert=pool.calls.find(({sql})=>sql.includes('INSERT INTO customers'));
  assert.deepEqual(insert.params,['New Customer','01712345678','Dhaka']);
  const audit=pool.calls.find(({sql})=>sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);assert.match(audit.sql,/customer\.admin\.created/);assert.match(audit.sql,/entity_type/);
  assert.match(audit.params[2],/"phone"/);
});

test('admin customer creation rolls back customer row when audit writing fails',async()=>{
  const pool=transactionalPool({failAudit:true});
  await assert.rejects(repo.createCustomer({name:'New Customer',phone:'01712345678'},{id:5},{pool}),{code:'DB_QUERY_FAILED'});
  assert.equal(pool.state.began,true);assert.equal(pool.state.committed,false);assert.equal(pool.state.rolledBack,true);
});

test('admin customer creation maps duplicate phones to conflict and rejects invalid input before opening a transaction',async()=>{
  const duplicatePool=transactionalPool({duplicate:true});
  await assert.rejects(repo.createCustomer({name:'New Customer',phone:'01712345678'},{id:5},{pool:duplicatePool}),{code:'CONFLICT'});
  assert.equal(duplicatePool.state.rolledBack,true);
  const invalidPool=transactionalPool();
  await assert.rejects(repo.createCustomer({name:'A',phone:'bad'},{id:5},{pool:invalidPool}),{code:'VALIDATION_ERROR'});
  assert.equal(invalidPool.state.began,false);
});

test('admin IP/phone block list uses MySQL reads and validates both supported target types',async()=>{
  const pool=transactionalPool();
  await repo.listIpBlocks({pool});
  assert.match(pool.calls[0].sql,/FROM ip_blocks/);assert.doesNotMatch(pool.calls[0].sql,/DELETE\s/i);
  const phone=await repo.createIpBlock({ip_or_phone:'+8801712345678',reason:'Repeated fake orders'},{id:5},{pool});
  assert.deepEqual(phone,{id:42,target_type:'phone',ip_or_phone:'01712345678'});
  const ip=await repo.createIpBlock({ip_or_phone:'192.0.2.12',reason:'Repeated fake orders'},{id:5},{pool});
  assert.deepEqual(pool.calls.find(({sql})=>sql.includes('INSERT INTO ip_blocks')).params,['phone','01712345678','Repeated fake orders',5]);
  assert.deepEqual(pool.calls.filter(({sql})=>sql.includes('INSERT INTO ip_blocks'))[1].params,['ip','192.0.2.12','Repeated fake orders',5]);
  await assert.rejects(repo.createIpBlock({ip_or_phone:'not-an-ip-or-phone'},{id:5},{pool}),{code:'VALIDATION_ERROR'});
});

test('admin IP/phone block creation is audited transactionally and preserves block evidence on audit failure',async()=>{
  const pool=transactionalPool({failAudit:true});
  await assert.rejects(repo.createIpBlock({ip_or_phone:'192.0.2.20',reason:'Automated abuse'},{id:5},{pool}),{code:'DB_QUERY_FAILED'});
  assert.equal(pool.state.rolledBack,true);assert.equal(pool.state.committed,false);
  const duplicatePool=transactionalPool({duplicate:true});
  await assert.rejects(repo.createIpBlock({ip_or_phone:'192.0.2.20',reason:'Automated abuse'},{id:5},{pool:duplicatePool}),{code:'CONFLICT'});
});

test('admin customer deletion is explicitly policy-blocked; no hard-delete repository method exists',async()=>{
  assert.equal(repo.deleteCustomer,undefined);
});
