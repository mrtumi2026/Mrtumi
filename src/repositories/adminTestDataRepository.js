'use strict';

const mysql = require('../db/mysqlPool');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { env } = require('../config/env');

const ENTITY_TABLE = Object.freeze({ customers: 'customers', vendors: 'vendors', products: 'products', categories: 'categories', orders: 'orders' });
const ENTITY_LABELS = Object.freeze({ customers: 'Customer', vendors: 'Vendor', products: 'Product', categories: 'Category', orders: 'Order' });
const ENTITY_SEARCH = Object.freeze({
  customers: "SELECT id,CONCAT(name,' · ',phone) AS label FROM customers WHERE test_data_group_id IS NULL AND (?='' OR name LIKE ? OR phone LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT 50",
  vendors: "SELECT id,CONCAT(shop_name,' · ',phone) AS label FROM vendors WHERE test_data_group_id IS NULL AND (?='' OR shop_name LIKE ? OR owner_name LIKE ? OR phone LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT 50",
  products: "SELECT id,CONCAT(name_en,' / ',name_bn,' · ',sku) AS label FROM products WHERE test_data_group_id IS NULL AND (?='' OR name_en LIKE ? OR name_bn LIKE ? OR sku LIKE ?) ORDER BY id DESC LIMIT 50",
  categories: "SELECT id,CONCAT(name_en,' / ',name_bn,' · ',slug) AS label FROM categories WHERE test_data_group_id IS NULL AND (?='' OR name_en LIKE ? OR name_bn LIKE ? OR slug LIKE ?) ORDER BY id DESC LIMIT 50",
  orders: "SELECT id,CONCAT(invoice_no,' · ',customer_name,' · ',customer_phone) AS label FROM orders WHERE test_data_group_id IS NULL AND (?='' OR invoice_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?) ORDER BY id DESC LIMIT 50",
});
function assertMysql() { if (env.db.client !== 'mysql') throw new Error('Admin test-data management requires MySQL.'); }
function positiveId(raw, name='id') { const n=Number(raw); if(!Number.isSafeInteger(n)||n<1) throw new ValidationError(`${name} is invalid.`); return n; }
function labelText(raw,name,max,min=1){const s=String(raw??'').trim();if(s.length<min||s.length>max)throw new ValidationError(`${name} must be ${min}-${max} characters.`);return s;}
function client(pool=null){assertMysql();return mysql.createQueryClient(pool||mysql.getPool());}
async function groupCounts(db, groupId) {
  const out={};
  for(const [type,table] of Object.entries(ENTITY_TABLE)) {
    const row=await db.queryOne(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE test_data_group_id=?`,[groupId]);out[type]=Number(row?.n||0);
  }
  const productIds=`SELECT id FROM products WHERE test_data_group_id=?`;
  const orderIds=`SELECT id FROM orders WHERE test_data_group_id=?`;
  const subIds=`SELECT id FROM vendor_sub_orders WHERE order_id IN (${orderIds})`;
  const shipmentIds=`SELECT id FROM fulfillment_shipments WHERE vendor_sub_order_id IN (${subIds})`;
  out.variants=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM product_variants WHERE product_id IN (${productIds})`,[groupId])).n||0);
  out.customer_cart_items=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM customer_cart_items WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?) OR product_id IN (${productIds})`,[groupId,groupId])).n||0);
  out.addresses=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.customer_orders=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.customer_verification_records=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM order_otps WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.customer_consent_records=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM customer_consent_events WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.customer_privacy_requests=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM customer_privacy_requests WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.order_items=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM order_items WHERE order_id IN (${orderIds})`,[groupId])).n||0);
  out.product_order_items=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM order_items WHERE product_id IN (${productIds})`,[groupId])).n||0);
  out.vendor_suborders_by_vendor=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM vendor_sub_orders WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.vendor_suborders=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM vendor_sub_orders WHERE order_id IN (${orderIds})`,[groupId])).n||0);
  out.shipments=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM fulfillment_shipments WHERE vendor_sub_order_id IN (${subIds})`,[groupId])).n||0)+Number((await db.queryOne(`SELECT COUNT(*) AS n FROM courier_shipments WHERE order_id IN (${orderIds})`,[groupId])).n||0);
  out.stock_movements=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM stock_ledger WHERE product_id IN (${productIds})`,[groupId])).n||0);
  out.payments=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM order_payments WHERE order_id IN (${orderIds})`,[groupId])).n||0);
  out.refunds=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM refunds WHERE order_id IN (${orderIds})`,[groupId])).n||0);
  out.cod=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM courier_cod_collections WHERE shipment_id IN (${shipmentIds})`,[groupId])).n||0);
  out.return_requests=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM customer_return_requests WHERE order_id IN (${orderIds}) OR customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)`,[groupId,groupId])).n||0);
  out.vendor_settlements=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM vendor_settlement_batches WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.vendor_ledger_entries=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM vendor_transactions WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)`,[groupId])).n||0);
  out.purchase_items=Number((await db.queryOne(`SELECT COUNT(*) AS n FROM purchase_items WHERE product_id IN (${productIds})`,[groupId])).n||0);
  return out;
}
async function blockersFor(db,groupId,counts) {
  const blockers=[];
  if(counts.orders) blockers.push({entity:'orders',count:counts.orders,message:'Orders and lifecycle/financial history are retained; this cleanup tool will not delete order records.'});
  for(const [table,label] of [
    ['vendor_product_history','vendor product audit history'],['purchase_items','purchase item history'],['stock_ledger','stock movements'],['reseller_product_eligibility','reseller product configuration'],['reviews','product review history'],['campaigns','campaign product references'],
  ]) {
    const row=await db.queryOne(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE product_id IN (SELECT id FROM products WHERE test_data_group_id=?)`,[groupId]);
    if(Number(row?.n||0)) blockers.push({entity:table,count:Number(row.n),message:`${label} is retained; affected products are protected.`});
  }
  for(const [sql,params,label] of [
    ['SELECT COUNT(*) AS n FROM vendor_sub_orders WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor suborders and accounting links are retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_settlement_batches WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor settlement records are retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_applications WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor applications are retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_status_history WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor lifecycle history is retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_phone_otps WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor verification history is retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_payout_accounts WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor payout records are retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_wallets WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor wallet records are retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_transactions WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor financial ledger records are retained.'],
    ['SELECT COUNT(*) AS n FROM order_price_snapshots WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor order price snapshots are retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_financial_adjustments WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor financial adjustments are retained.'],
    ['SELECT COUNT(*) AS n FROM vendor_withdrawals WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?)',[groupId],'Vendor withdrawal records are retained.'],
    ['SELECT COUNT(*) AS n FROM products WHERE vendor_id IN (SELECT id FROM vendors WHERE test_data_group_id=?) AND (test_data_group_id IS NULL OR test_data_group_id<>?)',[groupId,groupId],'Vendors still own products outside this group.'],
    ['SELECT COUNT(*) AS n FROM customer_cart_items WHERE product_id IN (SELECT id FROM products WHERE test_data_group_id=?) AND customer_id NOT IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId,groupId],'Products in active carts owned by unmarked customers are protected.'],
    ['SELECT COUNT(*) AS n FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer orders are retained.'],
    ['SELECT COUNT(*) AS n FROM products WHERE category_id IN (SELECT id FROM categories WHERE test_data_group_id=?) AND (test_data_group_id IS NULL OR test_data_group_id<>?)',[groupId,groupId],'Categories referenced by products outside this group are protected.'],
    ['SELECT COUNT(*) AS n FROM order_cancellation_requests WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer cancellation history is retained.'],
    ['SELECT COUNT(*) AS n FROM customer_return_requests WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer return/refund workflow records are retained.'],
    ['SELECT COUNT(*) AS n FROM customer_privacy_requests WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer privacy request history is retained.'],
    ['SELECT COUNT(*) AS n FROM customer_policy_acceptances WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer policy acceptance history is retained.'],
    ['SELECT COUNT(*) AS n FROM customer_consent_events WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer consent history is retained.'],
    ['SELECT COUNT(*) AS n FROM customer_consent_current WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Current customer consent records are retained.'],
    ['SELECT COUNT(*) AS n FROM customer_recovery_tokens WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer account recovery records are protected.'],
    ['SELECT COUNT(*) AS n FROM order_otps WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Order verification records are protected.'],
    ['SELECT COUNT(*) AS n FROM customer_policy_acceptances WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?)',[groupId],'Customer policy acceptance history is retained.'],
    ['SELECT COUNT(*) AS n FROM return_category_policies WHERE category_id IN (SELECT id FROM categories WHERE test_data_group_id=?)',[groupId],'Return category policies are retained.'],
    ['SELECT COUNT(*) AS n FROM subcategories WHERE category_id IN (SELECT id FROM categories WHERE test_data_group_id=?)',[groupId],'Referenced categories are protected.'],
  ]) { const row=await db.queryOne(sql,params);if(Number(row?.n||0))blockers.push({entity:label,count:Number(row.n),message:label}); }
  const prodRefs=await db.queryOne(`SELECT COUNT(*) AS n FROM order_items WHERE product_id IN (SELECT id FROM products WHERE test_data_group_id=?)`,[groupId]);
  if(Number(prodRefs?.n||0)&&!counts.orders)blockers.push({entity:'order_items',count:Number(prodRefs.n),message:'Products referenced by orders outside this marked group cannot be deleted.'});
  return blockers;
}
async function listGroups({q='',status='',pool=null}={}){
  const c=client(pool),query=String(q||'').trim().slice(0,100),stat=String(status||'').trim();
  const rows=await c.queryAll(`SELECT g.id,g.group_key,g.label,g.description,g.source,g.status,g.created_by_user_id,g.created_at,g.cleaned_at,
    (SELECT COUNT(*) FROM customers x WHERE x.test_data_group_id=g.id) AS customers,
    (SELECT COUNT(*) FROM vendors x WHERE x.test_data_group_id=g.id) AS vendors,
    (SELECT COUNT(*) FROM products x WHERE x.test_data_group_id=g.id) AS products,
    (SELECT COUNT(*) FROM categories x WHERE x.test_data_group_id=g.id) AS categories,
    (SELECT COUNT(*) FROM orders x WHERE x.test_data_group_id=g.id) AS orders
    FROM test_data_groups g WHERE (?='' OR g.status=?) AND (?='' OR g.group_key LIKE ? OR g.label LIKE ?) ORDER BY g.id DESC LIMIT 100`,[stat,stat,query,`%${query}%`,`%${query}%`]);return rows;
}
async function createGroup(input,actor,{pool=null}={}){
  assertMysql();const label=labelText(input.label,'Label',191),description=String(input.description||'').trim().slice(0,500);
  const key=`td-${require('node:crypto').randomBytes(16).toString('hex')}`;
  return mysql.withTransaction(async tx=>{const r=await tx.execute("INSERT INTO test_data_groups(group_key,label,description,source,created_by_user_id) VALUES(?,?,?,'admin',?)",[key,label,description,actor?.id||null]);await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('admin',?,'test_data.group.created','test_data_group',?,?,?,?)",[actor?.id||null,String(r.insertId),JSON.stringify({label,description,source:'admin'}),String(actor?.ip||'').slice(0,64),String(actor?.userAgent||'').slice(0,255)]);return Number(r.insertId);},{pool});
}
async function searchUnmarked(type,q,{pool=null}={}){
  assertMysql();if(!ENTITY_SEARCH[type])throw new ValidationError('Entity type is unsupported.');const c=client(pool),term=String(q||'').trim().slice(0,100),like=`%${term}%`;
  const args=type==='vendors'?[term,like,like,like,like]:[term,like,like,like];return c.queryAll(ENTITY_SEARCH[type],args);
}
async function markEntity(groupId,type,entityId,actor,{pool=null}={}){
  assertMysql();const gid=positiveId(groupId,'Group'),id=positiveId(entityId,'Record');const table=ENTITY_TABLE[type];if(!table)throw new ValidationError('Entity type is unsupported.');
  return mysql.withTransaction(async tx=>{const group=await tx.queryOne('SELECT id,status FROM test_data_groups WHERE id=? FOR UPDATE',[gid]);if(!group)throw new NotFoundError('Test-data group not found.');if(group.status!=='active')throw new ConflictError('Only active groups can receive markers.');const row=await tx.queryOne(`SELECT id,test_data_group_id FROM \`${table}\` WHERE id=? FOR UPDATE`,[id]);if(!row)throw new NotFoundError(`${ENTITY_LABELS[type]} not found.`);if(row.test_data_group_id)throw new ConflictError('Record is already explicitly marked in a test-data group.');await tx.execute(`UPDATE \`${table}\` SET test_data_group_id=? WHERE id=? AND test_data_group_id IS NULL`,[gid,id]);await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('admin',?,'test_data.record.marked',?,?,?, ?,?)",[actor?.id||null,type,String(id),JSON.stringify({groupId:gid}),String(actor?.ip||'').slice(0,64),String(actor?.userAgent||'').slice(0,255)]);return {groupId:gid,type,id};},{pool});
}
async function groupDetail(groupId,{pool=null}={}){
  const id=positiveId(groupId,'Group'),c=client(pool),group=await c.queryOne('SELECT * FROM test_data_groups WHERE id=?',[id]);if(!group)throw new NotFoundError('Test-data group not found.');
  const counts=await groupCounts(c,id),blockers=await blockersFor(c,id,counts),cleanupRuns=await c.queryAll('SELECT id,actor_user_id,scope_json,result,detail,created_at FROM test_data_cleanup_runs WHERE group_id=? ORDER BY id DESC LIMIT 25',[id]);
  const markedRecords={
    customers:await c.queryAll("SELECT id,CONCAT(name,' · ',phone) AS label FROM customers WHERE test_data_group_id=? ORDER BY id LIMIT 200",[id]),
    vendors:await c.queryAll("SELECT id,CONCAT(shop_name,' · ',phone) AS label FROM vendors WHERE test_data_group_id=? ORDER BY id LIMIT 200",[id]),
    products:await c.queryAll("SELECT id,CONCAT(name_en,' / ',name_bn,' · ',sku) AS label FROM products WHERE test_data_group_id=? ORDER BY id LIMIT 200",[id]),
    categories:await c.queryAll("SELECT id,CONCAT(name_en,' / ',name_bn,' · ',slug) AS label FROM categories WHERE test_data_group_id=? ORDER BY id LIMIT 200",[id]),
    orders:await c.queryAll("SELECT id,CONCAT(invoice_no,' · ',customer_name,' · ',customer_phone) AS label FROM orders WHERE test_data_group_id=? ORDER BY id LIMIT 200",[id]),
  };
  return {group,counts,blockers,cleanupRuns,markedRecords,canClean:Object.values(counts).some(n=>Number(n)>0)&&!blockers.length&&group.status==='active'};
}
async function cleanupGroup(groupId,actor,{pool=null}={}){
  assertMysql();const id=positiveId(groupId,'Group');
  try {
    return await mysql.withTransaction(async tx=>{
      const group=await tx.queryOne('SELECT * FROM test_data_groups WHERE id=? FOR UPDATE',[id]);if(!group)throw new NotFoundError('Test-data group not found.');if(group.status!=='active')throw new ConflictError('This group is not active; repeat cleanup is a safe no-op.');
      const counts=await groupCounts(tx,id),blockers=await blockersFor(tx,id,counts),deleted={};
      if(!Object.values(counts).some(n=>Number(n)>0)){await tx.execute("INSERT INTO test_data_cleanup_runs(group_id,actor_user_id,scope_json,result,detail) VALUES(?,?,?,'empty','No marked records were present; no deletions made.')",[id,actor?.id||null,JSON.stringify({counts,deleted:{},blockers:[]})]);return {deleted,blockers:[],counts,status:'empty'};}
      if(blockers.length){await tx.execute('INSERT INTO test_data_cleanup_runs(group_id,actor_user_id,scope_json,result,detail) VALUES(?,?,?,\'blocked\',?)',[id,actor?.id||null,JSON.stringify({counts,blockers}),`No records deleted: ${blockers.map(b=>b.message).join(' ')}`]);return {deleted,blockers,counts,status:'blocked'};}
      // Cart rows are disposable only when their customer or product is explicitly marked in this group.
      await tx.execute('DELETE FROM customer_cart_items WHERE customer_id IN (SELECT id FROM customers WHERE test_data_group_id=?) OR product_id IN (SELECT id FROM products WHERE test_data_group_id=?)',[id,id]);
      // Only delete isolated, explicitly marked entities with no financial, order, review, or audit dependencies.
      const products=await tx.queryAll('SELECT id FROM products WHERE test_data_group_id=? FOR UPDATE',[id]);
      for(const p of products){await tx.execute('DELETE FROM stock_reservations WHERE product_id=?',[p.id]);await tx.execute('DELETE FROM products WHERE id=? AND test_data_group_id=?',[p.id,id]);}
      deleted.products=products.length;
      const customers=await tx.queryAll('SELECT id FROM customers WHERE test_data_group_id=? FOR UPDATE',[id]);
      for(const c of customers){await tx.execute('DELETE FROM customer_addresses WHERE customer_id=?',[c.id]);await tx.execute('DELETE FROM customers WHERE id=? AND test_data_group_id=?',[c.id,id]);}
      deleted.customers=customers.length;
      const vendors=await tx.queryAll('SELECT id FROM vendors WHERE test_data_group_id=? FOR UPDATE',[id]);for(const v of vendors)await tx.execute('DELETE FROM vendors WHERE id=? AND test_data_group_id=?',[v.id,id]);deleted.vendors=vendors.length;
      const categories=await tx.queryAll('SELECT id FROM categories WHERE test_data_group_id=? FOR UPDATE',[id]);for(const x of categories)await tx.execute('DELETE FROM categories WHERE id=? AND test_data_group_id=?',[x.id,id]);deleted.categories=categories.length;
      const result='completed';await tx.execute('UPDATE test_data_groups SET status=?,cleaned_at=UTC_TIMESTAMP() WHERE id=?',['cleaned',id]);await tx.execute('INSERT INTO test_data_cleanup_runs(group_id,actor_user_id,scope_json,result,detail) VALUES(?,?,?,?,?)',[id,actor?.id||null,JSON.stringify({counts,deleted,blockers:[]}),result,'Eligible marked records deleted in one transaction; audit logs and cleanup run retained.']);await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES('admin',?,'test_data.cleanup.completed','test_data_group',?,?,?, ?,?)",[actor?.id||null,String(id),JSON.stringify({status:'active',counts}),JSON.stringify({status:'cleaned',deleted}),String(actor?.ip||'').slice(0,64),String(actor?.userAgent||'').slice(0,255)]);return {deleted,blockers:[],counts,status:'completed'};
    },{pool});
  } catch(error) {
    // A failed mutation is recorded only after the cleanup transaction has rolled back.
    try {
      const db=client(pool),group=await db.queryOne('SELECT id,status FROM test_data_groups WHERE id=?',[id]);
      if(group?.status==='active'){
        const counts=await groupCounts(db,id);
        await db.execute("INSERT INTO test_data_cleanup_runs(group_id,actor_user_id,scope_json,result,detail) VALUES(?,?,?,'failed',?)",[id,actor?.id||null,JSON.stringify({counts}),`Cleanup transaction rolled back (${String(error.code||error.name||'ERROR').slice(0,80)}). No records intentionally retained or partially deleted.`]);
        await db.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES('admin',?,'test_data.cleanup.failed','test_data_group',?,?,?,?)",[actor?.id||null,String(id),JSON.stringify({result:'failed',rolledBack:true,errorCode:String(error.code||error.name||'ERROR').slice(0,80)}),String(actor?.ip||'').slice(0,64),String(actor?.userAgent||'').slice(0,255)]);
      }
    } catch(_auditError) { /* Preserve original transactional failure; DB-level outage may also prevent the failure audit. */ }
    throw error;
  }
}
module.exports={ENTITY_TABLE,ENTITY_LABELS,groupCounts,blockersFor,listGroups,createGroup,searchUnmarked,markEntity,groupDetail,cleanupGroup};
