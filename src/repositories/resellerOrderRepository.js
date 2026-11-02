'use strict';

const crypto=require('node:crypto');
const mysql=require('../db/mysqlPool');
const {env}=require('../config/env');
const {requirePositiveInt,requireString,normalizeBdPhone}=require('../utils/validator');
const {bdtToPaisa}=require('../utils/money');
const {ValidationError,ConflictError,NotFoundError}=require('../utils/errors');
const lifecycle=require('./phase08Repository');

function assertMysql(){if(env.db.client!=='mysql')throw new Error('Reseller orders require MySQL.');}
function safeText(value,label,max=255,required=false){return requireString(String(value??''),label,{min:required?1:0,max});}
async function create(input,{resellerId,shippingPaisa,ip='',pool}={}){
  assertMysql();
  const rid=requirePositiveInt(resellerId,'reseller ID'),productId=requirePositiveInt(input.product_id,'product ID'),qty=requirePositiveInt(input.qty,'quantity',{max:99});
  const name=safeText(input.customer_name,'customer name',191,true),phone=normalizeBdPhone(input.phone),address=safeText(input.address,'delivery address',2000,true),area=String(input.shipping_area||'');
  if(!['ঢাকার ভিতরে','ঢাকার বাইরে'].includes(area))throw new ValidationError('Select a valid delivery area.');
  const note=safeText(input.note||'','note',1000),sell=bdtToPaisa(input.selling_unit_price),ship=Number(shippingPaisa);
  if(!Number.isSafeInteger(ship)||ship<0)throw new ValidationError('Shipping charge is invalid.');
  const idempotency=requireString(input.request_key,'request key',{min:24,max:100});
  const digest=crypto.createHash('sha256').update(JSON.stringify({rid,productId,qty,name,phone,address,area,sell,ship,note})).digest('hex');
  try{return await mysql.withTransaction(async tx=>{
    const prior=await tx.queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=? FOR UPDATE',[idempotency]);
    if(prior){if(prior.checkout_request_hash!==digest)throw new ConflictError('This request key was already used for different order details.');return{id:Number(prior.id),invoice:prior.invoice_no,replayed:true};}
    const reseller=await tx.queryOne('SELECT id,verified,status FROM resellers WHERE id=? FOR UPDATE',[rid]);
    if(!reseller||Number(reseller.status)!==1)throw new NotFoundError('Reseller account not found.');
    if(Number(reseller.verified)!==1)throw new ConflictError('Reseller verification is required before creating orders.');
    const product=await tx.queryOne("SELECT id,sku,name_bn,name_en,image_url,vendor_id,regular_price_paisa,sale_price_paisa,wholesale_price_paisa,wholesale_min_qty,is_wholesale,vendor_stock_on_hand,vendor_stock_reserved,stock_on_hand,stock_reserved,status,is_archived,approval_status FROM products WHERE id=? FOR UPDATE",[productId]);
    if(!product||Number(product.status)!==1||Number(product.is_archived)||product.approval_status!=='approved')throw new ConflictError('Selected product is unavailable.');
    const variants=await tx.queryOne('SELECT id FROM product_variants WHERE product_id=? AND status=1 LIMIT 1',[productId]);
    if(variants)throw new ConflictError('Please select an explicit product variant before placing this reseller order.');
    const poolName=product.vendor_id?'vendor':'warehouse',hand=Number(product[product.vendor_id?'vendor_stock_on_hand':'stock_on_hand']),held=Number(product[product.vendor_id?'vendor_stock_reserved':'stock_reserved']);
    if(!Number.isSafeInteger(hand)||!Number.isSafeInteger(held)||hand-held<qty)throw new ConflictError('Insufficient available stock.');
    const retail=Number(product.sale_price_paisa)>0?Number(product.sale_price_paisa):Number(product.regular_price_paisa);
    const wholesale=Number(product.wholesale_price_paisa)>0?Number(product.wholesale_price_paisa):Math.floor(retail*85/100);
    if(!Number.isSafeInteger(sell)||sell<wholesale||sell>90000000000000)throw new ValidationError('Selling price must be at least the authoritative wholesale cost.');
    const subtotal=sell*qty,margin=(sell-wholesale)*qty,total=subtotal+ship;
    if(![subtotal,margin,total].every(Number.isSafeInteger))throw new ValidationError('Order total exceeds the supported calculation range.');
    const invoice=`RS-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    const order=await tx.execute("INSERT INTO orders(invoice_no,idempotency_key,checkout_request_hash,reseller_id,customer_name,customer_phone,shipping_address,shipping_zone,subtotal_paisa,shipping_paisa,total_paisa,cod_due_paisa,reseller_margin_paisa,payment_method,payment_status,order_status,order_channel,traffic_source,customer_note,client_ip) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'cod','unpaid','pending','reseller','reseller',?,?)",[invoice,idempotency,digest,rid,name,phone,address,area,subtotal,ship,total,total,margin,note||null,String(ip||'').slice(0,64)]);
    await tx.execute('INSERT INTO order_items(order_id,product_id,variant_id,vendor_id,product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label,color_label) VALUES(?,?,NULL,?,?,?,?,?,?,?,?)',[order.insertId,productId,product.vendor_id||null,product.name_bn||product.name_en||product.sku,product.image_url||'',sell,qty,subtotal,'','']);
    await tx.execute("INSERT INTO order_status_history(order_id,from_status,to_status,note,changed_by_user_id) VALUES(?,'','pending','Reseller order submitted',NULL)",[order.insertId]);
    await lifecycle.reserveOrderInventoryTx(tx,Number(order.insertId),{type:'reseller',id:rid});
    await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address) VALUES('reseller',?,'reseller.order.created','order',?,'{}',?,?)",[rid,String(order.insertId),JSON.stringify({invoice,productId,qty,totalPaisa:total,marginPaisa:margin}),String(ip||'').slice(0,64)]);
    return{id:Number(order.insertId),invoice,replayed:false};
  },{pool,isolationLevel:'REPEATABLE READ'});}catch(error){if(error.code==='DB_DUPLICATE_ENTRY'){const row=await mysql.createQueryClient(pool||mysql.getPool()).queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=?',[idempotency]);if(row){if(row.checkout_request_hash!==digest)throw new ConflictError('This request key was already used for different order details.');return{id:Number(row.id),invoice:row.invoice_no,replayed:true};}}throw error;}
}
module.exports={create};
