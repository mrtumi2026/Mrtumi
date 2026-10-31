'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
const { normalizeBdPhone, requireString } = require('../utils/validator');
const { ConflictError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');
const net = require('node:net');

function customerClient(pool=null) {
  if(env.db.client!=='mysql'&&!pool)throw new Error('Admin customer repository requires MySQL.');
  return createQueryClient(pool||getPool());
}
function optionalAddress(value) {
  if(value!==undefined&&value!==null&&typeof value!=='string')throw new ValidationError('Customer address must be text.');
  const address=String(value||'').trim();
  if(address.length>2000)throw new ValidationError('Customer address must not exceed 2000 characters.');
  return address;
}
async function listCustomers({search=''}={}, {pool=null}={}) {
  const term=String(search||'').trim().slice(0,120);
  const where=term?'WHERE (name LIKE ? OR phone LIKE ?)':'';
  const params=term?[`%${term}%`,`%${term}%`]:[];
  return customerClient(pool).queryAll(`SELECT id,name,phone,address,total_orders,status
    FROM customers ${where} ORDER BY id DESC`,params);
}
async function insertAudit(tx,actor,id,after) {
  const safeAfter=JSON.stringify(logger.redactValue(after));
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,'customer.admin.created','customer',?,NULL,?,?,?)`,[
    actor.id||null,String(id),safeAfter,String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255),
  ]);
}
async function createCustomer(input={},actor={}, {pool=null}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('Enter valid customer details.');
  const name=requireString(input.name,'customer name',{min:2,max:191});
  const phone=normalizeBdPhone(input.phone,'customer phone');
  const address=optionalAddress(input.address);
  try {
    return await withTransaction(async(tx)=>{
      const result=await tx.execute('INSERT INTO customers(name,phone,address,total_orders) VALUES(?,?,?,0)',[name,phone,address]);
      await insertAudit(tx,actor,result.insertId,{name,phone,addressProvided:Boolean(address)});
      return {id:Number(result.insertId),name,phone};
    },{pool:pool||getPool()});
  } catch(error) {
    if(error.code==='DB_DUPLICATE_ENTRY')throw new ConflictError('A customer with this phone number already exists.');
    throw error;
  }
}
async function listIpBlocks({pool=null}={}) {
  return customerClient(pool).queryAll(`SELECT id,target_type,ip_or_phone,reason,is_permanent,expires_at,status,created_at
    FROM ip_blocks ORDER BY id DESC`);
}
function normalizeBlockTarget(raw) {
  const target=String(raw||'').trim();
  if(net.isIP(target))return {type:'ip',value:target};
  try{return {type:'phone',value:normalizeBdPhone(target,'blocked phone')};}
  catch(_error){throw new ValidationError('Enter a valid IPv4/IPv6 address or Bangladesh mobile number.');}
}
async function createIpBlock(input={},actor={}, {pool=null}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('Enter a valid block-list target.');
  const target=normalizeBlockTarget(input.ip_or_phone);
  const reason=requireString(input.reason||'Fake order prevention','block reason',{min:3,max:255});
  try {
    return await withTransaction(async(tx)=>{
      const result=await tx.execute('INSERT INTO ip_blocks(target_type,ip_or_phone,reason,created_by_user_id) VALUES(?,?,?,?)',[
        target.type,target.value,reason,actor.id||null,
      ]);
      await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
        VALUES('admin',?,'customer.ip_block.created','ip_block',?,NULL,?,?,?)`,[
        actor.id||null,String(result.insertId),JSON.stringify(logger.redactValue({target_type:target.type,ip_or_phone:target.value,reasonProvided:true})),
        String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255),
      ]);
      return {id:Number(result.insertId),target_type:target.type,ip_or_phone:target.value};
    },{pool:pool||getPool()});
  } catch(error) {
    if(error.code==='DB_DUPLICATE_ENTRY')throw new ConflictError('This IP address or phone number is already on the block list.');
    throw error;
  }
}
module.exports={listCustomers,createCustomer,listIpBlocks,createIpBlock};
