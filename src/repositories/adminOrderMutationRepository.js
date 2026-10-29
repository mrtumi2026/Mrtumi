'use strict';

const crypto = require('crypto');
const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { executeIdempotent } = require('./idempotencyRepository');
const phase08 = require('./phase08Repository');
const { normalizeBdPhone, requirePaisaFromBdt, requirePositiveInt, requireString } = require('../utils/validator');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const SAFE_ADMIN_STATUSES = new Set(['confirmed','processing','shipped']);
const EDITABLE_STATUSES = new Set(['pending','confirmed','processing']);
const MAX_BULK_ORDERS = 50;

function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Admin order mutations require MySQL/InnoDB.');
}
function normalizeOrderQty(raw, { allowZero = false } = {}) {
  const qty = Number(raw);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(qty) || qty < min || qty > 100_000) {
    throw new ValidationError(`Order quantity must be a whole number between ${min} and 100000.`);
  }
  return qty;
}
function recalculateTotals({ subtotalPaisa, shippingPaisa, discountPaisa, paidPaisa = 0 }) {
  for (const [field,value] of Object.entries({ subtotalPaisa,shippingPaisa,discountPaisa,paidPaisa })) {
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new ValidationError(`${field} must be a non-negative integer in paisa.`);
  }
  const subtotal = Number(subtotalPaisa);
  const shipping = Number(shippingPaisa);
  const discount = Number(discountPaisa);
  const paid = Number(paidPaisa);
  const total = Math.max(0, subtotal + shipping - discount);
  if (!Number.isSafeInteger(total)) throw new ValidationError('Order total exceeds the supported amount.');
  if (paid > total) throw new ConflictError('Order total cannot be reduced below the amount already recorded as paid.');
  return { subtotalPaisa:subtotal, shippingPaisa:shipping, discountPaisa:discount, totalPaisa:total, codDuePaisa:total-paid };
}
function requestKey(raw) { return requireString(raw, 'request key', { min:8, max:128 }); }
function actorFields(actor = {}) {
  return { id:actor.id || null, ip:String(actor.ip || '').slice(0,64), userAgent:String(actor.userAgent || '').slice(0,255) };
}
async function insertAudit(tx, actor, action, orderId, beforeState, afterState) {
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,?,?,?,?,?,?,?)`, [actor.id || null,action,'order',String(orderId),JSON.stringify(logger.redactValue(beforeState || {})),JSON.stringify(logger.redactValue(afterState || {})),actor.ip || '',actor.userAgent || '']);
}
function normalizedOrderLines(rows) {
  return phase08.normalizeOrderLines(rows.map((row)=>({product_id:row.product_id,variant_id:row.variant_id ?? null,qty:Number(row.qty)})));
}
function lineHash(lines) { return crypto.createHash('sha256').update(JSON.stringify(lines)).digest('hex'); }
async function getOrder(tx, id) {
  const order=await tx.queryOne('SELECT id,invoice_no,customer_name,customer_phone,shipping_address,shipping_zone,subtotal_paisa,shipping_paisa,discount_paisa,total_paisa,paid_paisa,cod_due_paisa,payment_method,payment_status,order_status,order_channel,courier_code,courier_tracking_id,delivery_boy_id,admin_note FROM orders WHERE id=? FOR UPDATE',[id]);
  if(!order)throw new NotFoundError('Order not found.');
  return order;
}
async function getOrderLines(tx, orderId) {
  return tx.queryAll('SELECT id,product_id,variant_id,product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label,color_label FROM order_items WHERE order_id=? ORDER BY id FOR UPDATE',[orderId]);
}
async function getReservationState(tx, orderId, order, currentLines) {
  const key=`order:${orderId}`;
  const rows=await tx.queryAll('SELECT id,product_id,variant_id,stock_pool,qty,request_hash,status,expires_at FROM stock_reservations WHERE reservation_key=? ORDER BY product_id,variant_id FOR UPDATE',[key]);
  const active=rows.filter((row)=>row.status==='active');
  if(order.order_status==='pending') {
    if(rows.length)throw new ConflictError('Pending order has prior inventory reservation history; item edits are disabled until reservation state is resolved.');
    return { active:[], expiresAt:null };
  }
  if(!['confirmed','processing'].includes(order.order_status))throw new ConflictError(`Order items cannot be edited in ${order.order_status} state.`);
  if(!active.length)throw new ConflictError('This order has no active inventory reservation; item edits are blocked to protect stock history.');
  if(rows.some((row)=>row.status!=='active' && (row.status!=='released' || currentLines.some((line)=>Number(line.product_id)===Number(row.product_id)))))throw new ConflictError('Order has expired or consumed inventory history; item edits are blocked.');
  if(active.some((row)=>new Date(row.expires_at).getTime()<=Date.now()))throw new ConflictError('Order inventory reservation has expired; item edits are blocked.');
  if(active.some((row)=>row.stock_pool!=='warehouse' || row.variant_id!=null))throw new ConflictError('Item edits for vendor or variant reservations are not supported by this admin form.');
  const lines=normalizedOrderLines(currentLines);
  if(new Set(lines.map((line)=>line.productId)).size!==lines.length)throw new ConflictError('Order contains multiple variant lines for one product; item edits are blocked.');
  if(active.length!==lines.length)throw new ConflictError('Order items and active inventory reservations do not match.');
  const activeLines=active.map((row)=>({product_id:row.product_id,variant_id:row.variant_id,qty:Number(row.qty)}));
  const reservations=normalizedOrderLines(activeLines);
  if(JSON.stringify(lines)!==JSON.stringify(reservations))throw new ConflictError('Order items and active inventory reservations do not match.');
  const expectedHash=lineHash(lines);
  if(active.some((row)=>row.request_hash!==expectedHash))throw new ConflictError('Order reservation hash does not match its current items.');
  return {active,expiresAt:active[0].expires_at};
}
async function adjustReservations(tx, orderId, order, currentLines, nextLines, actor, reason) {
  const reservationState=await getReservationState(tx,orderId,order,currentLines);
  if(!reservationState.active.length)return;
  const oldLines=normalizedOrderLines(currentLines);
  const newLines=normalizedOrderLines(nextLines);
  if(new Set(newLines.map((line)=>line.productId)).size!==newLines.length)throw new ConflictError('The current order reservation schema allows one product line per order.');
  const oldByProduct=new Map(oldLines.map((line)=>[line.productId,line]));
  const newByProduct=new Map(newLines.map((line)=>[line.productId,line]));
  const productIds=[...new Set([...oldByProduct.keys(),...newByProduct.keys()])].sort((a,b)=>a-b);
  const products=await tx.queryAll(`SELECT id,stock_on_hand,stock_reserved,vendor_id,status,is_archived,approval_status FROM products WHERE id IN (${productIds.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,productIds);
  const productById=new Map(products.map((product)=>[Number(product.id),product]));
  const reservationByProduct=new Map(reservationState.active.map((row)=>[Number(row.product_id),row]));
  const nextHash=lineHash(newLines);
  for(const productId of productIds) {
    const beforeQty=oldByProduct.get(productId)?.qty||0;
    const afterQty=newByProduct.get(productId)?.qty||0;
    const delta=afterQty-beforeQty;
    const product=productById.get(productId);
    if(!product)throw new ConflictError('An order product no longer exists; item edit was not applied.');
    if(product.vendor_id!=null)throw new ConflictError('Vendor inventory cannot be changed by the platform order-item editor.');
    if(afterQty>0 && (Number(product.status)!==1 || Number(product.is_archived)===1 || product.approval_status!=='approved'))throw new ConflictError('An order product is no longer available for reservation.');
    if(delta>0 && Number(product.stock_on_hand)-Number(product.stock_reserved)<delta)throw new ConflictError('Insufficient available stock for the requested order quantity.');
    if(delta<0 && Number(product.stock_reserved)<-delta)throw new ConflictError('Held product reservation is inconsistent; item edit was not applied.');
    if(delta!==0) {
      const changed=await tx.execute('UPDATE products SET stock_reserved=stock_reserved+? WHERE id=? AND stock_reserved+?>=0',[delta,productId,delta]);
      if(changed.affectedRows!==1)throw new ConflictError('Product reservation changed during the edit; retry the operation.');
      const existing=reservationByProduct.get(productId);
      if(afterQty===0) {
        const released=await tx.execute('UPDATE stock_reservations SET status=\'released\',request_hash=? WHERE id=? AND status=\'active\'',[nextHash,existing.id]);
        if(released.affectedRows!==1)throw new ConflictError('Product reservation changed during the edit; retry the operation.');
      } else if(existing) {
        await tx.execute('UPDATE stock_reservations SET qty=?,request_hash=? WHERE id=? AND status=\'active\'',[afterQty,nextHash,existing.id]);
      } else {
        if(reservationState.active.some((row)=>Number(row.product_id)===productId) || await tx.queryOne('SELECT id FROM stock_reservations WHERE reservation_key=? AND product_id=?',[`order:${orderId}`,productId]))throw new ConflictError('A released reservation exists for this product; it cannot be recreated for this order.');
        await tx.execute('INSERT INTO stock_reservations(product_id,variant_id,stock_pool,qty,reservation_key,request_hash,status,expires_at) VALUES(?,NULL,\'warehouse\',?,?,?,\'active\',?)',[productId,afterQty,`order:${orderId}`,nextHash,reservationState.expiresAt]);
      }
      const movement=delta>0?'order_item_reserve':'order_item_release';
      await tx.execute(`INSERT INTO stock_ledger(product_id,stock_pool,movement_type,qty_delta,balance_after,reference_type,reference_id,reason,actor_user_id)
        VALUES(?,'warehouse',?,0,?,'order',?,?,?)`,[productId,movement,Number(product.stock_on_hand),orderId,reason,actor.id||null]);
    } else if(afterQty>0) {
      const existing=reservationByProduct.get(productId);
      if(existing)await tx.execute('UPDATE stock_reservations SET request_hash=? WHERE id=? AND status=\'active\'',[nextHash,existing.id]);
    }
  }
}
async function recalculateOrder(tx, order, orderId, currentLines, actor, action, itemInfo) {
  const rows=await tx.queryAll('SELECT unit_price_paisa,qty FROM order_items WHERE order_id=? ORDER BY id',[orderId]);
  const subtotalPaisa=rows.reduce((sum,row)=>sum+Number(row.unit_price_paisa)*Number(row.qty),0);
  if(!Number.isSafeInteger(subtotalPaisa))throw new ValidationError('Order subtotal exceeds the supported amount.');
  const totals=recalculateTotals({subtotalPaisa,shippingPaisa:Number(order.shipping_paisa),discountPaisa:Number(order.discount_paisa),paidPaisa:Number(order.paid_paisa)});
  await tx.execute('UPDATE orders SET subtotal_paisa=?,total_paisa=?,cod_due_paisa=? WHERE id=?',[totals.subtotalPaisa,totals.totalPaisa,totals.codDuePaisa,orderId]);
  await insertAudit(tx,actor,action,orderId,{itemCount:currentLines.length,subtotalPaisa:Number(order.subtotal_paisa),totalPaisa:Number(order.total_paisa)}, { ...itemInfo,itemCount:rows.length,subtotalPaisa:totals.subtotalPaisa,totalPaisa:totals.totalPaisa });
  return totals;
}
async function addOrderItem(orderIdInput, input = {}, actor = {}) {
  assertMysql();
  const orderId=requirePositiveInt(orderIdInput,'order ID');
  const productId=requirePositiveInt(input.product_id,'product ID');
  const qty=normalizeOrderQty(input.qty ?? 1);
  const key=requestKey(input.request_key);
  const actorData=actorFields(actor);
  const payload={orderId,productId,qty};
  const out=await executeIdempotent({scope:`admin.order.item.add:${orderId}`,idempotencyKey:key,payload,workFn:async(tx)=>{
    const order=await getOrder(tx,orderId);
    if(!EDITABLE_STATUSES.has(order.order_status))throw new ConflictError(`Order items cannot be edited in ${order.order_status} state.`);
    if(order.payment_status==='paid' || Number(order.paid_paisa)>0)throw new ConflictError('Paid orders cannot be edited through the order-item form.');
    const current=await getOrderLines(tx,orderId);
    if(!current.length)throw new ConflictError('An order without existing lines cannot be edited through this route.');
    const reservationState=await getReservationState(tx,orderId,order,current);
    const productIds=[...new Set([...current.map((item)=>Number(item.product_id)),productId])].sort((a,b)=>a-b);
    await tx.queryAll(`SELECT id FROM products WHERE id IN (${productIds.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,productIds);
    const product=await tx.queryOne(`SELECT id,sku,COALESCE(NULLIF(name_en,''),name_bn) AS name,image_url,sale_price_paisa,unit_label,status,is_archived,approval_status,vendor_id
      FROM products WHERE id=? FOR UPDATE`,[productId]);
    if(!product)throw new NotFoundError('Selected product was not found.');
    if(Number(product.status)!==1 || Number(product.is_archived)===1 || product.approval_status!=='approved' || product.vendor_id!=null)throw new ConflictError('Selected product is not available for platform order editing.');
    const price=Number(product.sale_price_paisa);
    if(!Number.isSafeInteger(price)||price<0)throw new ValidationError('Selected product price is invalid.');
    const existing=current.find((item)=>Number(item.product_id)===productId && item.variant_id==null);
    if(current.some((item)=>Number(item.product_id)===productId && item.variant_id!=null))throw new ConflictError('Selected product has variant lines that this admin form cannot merge.');
    const updatedQty=(existing?Number(existing.qty):0)+qty;
    if(updatedQty>100_000)throw new ValidationError('Combined order quantity exceeds 100000.');
    if(!existing && reservationState.active.some((row)=>Number(row.product_id)===productId))throw new ConflictError('Order reservation does not match its item lines.');
    if(!existing && reservationState.active.length && await tx.queryOne('SELECT id FROM stock_reservations WHERE reservation_key=? AND product_id=?',[`order:${orderId}`,productId]))throw new ConflictError('A prior released reservation exists; this order cannot reserve this product again.');
    const unitPrice=existing?Number(existing.unit_price_paisa):price;
    if(!Number.isSafeInteger(unitPrice)||unitPrice<0||!Number.isSafeInteger(unitPrice*updatedQty))throw new ValidationError('Order item amount exceeds the supported range.');
    if(existing)await tx.execute('UPDATE order_items SET qty=?,line_total_paisa=? WHERE id=? AND order_id=?',[updatedQty,unitPrice*updatedQty,existing.id,orderId]);
    else await tx.execute(`INSERT INTO order_items(order_id,product_id,product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label)
      VALUES(?,?,?,?,?,?,?,?)`,[orderId,productId,product.name,String(product.image_url||''),price,qty,price*qty,String(product.unit_label||'')]);
    const next=await getOrderLines(tx,orderId);
    await adjustReservations(tx,orderId,order,current,next,actorData,'Admin order item added');
    const totals=await recalculateOrder(tx,order,orderId,current,actorData,'order.item.added',{productId,quantityAdded:qty});
    return {orderId,productId,quantity:updatedQty,totals};
  }});
  return out.response;
}
async function updateOrderItem(orderIdInput,itemIdInput,input={},actor={}) {
  assertMysql();
  const orderId=requirePositiveInt(orderIdInput,'order ID');
  const itemId=requirePositiveInt(itemIdInput,'order item ID');
  const qty=normalizeOrderQty(input.qty,{allowZero:true});
  const key=requestKey(input.request_key);
  const actorData=actorFields(actor);
  const payload={orderId,itemId,qty};
  const out=await executeIdempotent({scope:`admin.order.item.update:${orderId}:${itemId}`,idempotencyKey:key,payload,workFn:async(tx)=>{
    const order=await getOrder(tx,orderId);
    if(!EDITABLE_STATUSES.has(order.order_status))throw new ConflictError(`Order items cannot be edited in ${order.order_status} state.`);
    if(order.payment_status==='paid' || Number(order.paid_paisa)>0)throw new ConflictError('Paid orders cannot be edited through the order-item form.');
    const current=await getOrderLines(tx,orderId);
    const item=current.find((row)=>Number(row.id)===itemId);
    if(!item)throw new NotFoundError('Order item was not found for this order.');
    if(item.variant_id!=null)throw new ConflictError('Variant order items are not supported by this admin form.');
    if(qty===0 && current.length===1)throw new ConflictError('An order must retain at least one item.');
    const reservationState=await getReservationState(tx,orderId,order,current);
    if(qty===0)await tx.execute('DELETE FROM order_items WHERE id=? AND order_id=?',[itemId,orderId]);
    else await tx.execute('UPDATE order_items SET qty=?,line_total_paisa=? WHERE id=? AND order_id=?',[qty,Number(item.unit_price_paisa)*qty,itemId,orderId]);
    const next=await getOrderLines(tx,orderId);
    await adjustReservations(tx,orderId,order,current,next,actorData,qty===0?'Admin order item removed':'Admin order item quantity changed');
    const totals=await recalculateOrder(tx,order,orderId,current,actorData,qty===0?'order.item.removed':'order.item.updated',{itemId,productId:Number(item.product_id),quantityBefore:Number(item.qty),quantityAfter:qty});
    return {orderId,itemId,quantity:qty,totals};
  }});
  return out.response;
}
function optionalText(value,field,max) {
  const text=String(value??'').trim();
  if(text.length>max)throw new ValidationError(`${field} must not exceed ${max} characters.`);
  return text;
}
function safeTargetStatus(raw) {
  const target=String(raw||'').trim();
  if(!SAFE_ADMIN_STATUSES.has(target)) {
    if(['cancelled','failed','returned','return_requested','delivered','completed'].includes(target))throw new ConflictError('This order status is blocked pending the applicable owner-approved lifecycle policy.');
    throw new ValidationError('Unsupported order status for this admin action.');
  }
  return target;
}
async function transitionOrder(orderIdInput,targetInput,input={},actor={}) {
  assertMysql();
  const id=requirePositiveInt(orderIdInput,'order ID');
  const target=safeTargetStatus(targetInput);
  const reason=requireString(input.reason||'Admin status update','transition reason',{min:3,max:255});
  const key=requestKey(input.request_key);
  return phase08.transitionOrder(id,target,reason,actorFields(actor),key);
}
async function updateAdminOrder(orderIdInput,input={},actor={}) {
  assertMysql();
  const orderId=requirePositiveInt(orderIdInput,'order ID');
  const key=requestKey(input.request_key);
  const values=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
  const customerName=requireString(values.customer_name,'customer name',{min:2,max:191});
  const phone=normalizeBdPhone(values.phone,'customer phone');
  const address=optionalText(values.address,'address',2000);
  const shippingPaisa=requirePaisaFromBdt(values.shipping_charge,'shipping charge');
  const discountPaisa=requirePaisaFromBdt(values.discount,'discount');
  const status=String(values.status||'').trim();
  const paymentStatus=String(values.payment_status||'').trim();
  const courierName=optionalText(values.courier_name,'courier name',100);
  const trackingId=optionalText(values.courier_tracking_id,'courier tracking ID',120);
  const deliveryBoyRaw=String(values.delivery_boy_id??'').trim();
  const deliveryBoyId=deliveryBoyRaw?requirePositiveInt(deliveryBoyRaw,'delivery person ID'):null;
  const adminNote=optionalText(values.admin_note,'admin note',2000);
  const actorData=actorFields(actor);
  const payload={orderId,customerName,phone,address,shippingPaisa,discountPaisa,status,paymentStatus,courierName,trackingId,deliveryBoyId,adminNote};
  const out=await executeIdempotent({scope:`admin.order.update:${orderId}`,idempotencyKey:key,payload,workFn:async(tx)=>{
    const order=await getOrder(tx,orderId);
    if(paymentStatus && paymentStatus!==order.payment_status)throw new ConflictError('Payment status must be changed through the payment-record workflow.');
    const totals=recalculateTotals({subtotalPaisa:Number(order.subtotal_paisa),shippingPaisa,discountPaisa,paidPaisa:Number(order.paid_paisa)});
    let courierCode='';
    if(courierName) {
      const courier=await tx.queryOne('SELECT code FROM courier_apis WHERE name=? AND status=1 ORDER BY id LIMIT 1 FOR UPDATE',[courierName]);
      if(!courier)throw new ValidationError('Selected courier is not active.');
      courierCode=requireString(courier.code,'courier code',{min:1,max:32});
    }
    if(deliveryBoyId) {
      const rider=await tx.queryOne('SELECT id FROM delivery_boys WHERE id=? AND status=1 FOR UPDATE',[deliveryBoyId]);
      if(!rider)throw new ValidationError('Selected delivery person is not active.');
    }
    const oldStatus=String(order.order_status);
    if(status && status!==oldStatus) {
      safeTargetStatus(status);
      await phase08.transitionOrderTx(tx,orderId,status,'Admin order update',actorData,key);
    }
    const effectiveAddress=address||String(order.shipping_address||'');
    const effectiveTracking=courierCode===order.courier_code?(trackingId||String(order.courier_tracking_id||'')):(courierCode?trackingId:'');
    await tx.execute(`UPDATE orders SET customer_name=?,customer_phone=?,shipping_address=?,shipping_paisa=?,discount_paisa=?,total_paisa=?,cod_due_paisa=?,
      courier_code=?,courier_tracking_id=?,delivery_boy_id=?,admin_note=? WHERE id=?`,
    [customerName,phone,effectiveAddress,totals.shippingPaisa,totals.discountPaisa,totals.totalPaisa,totals.codDuePaisa,courierCode,effectiveTracking,deliveryBoyId,adminNote,orderId]);
    const oldDeliveryBoyId=order.delivery_boy_id==null?null:Number(order.delivery_boy_id);
    const changed=customerName!==order.customer_name||phone!==order.customer_phone||effectiveAddress!==order.shipping_address||totals.shippingPaisa!==Number(order.shipping_paisa)||totals.discountPaisa!==Number(order.discount_paisa)||courierCode!==order.courier_code||effectiveTracking!==order.courier_tracking_id||deliveryBoyId!==oldDeliveryBoyId||adminNote!==String(order.admin_note||'');
    if(changed)await insertAudit(tx,actorData,'order.updated',orderId,{customerName:order.customer_name,phone:order.customer_phone,address:order.shipping_address,shippingPaisa:Number(order.shipping_paisa),discountPaisa:Number(order.discount_paisa),courierCode:order.courier_code,trackingId:order.courier_tracking_id,deliveryBoyId:order.delivery_boy_id,adminNote:order.admin_note}, {customerName,phone,address:effectiveAddress,shippingPaisa:totals.shippingPaisa,discountPaisa:totals.discountPaisa,courierCode,trackingId:effectiveTracking,deliveryBoyId,adminNote});
    return {orderId,status:status||oldStatus,changed:changed||status!==oldStatus,totals};
  }});
  return out.response;
}
function normalizeOrderIds(raw) {
  const values=Array.isArray(raw)?raw:[raw];
  if(!values.length||values.length>MAX_BULK_ORDERS)throw new ValidationError(`Select between 1 and ${MAX_BULK_ORDERS} orders.`);
  const ids=[...new Set(values.map((value)=>requirePositiveInt(value,'order ID')))];
  if(ids.length!==values.length)throw new ValidationError('Duplicate order IDs are not allowed in a bulk action.');
  return ids.sort((a,b)=>a-b);
}
async function bulkOrderAction(input={},actor={}) {
  assertMysql();
  const values=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
  const ids=normalizeOrderIds(values.order_ids);
  const action=String(values.bulk_action||'').trim();
  const key=requestKey(values.request_key);
  if(action==='delete')throw new ConflictError('Order deletion is disabled pending an approved data-retention policy.');
  if(action.startsWith('courier:'))throw new ConflictError('Courier booking is not performed by this admin action. Use an approved provider workflow.');
  const target=safeTargetStatus(action);
  const reason=requireString(values.reason||'Admin bulk status update','transition reason',{min:3,max:255});
  const actorData=actorFields(actor);
  const out=await executeIdempotent({scope:'admin.order.bulk-status',idempotencyKey:key,payload:{ids,target,reason},workFn:async(tx)=>{
    const results=[];
    for(const id of ids)results.push(await phase08.transitionOrderTx(tx,id,target,reason,actorData,`${key.slice(0,110)}:${id}`));
    return {ids,target,results};
  }});
  return out.response;
}

module.exports={SAFE_ADMIN_STATUSES,EDITABLE_STATUSES,normalizeOrderQty,recalculateTotals,addOrderItem,updateOrderItem,updateAdminOrder,transitionOrder,bulkOrderAction,normalizeOrderIds};
