'use strict';
const crypto = require('crypto');
const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { requirePositiveInt, requireString, requirePaisaInt } = require('../utils/validator');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const orders = require('./phase08Repository');
function assertMysql(){if(env.db.client!=='mysql')throw new Error('D7 order and return workflows require MySQL/InnoDB.');}
function client(){assertMysql();return mysql.createQueryClient(mysql.getPool());}
async function setting(key, fallback){const row=await client().queryOne('SELECT setting_value FROM settings WHERE setting_key=?',[key]);return row?.setting_value??fallback;}
async function cancelOrder(orderId, customerId, reason, actor={}){
  assertMysql();const id=requirePositiveInt(orderId,'order ID'), customer=requirePositiveInt(customerId,'customer ID');
  const note=requireString(reason,'cancellation reason',{min:3,max:255});
  const configured=JSON.parse(await setting('d7_cancel_states','["pending","confirmed","processing"]'));
  const requestKey=`customer-cancel:${crypto.randomUUID()}`;
  return mysql.withTransaction(async tx=>{
    const order=await tx.queryOne('SELECT id,customer_id,order_status FROM orders WHERE id=? FOR UPDATE',[id]);
    if(!order||Number(order.customer_id)!==customer)throw new NotFoundError('Order not found.');
    if(!configured.includes(order.order_status)){
      if(['shipped','delivered','return_requested'].includes(order.order_status))throw new ConflictError('This order has left dispatch; submit a return or delivery-refusal request instead.');
      throw new ConflictError(`Cancellation is not available for an order in ${order.order_status} state.`);
    }
    await tx.execute('INSERT INTO order_cancellation_requests(order_id,customer_id,status,reason) VALUES(?,?,?,?)',[id,customer,'accepted',note]);
    return orders.transitionOrderTx(tx,id,'cancelled',note,{...actor,type:'customer'},requestKey);
  });
}
async function requestReturn(customerId, orderId, input={}){
  assertMysql();const customer=requirePositiveInt(customerId,'customer ID'), orderIdNum=requirePositiveInt(orderId,'order ID');
  const claim=String(input.claimType||'').trim();
  if(!['standard','wrong','damaged','expired','missing','refusal'].includes(claim))throw new ValidationError('Return claim type is invalid.');
  const reason=requireString(input.reason,'return reason',{min:5,max:500});
  if(!Array.isArray(input.items)||input.items.length<1||input.items.length>50)throw new ValidationError('Select at least one order item.');
  const normalized=input.items.map(row=>({id:requirePositiveInt(row.orderItemId,'order item ID'),qty:requirePositiveInt(row.qty,'quantity',{max:1000})}));
  if(new Set(normalized.map(x=>x.id)).size!==normalized.length)throw new ValidationError('Duplicate order item.');
  return mysql.withTransaction(async tx=>{
    const order=await tx.queryOne('SELECT id,customer_id,order_status,created_at FROM orders WHERE id=? FOR UPDATE',[orderIdNum]);
    if(!order||Number(order.customer_id)!==customer)throw new NotFoundError('Order not found.');
    if(!['delivered','shipped','return_requested'].includes(order.order_status))throw new ConflictError('Returns can only be requested for dispatched orders.');
    const ids=normalized.map(x=>x.id);
    const lines=await tx.queryAll(`SELECT oi.id,oi.qty,oi.product_id,p.category_id FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND oi.id IN (${ids.map(()=>'?').join(',')}) FOR UPDATE`,[orderIdNum,...ids]);
    if(lines.length!==normalized.length)throw new NotFoundError('One or more selected items do not belong to this order.');
    const claimException=['wrong','damaged','expired','missing','refusal'].includes(claim);
    if(!claimException){
      const delivered=await tx.queryOne("SELECT created_at FROM order_status_history WHERE order_id=? AND to_status='delivered' ORDER BY id DESC LIMIT 1",[orderIdNum]);
      const days=Number(await setting('d7_default_return_days','7'));
      const elapsed=(Date.now()-new Date(delivered?.created_at||order.created_at).getTime())/86400000;
      if(elapsed<0||elapsed>days)throw new ConflictError(`Standard returns are limited to ${days} days after delivery.`);
      for(const row of lines){
        const policy=await tx.queryOne('SELECT eligible,window_days FROM return_category_policies WHERE category_id=?',[row.category_id]);
        if(!policy||Number(policy.eligible)!==1)throw new ConflictError('A selected category is not configured as return-eligible.');
        if(elapsed>Number(policy.window_days))throw new ConflictError('The category return window has expired.');
      }
    }
    for(const line of lines){const requested=normalized.find(x=>x.id===Number(line.id));if(requested.qty>Number(line.qty))throw new ValidationError('Return quantity exceeds the purchased quantity.');const prior=await tx.queryOne(`SELECT COALESCE(SUM(ri.qty),0) AS n FROM customer_return_items ri JOIN customer_return_requests rr ON rr.id=ri.return_request_id WHERE rr.order_id=? AND ri.order_item_id=? AND rr.status IN ('requested','approved','escalated','inspected')`,[orderIdNum,line.id]);if(Number(prior?.n||0)+requested.qty>Number(line.qty))throw new ConflictError('Return quantity exceeds the units not already claimed or returned.');}
    const inserted=await tx.execute('INSERT INTO customer_return_requests(order_id,customer_id,claim_type,reason,evidence_path,status) VALUES(?,?,?,?,?,?)',[orderIdNum,customer,claim,reason,String(input.evidencePath||'').slice(0,500),'requested']);
    for(const row of normalized)await tx.execute('INSERT INTO customer_return_items(return_request_id,order_item_id,qty) VALUES(?,?,?)',[inserted.insertId,row.id,row.qty]);
    await tx.execute('INSERT INTO customer_return_events(return_request_id,from_status,to_status,note) VALUES(?,?,?,?)',[inserted.insertId,'','requested',reason]);
    if(order.order_status!=='return_requested')await orders.transitionOrderTx(tx,orderIdNum,'return_requested','Customer submitted a return/refusal request',{id:null,type:'customer'},`return-request:${crypto.randomUUID()}`);
    return {id:Number(inserted.insertId),status:'requested'};
  });
}
async function listCustomerReturns(customerId){assertMysql();return client().queryAll('SELECT r.*,o.invoice_no FROM customer_return_requests r JOIN orders o ON o.id=r.order_id WHERE r.customer_id=? ORDER BY r.id DESC',[requirePositiveInt(customerId,'customer ID')]);}
async function listReturns(status=''){
  assertMysql();const valid=['requested','approved','rejected','escalated','inspected','completed'];if(status&&!valid.includes(status))throw new ValidationError('Invalid return status filter.');
  return client().queryAll(`SELECT r.*,o.invoice_no,o.customer_name,o.customer_phone FROM customer_return_requests r JOIN orders o ON o.id=r.order_id ${status?'WHERE r.status=?':''} ORDER BY r.id DESC LIMIT 200`,status?[status]:[]);
}
async function listReturnItems(returnId){return client().queryAll('SELECT ri.*,oi.product_name,oi.vendor_id,oi.product_id FROM customer_return_items ri JOIN order_items oi ON oi.id=ri.order_item_id WHERE ri.return_request_id=? ORDER BY ri.id',[requirePositiveInt(returnId,'return ID')]);}
async function decideReturn(id,status,note,actor={}){
  assertMysql();const returnId=requirePositiveInt(id,'return ID'),target=String(status||'');
  if(!['approved','rejected','escalated'].includes(target))throw new ValidationError('Invalid return decision.');
  const reason=requireString(note,'decision note',{min:3,max:500});
  return mysql.withTransaction(async tx=>{
    const row=await tx.queryOne('SELECT id,status FROM customer_return_requests WHERE id=? FOR UPDATE',[returnId]);if(!row)throw new NotFoundError('Return request not found.');
    if(row.status!=='requested'&&!(row.status==='escalated'&&target!=='escalated'))throw new ConflictError('Return request is already decided.');
    await tx.execute('UPDATE customer_return_requests SET status=?,decision_note=?,reviewed_by_user_id=? WHERE id=?',[target,reason,actor.id||null,returnId]);
    await tx.execute('INSERT INTO customer_return_events(return_request_id,from_status,to_status,note,actor_user_id) VALUES(?,?,?,?,?)',[returnId,row.status,target,reason,actor.id||null]);
    await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',[ 'admin',actor.id||null,`return.${target}`,'customer_return',String(returnId),JSON.stringify({status:target,note:reason}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);
    return {id:returnId,status:target};
  });
}
async function inspectReturnItem(returnId,itemId,disposition,actor={}){
  assertMysql();const id=requirePositiveInt(returnId,'return ID'),lineId=requirePositiveInt(itemId,'return item ID');
  if(!['restock','damaged','expired','disposal'].includes(disposition))throw new ValidationError('Invalid inventory disposition.');
  return mysql.withTransaction(async tx=>{
    const request=await tx.queryOne('SELECT id,order_id,status FROM customer_return_requests WHERE id=? FOR UPDATE',[id]);if(!request)throw new NotFoundError('Return request not found.');
    if(!['approved','inspected'].includes(request.status))throw new ConflictError('Only approved returns may be inspected.');
    const line=await tx.queryOne('SELECT ri.id,ri.qty,ri.disposition,oi.product_id,oi.variant_id,oi.vendor_id FROM customer_return_items ri JOIN order_items oi ON oi.id=ri.order_item_id WHERE ri.id=? AND ri.return_request_id=? FOR UPDATE',[lineId,id]);
    if(!line)throw new NotFoundError('Return item not found.');if(line.disposition!=='pending_inspection')throw new ConflictError('This item has already been inspected.');
    if(disposition==='restock'){
      const product=await tx.queryOne('SELECT id,vendor_id,stock_on_hand,vendor_stock_on_hand FROM products WHERE id=? FOR UPDATE',[line.product_id]);
      if(!product||Number(product.vendor_id||0)!==Number(line.vendor_id||0))throw new ConflictError('Returned item vendor ownership no longer matches the order.');
      const pool=line.vendor_id?'vendor':'warehouse',col=line.vendor_id?'vendor_stock_on_hand':'stock_on_hand';
      if(line.variant_id){const v=await tx.queryOne('SELECT id,product_id,stock_on_hand FROM product_variants WHERE id=? FOR UPDATE',[line.variant_id]);if(!v||Number(v.product_id)!==Number(line.product_id))throw new ConflictError('Variant does not belong to returned product.');await tx.execute('UPDATE product_variants SET stock_on_hand=stock_on_hand+? WHERE id=?',[line.qty,line.variant_id]);}
      await tx.execute(`UPDATE products SET ${col}=${col}+? WHERE id=?`,[line.qty,line.product_id]);
      const balance=Number(product[col])+Number(line.qty);
      await tx.execute('INSERT INTO stock_ledger(product_id,variant_id,stock_pool,vendor_id,movement_type,qty_delta,balance_after,reference_type,reference_id,reason,actor_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[line.product_id,line.variant_id,pool,line.vendor_id,'return_restock',line.qty,balance,'return',id,'Inspected return restocked',actor.id||null]);
    }
    await tx.execute('UPDATE customer_return_items SET disposition=?,inspected_by_user_id=?,inspected_at=UTC_TIMESTAMP() WHERE id=?',[disposition,actor.id||null,lineId]);
    await tx.execute('INSERT INTO customer_return_events(return_request_id,from_status,to_status,note,actor_user_id) VALUES(?,?,?,?,?)',[id,'item_pending_inspection',`item_${disposition}`,`Item ${lineId} disposition recorded`,actor.id||null]);
    const pending=await tx.queryOne("SELECT COUNT(*) AS n FROM customer_return_items WHERE return_request_id=? AND disposition='pending_inspection'",[id]);
    if(Number(pending.n)===0){await tx.execute("UPDATE customer_return_requests SET status='inspected' WHERE id=?",[id]);await tx.execute('INSERT INTO customer_return_events(return_request_id,from_status,to_status,note,actor_user_id) VALUES(?,?,?,?,?)',[id,'approved','inspected','All items inspected',actor.id||null]);
      const incomplete=await tx.queryOne(`SELECT COUNT(*) AS n FROM order_items oi LEFT JOIN (SELECT ri.order_item_id,SUM(ri.qty) AS inspected_qty FROM customer_return_items ri JOIN customer_return_requests rr ON rr.id=ri.return_request_id WHERE rr.order_id=? AND rr.status='inspected' AND ri.disposition<>'pending_inspection' GROUP BY ri.order_item_id) returned ON returned.order_item_id=oi.id WHERE oi.order_id=? AND COALESCE(returned.inspected_qty,0)<oi.qty`,[request.order_id,request.order_id]);
      const order=await tx.queryOne('SELECT order_status FROM orders WHERE id=? FOR UPDATE',[request.order_id]);
      if(Number(incomplete.n)===0&&order?.order_status==='return_requested')await orders.transitionOrderTx(tx,request.order_id,'returned','All ordered units approved and inspected with disposition',{id:actor.id||null,type:'admin'},`return-complete:${crypto.randomUUID()}`);
    }
    return {returnId:id,itemId:lineId,disposition};
  });
}
function validateCommissionBps(value){const n=Number(value);if(!Number.isInteger(n)||n<0||n>10000)throw new ValidationError('Commission must be integer basis points from 0 to 10000.');return n;}
async function saveSettings(input,actor={}){
  assertMysql();const cancel=JSON.parse(String(input.cancel_states||''));if(!Array.isArray(cancel)||!cancel.length||cancel.some(x=>!['pending','confirmed','processing'].includes(x)))throw new ValidationError('Cancellation states must be selected from pending, confirmed and processing.');
  const days=Number(input.default_return_days),hold=Number(input.settlement_hold_days),limit=requirePaisaInt(input.refund_approval_limit_paisa||0,'refund approval limit');
  if(!Number.isInteger(days)||days<1||days>60||!Number.isInteger(hold)||hold<0||hold>180)throw new ValidationError('Return window must be 1–60 days and settlement hold 0–180 days.');
  return mysql.withTransaction(async tx=>{
    const values={d7_cancel_states:JSON.stringify(cancel),d7_default_return_days:String(days),d7_settlement_hold_days:String(hold),d7_refund_approval_limit_paisa:String(limit),d7_refund_execution_enabled:'off',d7_cod_refund_requires_verified_destination:'on',d7_supported_payment_methods:'["cod"]'};
    for(const [key,val] of Object.entries(values))await tx.execute('INSERT INTO settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',[key,val]);
    await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',['admin',actor.id||null,'d7.settings.updated','settings','d7',JSON.stringify(values),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);
    return values;
  });
}
async function getSettings(){const db=client(),rows=await db.queryAll("SELECT setting_key,setting_value FROM settings WHERE setting_key LIKE 'd7_%'");return Object.fromEntries(rows.map(r=>[r.setting_key,r.setting_value]));}
async function listCategoryPolicies(){return client().queryAll('SELECT c.id,c.name,COALESCE(p.eligible,0) AS eligible,COALESCE(p.window_days,7) AS window_days FROM categories c LEFT JOIN return_category_policies p ON p.category_id=c.id ORDER BY c.name');}
async function saveCategoryPolicy(categoryId,eligible,windowDays,actor={}){
  const id=requirePositiveInt(categoryId,'category ID'),days=Number(windowDays);if(!['0','1',0,1,false,true].includes(eligible)||!Number.isInteger(days)||days<1||days>60)throw new ValidationError('Category eligibility and return window are invalid.');
  const enabled=eligible===true||eligible===1||eligible==='1';
  return mysql.withTransaction(async tx=>{await tx.execute('INSERT INTO return_category_policies(category_id,eligible,window_days,updated_by_user_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE eligible=VALUES(eligible),window_days=VALUES(window_days),updated_by_user_id=VALUES(updated_by_user_id)',[id,enabled?1:0,days,actor.id||null]);await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',['admin',actor.id||null,'d7.return_category.updated','category',String(id),JSON.stringify({eligible:enabled,windowDays:days}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);return{categoryId:id,eligible:enabled,windowDays:days};});
}
async function prepareSettlement(vendorId,periodStart,periodEnd,actor={}){
  assertMysql();const id=requirePositiveInt(vendorId,'vendor ID');const start=String(periodStart||''),end=String(periodEnd||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)throw new ValidationError('Settlement period must use valid YYYY-MM-DD dates.');
  const hold=Number(await setting('d7_settlement_hold_days','7'));
  return mysql.withTransaction(async tx=>{
    const vendor=await tx.queryOne('SELECT id,commission_rate_bps FROM vendors WHERE id=? FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor not found.');
    const rows=await tx.queryAll(`SELECT oi.order_id,oi.id AS order_item_id,oi.line_total_paisa,dh.delivered_at FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN (SELECT order_id,MAX(created_at) AS delivered_at FROM order_status_history WHERE to_status='delivered' GROUP BY order_id) dh ON dh.order_id=o.id WHERE oi.vendor_id=? AND o.order_status='delivered' AND DATE(dh.delivered_at)>=? AND DATE(dh.delivered_at)<=? AND dh.delivered_at<=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY) ORDER BY oi.order_id,oi.id FOR UPDATE`,[id,start,end,hold]);
    const gross=rows.reduce((n,r)=>n+BigInt(r.line_total_paisa),0n);const commission=(gross*BigInt(vendor.commission_rate_bps))/10000n;
    const orderIds=[...new Set(rows.map(r=>Number(r.order_id)))];let cod=0n,refunds=0n;const vendorByOrder=new Map();
    for(const row of rows)vendorByOrder.set(Number(row.order_id),(vendorByOrder.get(Number(row.order_id))||0n)+BigInt(row.line_total_paisa));
    const existingSettlement=orderIds.length?await tx.queryOne(`SELECT COUNT(*) AS n FROM vendor_settlement_items WHERE order_item_id IN (${rows.map(()=>'?').join(',')})`,rows.map(r=>r.order_item_id)):null;
    if(Number(existingSettlement?.n||0)>0)throw new ConflictError('One or more delivered order items are already included in a prepared or approved settlement.');
    const evidence={orderIds,orderItemIds:rows.map(r=>Number(r.order_item_id)),holdDays:hold,commissionRateBps:Number(vendor.commission_rate_bps),refundDeductionPaisa:'0',codCollectionPaisa:'0',adjustmentsPaisa:'0',adjustmentIds:[],unsupportedRefundExecution:'disabled'};
    if(orderIds.length){
      const marks=orderIds.map(()=>'?').join(',');
      const totals=await tx.queryAll(`SELECT order_id,SUM(line_total_paisa) AS total_paisa FROM order_items WHERE order_id IN (${marks}) GROUP BY order_id`,orderIds);
      const codRows=await tx.queryAll(`SELECT order_id,SUM(cod_amount_paisa) AS amount_paisa FROM courier_shipments WHERE order_id IN (${marks}) AND is_active=1 AND settled_at IS NOT NULL GROUP BY order_id`,orderIds);
      const refundRows=await tx.queryAll(`SELECT order_id,SUM(amount_paisa) AS amount_paisa FROM refunds WHERE order_id IN (${marks}) AND status IN ('succeeded','completed') GROUP BY order_id`,orderIds);
      const totalByOrder=new Map(totals.map(r=>[Number(r.order_id),BigInt(r.total_paisa||0)]));
      const codByOrder=new Map(codRows.map(r=>[Number(r.order_id),BigInt(r.amount_paisa||0)]));
      const refundByOrder=new Map(refundRows.map(r=>[Number(r.order_id),BigInt(r.amount_paisa||0)]));
      for(const orderId of orderIds){const denominator=totalByOrder.get(orderId)||0n,share=vendorByOrder.get(orderId)||0n;if(denominator<=0n)throw new ConflictError('Settlement order line totals are invalid.');cod+=(codByOrder.get(orderId)||0n)*share/denominator;refunds+=(refundByOrder.get(orderId)||0n)*share/denominator;}
    }
    const adjustmentRows=await tx.queryAll("SELECT id,direction,amount_paisa FROM vendor_financial_adjustments WHERE vendor_id=? AND status='approved' AND settlement_batch_id IS NULL AND effective_date>=? AND effective_date<=? ORDER BY id FOR UPDATE",[id,start,end]);
    const adjustments=adjustmentRows.reduce((n,r)=>n+(r.direction==='credit'?BigInt(r.amount_paisa):-BigInt(r.amount_paisa)),0n),net=gross-commission-refunds+adjustments;
    if(net<0n)throw new ConflictError('Settlement net payable cannot be negative.');
    evidence.refundDeductionPaisa=refunds.toString();evidence.codCollectionPaisa=cod.toString();evidence.adjustmentsPaisa=adjustments.toString();evidence.adjustmentIds=adjustmentRows.map(r=>Number(r.id));
    const result=await tx.execute('INSERT INTO vendor_settlement_batches(vendor_id,period_start,period_end,gross_paisa,commission_paisa,adjustments_paisa,refunds_paisa,cod_collection_paisa,net_payable_paisa,status,evidence_json,prepared_by_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,start,end,Number(gross),Number(commission),Number(adjustments),Number(refunds),Number(cod),Number(net),'prepared',JSON.stringify(evidence),actor.id||null]);
    let allocatedCommission=0n;for(let index=0;index<rows.length;index++){const row=rows[index],lineGross=BigInt(row.line_total_paisa);const lineCommission=index===rows.length-1?commission-allocatedCommission:(gross?lineGross*BigInt(vendor.commission_rate_bps)/10000n:0n);allocatedCommission+=lineCommission;await tx.execute('INSERT INTO vendor_settlement_items(settlement_batch_id,order_item_id,gross_paisa,commission_paisa,refund_paisa,cod_collection_paisa) VALUES(?,?,?,?,0,0)',[result.insertId,row.order_item_id,Number(lineGross),Number(lineCommission)]);}
    for(const adjustment of adjustmentRows)await tx.execute('UPDATE vendor_financial_adjustments SET settlement_batch_id=? WHERE id=? AND settlement_batch_id IS NULL',[result.insertId,adjustment.id]);
    await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',['admin',actor.id||null,'settlement.prepared','vendor_settlement',String(result.insertId),JSON.stringify(evidence),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);
    return{id:Number(result.insertId),vendorId:id,grossPaisa:Number(gross),commissionPaisa:Number(commission),adjustmentsPaisa:Number(adjustments),refundsPaisa:Number(refunds),codCollectionPaisa:Number(cod),netPayablePaisa:Number(net),status:'prepared',evidence};
  });
}
async function createAdjustment(vendorId,input={},actor={}){
  assertMysql();const id=requirePositiveInt(vendorId,'vendor ID'),direction=String(input.direction||'');if(!['credit','debit'].includes(direction))throw new ValidationError('Adjustment direction must be credit or debit.');
  const amount=requirePaisaInt(input.amount_paisa,'adjustment amount');if(amount<1)throw new ValidationError('Adjustment amount must be positive paisa.');
  const date=String(input.effective_date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new ValidationError('Effective date must use YYYY-MM-DD.');
  const reason=requireString(input.reason,'adjustment reason',{min:5,max:255});
  return mysql.withTransaction(async tx=>{const vendor=await tx.queryOne('SELECT id FROM vendors WHERE id=? FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor not found.');const result=await tx.execute("INSERT INTO vendor_financial_adjustments(vendor_id,effective_date,direction,amount_paisa,reason,status,created_by_user_id) VALUES(?,?,?,?,?,'pending',?)",[id,date,direction,amount,reason,actor.id||null]);await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',['admin',actor.id||null,'settlement.adjustment.created','vendor_adjustment',String(result.insertId),JSON.stringify({vendorId:id,date,direction,amountPaisa:amount,reason}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);return{id:Number(result.insertId),status:'pending'};});
}
async function listAdjustments(){return client().queryAll('SELECT a.*,v.shop_name FROM vendor_financial_adjustments a JOIN vendors v ON v.id=a.vendor_id ORDER BY a.id DESC LIMIT 200');}
async function decideAdjustment(adjustmentId,status,note,actor={}){
  const id=requirePositiveInt(adjustmentId,'adjustment ID');if(!['approved','rejected'].includes(status))throw new ValidationError('Adjustment decision is invalid.');const reason=requireString(note,'decision note',{min:3,max:255});
  return mysql.withTransaction(async tx=>{const row=await tx.queryOne('SELECT id,status,created_by_user_id FROM vendor_financial_adjustments WHERE id=? FOR UPDATE',[id]);if(!row)throw new NotFoundError('Adjustment not found.');if(row.status!=='pending')throw new ConflictError('Only pending adjustments may be decided.');if(Number(row.created_by_user_id||0)===Number(actor.id||0))throw new ConflictError('A different administrator must review the adjustment.');await tx.execute('UPDATE vendor_financial_adjustments SET status=?,approved_by_user_id=?,approved_at=UTC_TIMESTAMP(),decision_note=? WHERE id=?',[status,actor.id||null,reason,id]);await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',['admin',actor.id||null,`settlement.adjustment.${status}`,'vendor_adjustment',String(id),JSON.stringify({status,note:reason}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);return{id,status};});
}

async function listSettlements(){return client().queryAll('SELECT s.*,v.shop_name FROM vendor_settlement_batches s JOIN vendors v ON v.id=s.vendor_id ORDER BY s.id DESC LIMIT 200');}
async function approveSettlement(batchId,actor={}){
  const id=requirePositiveInt(batchId,'settlement ID');return mysql.withTransaction(async tx=>{const row=await tx.queryOne('SELECT id,status,prepared_by_user_id,net_payable_paisa FROM vendor_settlement_batches WHERE id=? FOR UPDATE',[id]);if(!row)throw new NotFoundError('Settlement not found.');if(row.status!=='prepared')throw new ConflictError('Only a prepared settlement can be approved.');if(Number(row.prepared_by_user_id||0)===Number(actor.id||0))throw new ConflictError('A different authorized administrator must approve this settlement.');await tx.execute("UPDATE vendor_settlement_batches SET status='approved',approved_by_user_id=?,approved_at=UTC_TIMESTAMP() WHERE id=?",[actor.id||null,id]);await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',['admin',actor.id||null,'settlement.approved','vendor_settlement',String(id),JSON.stringify({netPayablePaisa:Number(row.net_payable_paisa)}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);return{id,status:'approved'};});
}
module.exports={cancelOrder,requestReturn,listCustomerReturns,listReturns,listReturnItems,decideReturn,inspectReturnItem,saveSettings,getSettings,listCategoryPolicies,saveCategoryPolicy,prepareSettlement,listSettlements,approveSettlement,createAdjustment,listAdjustments,decideAdjustment,validateCommissionBps};
