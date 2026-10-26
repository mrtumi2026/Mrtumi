'use strict';

const crypto=require('crypto');
const mysql=require('../db/mysqlPool');
const {env}=require('../config/env');
const {normalizeBdPhone,requirePositiveInt,requireString}=require('../utils/validator');
const {ValidationError,ConflictError,NotFoundError}=require('../utils/errors');
const lifecycle=require('./phase08Repository');

function localizedText(locale,bnValue,enValue,fallback=''){
  const en=String(enValue||'').trim(),bn=String(bnValue||'').trim();
  if(locale==='en')return en||bn||fallback;
  return bn||en||fallback;
}
function assertMysql(){if(env.db.client!=='mysql')throw new Error('Canonical checkout requires MySQL/InnoDB.');}
function client(){assertMysql();return mysql.createQueryClient(mysql.getPool());}
function asSafeInteger(value,label){const n=Number(value||0);if(!Number.isSafeInteger(n)||n<0)throw new ValidationError(`${label} is outside the supported integer range.`);return n;}
function lineCanonical(line){return{product_id:line.productId,variant_id:line.variantId,qty:line.qty};}
function unitPrice(product,variant,qty){
  const retail=Number(product.sale_price_paisa)>0?Number(product.sale_price_paisa):Number(product.regular_price_paisa);
  const min=Number(product.wholesale_min_qty||0),wholesale=Number(product.wholesale_price_paisa||0);
  if(Number(product.is_wholesale)===1&&product.approval_status==='approved'&&min>=2&&qty>=min&&wholesale>0&&wholesale<retail)return wholesale;
  return variant&&Number(variant.price_paisa)>0?Number(variant.price_paisa):retail;
}
function normalizeLines(cart){
  if(!Array.isArray(cart)||cart.length<1||cart.length>100)throw new ValidationError('Your cart is empty or contains too many items.');
  const map=new Map();
  for(const item of cart){
    const productId=requirePositiveInt(item.product_id??item.productId??item.id,'product ID');
    const variantId=item.variant_id||item.variantId?requirePositiveInt(item.variant_id??item.variantId,'variant ID'):null;
    const qty=requirePositiveInt(item.qty??item.quantity,'quantity',{max:99});
    const k=`${productId}:${variantId||0}`;const prior=map.get(k);
    const next=(prior?.qty||0)+qty;if(next>99)throw new ValidationError('Per-item quantity cannot exceed 99.');
    map.set(k,{productId,variantId,qty:next});
  }
  const lines=[...map.values()].sort((a,b)=>a.productId-b.productId||(a.variantId||0)-(b.variantId||0));
  if(new Set(lines.map(x=>x.productId)).size!==lines.length)throw new ConflictError('This checkout currently supports one variant per product; consolidate the cart before ordering.');
  return lines;
}
async function loadLines(tx,lines,locale='bn',lock=true){
  const products=await tx.queryAll(`SELECT id,sku,name_bn,name_en,image_url,regular_price_paisa,sale_price_paisa,wholesale_price_paisa,wholesale_min_qty,is_wholesale,approval_status,vendor_id,stock_on_hand,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,status,is_archived FROM products WHERE id IN (${lines.map(()=>'?').join(',')}) ORDER BY id ${lock?'FOR UPDATE':''}`,lines.map(x=>x.productId));
  const productMap=new Map(products.map(p=>[Number(p.id),p]));
  const variantIds=lines.filter(x=>x.variantId).map(x=>x.variantId);
  const variants=variantIds.length?await tx.queryAll(`SELECT id,product_id,variant_sku,size_label,color_label,price_paisa,stock_on_hand,stock_reserved,status FROM product_variants WHERE id IN (${variantIds.map(()=>'?').join(',')}) ORDER BY id ${lock?'FOR UPDATE':''}`,variantIds):[];
  const variantMap=new Map(variants.map(v=>[Number(v.id),v]));
  const result=[];
  for(const line of lines){
    const p=productMap.get(line.productId);if(!p||Number(p.status)!==1||Number(p.is_archived)===1||p.approval_status!=='approved')throw new ConflictError(`Product ${line.productId} is unavailable.`);
    const v=line.variantId?variantMap.get(line.variantId):null;
    if(line.variantId&&(!v||Number(v.product_id)!==line.productId||Number(v.status)!==1))throw new ConflictError(`Variant ${line.variantId} is unavailable.`);
    if(v&&p.vendor_id)throw new ConflictError('Vendor product variants are not supported by the current reservation model.');
    const price=asSafeInteger(unitPrice(p,v,line.qty),'Unit price');if(price<1)throw new ConflictError(`Product ${line.productId} has no valid sale price.`);
    const pool=p.vendor_id?'vendor':'warehouse';
    const hand=Number(v?v.stock_on_hand:p[pool==='vendor'?'vendor_stock_on_hand':'stock_on_hand']);
    const held=Number(v?v.stock_reserved:p[pool==='vendor'?'vendor_stock_reserved':'stock_reserved']);
    if(!Number.isSafeInteger(hand)||!Number.isSafeInteger(held)||hand-held<line.qty)throw new ConflictError(`Insufficient available stock for product ${line.productId}.`);
    if(v && Number(p.stock_on_hand)-Number(p.stock_reserved)<line.qty)throw new ConflictError(`Aggregate stock is inconsistent for product ${line.productId}; checkout is blocked.`);
    const lineTotalPaisa=price*line.qty;if(!Number.isSafeInteger(lineTotalPaisa))throw new ValidationError('Order line total exceeds the safe calculation range.');
    result.push({...line,product:p,variant:v,unitPricePaisa:price,lineTotalPaisa,name:localizedText(locale,p.name_bn,p.name_en,p.sku),image:String(p.image_url||''),size:String(v?.size_label||''),color:String(v?.color_label||'')});
  }
  return result;
}
async function quoteCart(cart,{locale='bn'}={}){
  assertMysql();const lines=normalizeLines(cart);const tx=client();const loaded=await loadLines(tx,lines,locale,false);
  return{items:loaded.map(x=>({product_id:x.productId,variant_id:x.variantId,qty:x.qty,name:x.name,image:x.image,price_paisa:x.unitPricePaisa,price:x.unitPricePaisa/100,size:x.size,color:x.color})),subtotalPaisa:loaded.reduce((s,x)=>s+x.lineTotalPaisa,0),count:loaded.reduce((s,x)=>s+x.qty,0)};
}
async function listDeliveryLocations(){
  assertMysql();return client().queryAll('SELECT id,division,district,upazila,delivery_charge_paisa FROM delivery_locations WHERE status=1 ORDER BY division,district,upazila,id');
}
async function listCheckoutMethods(){
  assertMysql();return client().queryAll("SELECT code,name,instructions FROM payment_gateways WHERE code='cod' AND status=1 ORDER BY id");
}
function couponAmount(row,subtotal){
  if(!row)return{amount:0,code:''};
  if(Number(row.status)!==1||row.expires_at&&new Date(row.expires_at).getTime()<=Date.now()||row.usage_limit!=null&&Number(row.used_count)>=Number(row.usage_limit)||subtotal<Number(row.min_purchase_paisa||0))throw new ValidationError('Coupon is invalid, expired, exhausted, or below its minimum order amount.');
  const val=asSafeInteger(row.discount_value,'Coupon value');let amount;
  if(row.discount_type==='percent'){if(val>100)throw new ValidationError('Coupon percentage is invalid.');amount=Number((BigInt(subtotal)*BigInt(val))/100n);}
  else if(row.discount_type==='fixed')amount=val;
  else throw new ValidationError('This coupon type is not supported at checkout.');
  if(row.max_discount_paisa!=null)amount=Math.min(amount,asSafeInteger(row.max_discount_paisa,'Coupon maximum discount'));
  return{amount:Math.min(subtotal,amount),code:String(row.code)};
}
async function validateCoupon(code,cart,{locale='bn'}={}){
  assertMysql();const clean=String(code||'').trim().toUpperCase();if(!clean)throw new ValidationError('Enter a coupon code.');
  const quote=await quoteCart(cart,{locale});const row=await client().queryOne('SELECT code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status FROM coupons WHERE UPPER(code)=? LIMIT 1',[clean]);
  return{...couponAmount(row,quote.subtotalPaisa),subtotalPaisa:quote.subtotalPaisa};
}
async function createOrder(input,options={}){
  const {locale='bn',sessionCustomer=null,ip='',requestKey,cart,incompleteOrderId=null,sessionSid='',deadlockRetry=0}=options;
  assertMysql();const name=requireString(input.customer_name,'customer name',{min:2,max:191});const phone=normalizeBdPhone(input.phone);const address=requireString(input.address,'shipping address',{min:5,max:2000});const zoneId=requirePositiveInt(input.delivery_location_id,'delivery location');const note=String(input.note||'').trim().slice(0,1000);
  const paymentMethod=String(input.payment_method||'cod').trim().toLowerCase();if(paymentMethod!=='cod')throw new ConflictError('Only cash on delivery is currently available; online/manual payment is not configured for canonical checkout.');
  const recoveryId=incompleteOrderId?requirePositiveInt(incompleteOrderId,'incomplete order ID'):null;
  const key=requireString(recoveryId?`incomplete:${recoveryId}`:requestKey,'checkout request key',{min:8,max:100});const lines=normalizeLines(cart);
  const payloadHash=crypto.createHash('sha256').update(JSON.stringify({name,phone,address,zoneId,note,paymentMethod,lines:lines.map(lineCanonical),coupon:String(input.coupon_code||'').trim().toUpperCase(),recoveryId})).digest('hex');
  try {
  return await mysql.withTransaction(async tx=>{
    const replay=await tx.queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=?',[key]);
    if(replay){if(replay.checkout_request_hash!==payloadHash)throw new ConflictError('This checkout request key was already used with different order details.');return{id:Number(replay.id),invoiceNo:replay.invoice_no,replayed:true};}
    const cod=await tx.queryOne("SELECT code FROM payment_gateways WHERE code='cod' AND status=1 FOR UPDATE");
    if(!cod)throw new ConflictError('Cash-on-delivery is not enabled in the configured payment methods.');
    const zone=await tx.queryOne('SELECT id,division,district,upazila,delivery_charge_paisa FROM delivery_locations WHERE id=? AND status=1 FOR UPDATE',[zoneId]);
    if(!zone)throw new ValidationError('Select an active, configured delivery location.');
    let recovery=null;
    if(recoveryId){
      const sessionHash=crypto.createHmac('sha256',env.sessionSecret).update(String(sessionSid||'')).digest('hex');
      recovery=await tx.queryOne('SELECT id,status,phone,session_sid,consent_given,consent_withdrawn_at FROM incomplete_orders WHERE id=? FOR UPDATE',[recoveryId]);
      if(!recovery||recovery.session_sid!==sessionHash||Number(recovery.consent_given)!==1||recovery.consent_withdrawn_at||!['abandoned','contacted','recovery_started'].includes(recovery.status)||recovery.phone!==phone)throw new ConflictError('This consented recovery record is not available for this session and phone.');
    }
    const items=await loadLines(tx,lines,locale,true);
    const subtotal=items.reduce((s,x)=>s+x.lineTotalPaisa,0);if(!Number.isSafeInteger(subtotal))throw new ValidationError('Order subtotal exceeds the safe calculation range.');
    const shipping=asSafeInteger(zone.delivery_charge_paisa,'Delivery charge');
    let coupon={amount:0,code:''};const couponCode=String(input.coupon_code||'').trim().toUpperCase();
    if(couponCode){const row=await tx.queryOne('SELECT code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status FROM coupons WHERE UPPER(code)=? FOR UPDATE',[couponCode]);coupon=couponAmount(row,subtotal);}
    const total=subtotal+shipping-coupon.amount;if(!Number.isSafeInteger(total)||total<0)throw new ValidationError('Order total is invalid.');
    const settingsRows=await tx.queryAll("SELECT setting_key,setting_value FROM settings WHERE setting_key IN ('otp_mode','advance_payment_mode','advance_payment_value','advance_min_order_paisa','advance_max_order_paisa')");
    const settings=Object.fromEntries(settingsRows.map(x=>[x.setting_key,x.setting_value]));
    if(settings.otp_mode==='on')throw new ConflictError('Order verification is enabled, but no verified OTP delivery/checkout verification route is configured; checkout is paused rather than bypassing OTP.');
    const policy=lifecycle.validateAdvancePolicy({mode:settings.advance_payment_mode||'off',value:Number(settings.advance_payment_value||0),minimumPaisa:settings.advance_min_order_paisa||0,maximumPaisa:settings.advance_max_order_paisa||null});
    const advance=lifecycle.calculateAdvance(total,policy);
    if(advance>0)throw new ConflictError('An advance is required by the current policy, but no verified payment provider is configured; checkout is paused rather than marking an unconfirmed payment paid.');
    let customerId=null;
    if(sessionCustomer?.id){const customer=await tx.queryOne('SELECT id,phone,status,is_blocked FROM customers WHERE id=? FOR UPDATE',[requirePositiveInt(sessionCustomer.id,'customer ID')]);if(!customer||Number(customer.status)!==1||Number(customer.is_blocked)===1||normalizeBdPhone(customer.phone)!==phone)throw new ConflictError('Sign in with an account matching the delivery phone, or continue as a guest.');customerId=Number(customer.id);}
    const invoice=`MT-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    const zoneLabel=[zone.division,zone.district,zone.upazila].filter(Boolean).join(' / ');
    const order=await tx.execute(`INSERT INTO orders (invoice_no,idempotency_key,checkout_request_hash,customer_id,customer_name,customer_phone,shipping_address,division,district,upazila,shipping_zone,subtotal_paisa,discount_paisa,shipping_paisa,total_paisa,advance_required_paisa,paid_paisa,cod_due_paisa,coupon_code,payment_method,payment_status,order_status,order_channel,traffic_source,client_ip,customer_note,consent_accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,[invoice,key,payloadHash,customerId,name,phone,address,zone.division,zone.district,zone.upazila,zoneLabel,subtotal,coupon.amount,shipping,total,0,0,total,coupon.code,'cod','unpaid','pending','storefront','Direct',String(ip||'').slice(0,64),note||null]);
    for(const item of items){await tx.execute('INSERT INTO order_items (order_id,product_id,variant_id,vendor_id,product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label,color_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[order.insertId,item.productId,item.variantId,item.product.vendor_id||null,item.name,item.image,item.unitPricePaisa,item.qty,item.lineTotalPaisa,item.size,item.color]);}
    await tx.execute("INSERT INTO order_status_history (order_id,from_status,to_status,note,changed_by_user_id) VALUES (?,'','pending','Customer checkout submitted',NULL)",[order.insertId]);
    // Reserve only after the durable order and lines exist, in this same transaction.
    await lifecycle.reserveOrderInventoryTx(tx,Number(order.insertId),{type:'system'});
    if(coupon.code)await tx.execute('UPDATE coupons SET used_count=used_count+1 WHERE code=?',[coupon.code]);
    if(customerId)await tx.execute('UPDATE customers SET total_orders=total_orders+1,address=? WHERE id=?',[address,customerId]);
    if(recovery){
      await tx.execute("UPDATE incomplete_orders SET status='recovered',recovered_order_id=? WHERE id=? AND consent_withdrawn_at IS NULL",[order.insertId,recoveryId]);
      await tx.execute("INSERT INTO incomplete_order_history (incomplete_order_id,from_status,to_status,reason) VALUES (?,?,'recovered','Customer placed order through the same consented checkout session')",[recoveryId,recovery.status]);
      await tx.execute("INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES ('customer',NULL,'checkout.recovery.recovered','incomplete_order',?,?,?,?,'')",[String(recoveryId),JSON.stringify({status:recovery.status}),JSON.stringify({status:'recovered',orderId:Number(order.insertId)}),String(ip||'').slice(0,64)]);
    }
    await tx.execute(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES ('system',NULL,'checkout.order.created','order',?,NULL,?,?, '')`,[String(order.insertId),JSON.stringify({invoiceNo:invoice,totalPaisa:total,status:'pending',paymentStatus:'unpaid',reservation:'active'}),String(ip||'').slice(0,64)]);
    return{id:Number(order.insertId),invoiceNo:invoice,replayed:false,totalPaisa:total,paidPaisa:0,codDuePaisa:total};
  });
  } catch(err) {
    if(err.code==='DB_DUPLICATE_ENTRY'||err.mysqlCode==='ER_LOCK_DEADLOCK'){
      const replay=await client().queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=?',[key]);
      if(replay){if(replay.checkout_request_hash!==payloadHash)throw new ConflictError('This checkout request key was already used with different order details.');return{id:Number(replay.id),invoiceNo:replay.invoice_no,replayed:true};}
      if(err.mysqlCode==='ER_LOCK_DEADLOCK'&&deadlockRetry<1)return createOrder(input,{...options,deadlockRetry:deadlockRetry+1});
    }
    throw err;
  }
}
async function getOrderForSuccess(invoiceNo){
  assertMysql();const db=client();const order=await db.queryOne('SELECT id,invoice_no,customer_name,total_paisa,paid_paisa,cod_due_paisa,order_status,payment_status,created_at FROM orders WHERE invoice_no=?',[requireString(invoiceNo,'invoice number',{min:8,max:40})]);
  if(!order)return null;const items=await db.queryAll('SELECT product_name,qty,unit_price_paisa,line_total_paisa,size_label,color_label FROM order_items WHERE order_id=? ORDER BY id',[order.id]);return{order,items};
}
module.exports={normalizeLines,unitPrice,quoteCart,listDeliveryLocations,listCheckoutMethods,validateCoupon,createOrder,getOrderForSuccess};
