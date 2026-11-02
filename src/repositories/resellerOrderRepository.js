'use strict';

const crypto=require('node:crypto');
const mysql=require('../db/mysqlPool');
const {env}=require('../config/env');
const {requirePositiveInt,requireString,normalizeBdPhone}=require('../utils/validator');
const {bdtToPaisa}=require('../utils/money');
const {ValidationError,ConflictError,NotFoundError}=require('../utils/errors');
const lifecycle=require('./phase08Repository');
const { MODES, calculateResellerPricing } = require('../services/resellerPricing');

function assertMysql(){if(env.db.client!=='mysql')throw new Error('Reseller orders require MySQL.');}
function safeText(value,label,max=255,required=false){return requireString(String(value??''),label,{min:required?1:0,max});}
async function create(input,{resellerId,shippingPaisa,ip='',pool}={}){
  assertMysql();
  const rid=requirePositiveInt(resellerId,'reseller ID'),productId=requirePositiveInt(input.product_id,'product ID'),qty=requirePositiveInt(input.qty,'quantity',{max:99});
  const name=safeText(input.customer_name,'customer name',191,true),phone=normalizeBdPhone(input.phone),address=safeText(input.address,'delivery address',2000,true),area=String(input.shipping_area||'');
  if(!['ঢাকার ভিতরে','ঢাকার বাইরে'].includes(area))throw new ValidationError('Select a valid delivery area.');
  const note=safeText(input.note||'','note',1000),mode=String(input.pricing_mode||'');
  const sell=mode===MODES.RESELLER?bdtToPaisa(input.selling_unit_price):null,ship=Number(shippingPaisa);
  if(!Object.values(MODES).includes(mode))throw new ValidationError('Select a valid reseller pricing mode.');
  if(!Number.isSafeInteger(ship)||ship<0)throw new ValidationError('Shipping charge is invalid.');
  const idempotency=requireString(input.request_key,'request key',{min:24,max:100});
  const digest=crypto.createHash('sha256').update(JSON.stringify({rid,productId,qty,mode,sell,name,phone,address,area,ship,note})).digest('hex');
  try{return await mysql.withTransaction(async tx=>{
    const prior=await tx.queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=? FOR UPDATE',[idempotency]);
    if(prior){if(prior.checkout_request_hash!==digest)throw new ConflictError('This request key was already used for different order details.');return{id:Number(prior.id),invoice:prior.invoice_no,replayed:true};}
    const reseller=await tx.queryOne('SELECT id,verified,status,shop_name,logo_url,branding_status FROM resellers WHERE id=? FOR UPDATE',[rid]);
    if(!reseller||Number(reseller.status)!==1)throw new NotFoundError('Reseller account not found.');
    if(Number(reseller.verified)!==1)throw new ConflictError('Reseller verification is required before creating orders.');
    const product=await tx.queryOne("SELECT id,sku,name_bn,name_en,image_url,vendor_id,regular_price_paisa,sale_price_paisa,wholesale_price_paisa,wholesale_min_qty,is_wholesale,vendor_stock_on_hand,vendor_stock_reserved,stock_on_hand,stock_reserved,status,is_archived,approval_status FROM products WHERE id=? FOR UPDATE",[productId]);
    if(!product||Number(product.status)!==1||Number(product.is_archived)||product.approval_status!=='approved')throw new ConflictError('Selected product is unavailable.');
    if(product.vendor_id){const owner=await tx.queryOne('SELECT id,status,lifecycle_status FROM vendors WHERE id=? FOR UPDATE',[product.vendor_id]);if(!owner||Number(owner.status)!==1||owner.lifecycle_status!=='active')throw new ConflictError('Selected product is unavailable.');}
    const variants=await tx.queryOne('SELECT id FROM product_variants WHERE product_id=? AND status=1 LIMIT 1',[productId]);
    if(variants)throw new ConflictError('Please select an explicit product variant before placing this reseller order.');
    const poolName=product.vendor_id?'vendor':'warehouse',hand=Number(product[product.vendor_id?'vendor_stock_on_hand':'stock_on_hand']),held=Number(product[product.vendor_id?'vendor_stock_reserved':'stock_reserved']);
    if(!Number.isSafeInteger(hand)||!Number.isSafeInteger(held)||hand-held<qty)throw new ConflictError('Insufficient available stock.');
    const settings=await tx.queryOne('SELECT * FROM reseller_commerce_settings WHERE id=1 FOR UPDATE');
    const eligibility=await tx.queryOne('SELECT * FROM reseller_product_eligibility WHERE product_id=? FOR UPDATE',[productId]);
    if(!settings||!eligibility)throw new ConflictError('Reseller pricing is not configured for this product.');
    const modeAllowed=mode===MODES.RESELLER?Number(settings.reseller_price_mode_enabled)===1&&Number(eligibility.reseller_price_mode_enabled)===1:mode===MODES.OFFICIAL?Number(settings.official_price_mode_enabled)===1&&Number(eligibility.official_price_mode_enabled)===1:false;
    if(!modeAllowed)throw new ConflictError('Selected reseller pricing mode is not enabled for this product.');
    const retail=Number(product.sale_price_paisa)>0?Number(product.sale_price_paisa):Number(product.regular_price_paisa);
    const vendorEntitlement=eligibility.vendor_entitlement_paisa==null?null:Number(eligibility.vendor_entitlement_paisa);
    if(vendorEntitlement==null)throw new ConflictError('Vendor entitlement must be explicitly configured for this product.');
    const selling=mode===MODES.RESELLER?sell:null;
    const feeBase=selling===null?retail:selling;
    const feeUnit=String(settings.platform_fee_type||'fixed')==='percent'
      ? Number((BigInt(feeBase)*BigInt(settings.platform_fee_bps||0))/10000n)
      : Number(settings.platform_fee_paisa);
    const pricing=calculateResellerPricing({mode,quantity:qty,officialUnitPricePaisa:retail,resellerSellingUnitPaisa:selling,vendorEntitlementUnitPaisa:vendorEntitlement,platformFeeUnitPaisa:feeUnit,resellerCommissionBps:Number(settings.official_commission_bps),minimumSellingUnitPaisa:eligibility.minimum_price_paisa??settings.minimum_price_paisa,maximumSellingUnitPaisa:eligibility.maximum_price_paisa??settings.maximum_price_paisa});
    const subtotal=pricing.productAmountPaisa,total=subtotal+ship,margin=pricing.resellerEarningPaisa;
    if(![subtotal,total,margin].every(Number.isSafeInteger))throw new ValidationError('Order total exceeds the supported calculation range.');
    const invoice=`RS-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    const brandApproved=reseller.branding_status==='approved';
    const order=await tx.execute("INSERT INTO orders(invoice_no,idempotency_key,checkout_request_hash,reseller_id,reseller_pricing_mode,reseller_store_name_snapshot,reseller_logo_snapshot,customer_name,customer_phone,shipping_address,shipping_zone,subtotal_paisa,shipping_paisa,total_paisa,cod_due_paisa,reseller_margin_paisa,payment_method,payment_status,order_status,order_channel,traffic_source,customer_note,client_ip) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'cod','unpaid','pending','reseller','reseller',?,?)",[invoice,idempotency,digest,rid,mode,brandApproved?reseller.shop_name:'',brandApproved?reseller.logo_url:'',name,phone,address,area,subtotal,ship,total,total,margin,note||null,String(ip||'').slice(0,64)]);
    const item=await tx.execute('INSERT INTO order_items(order_id,product_id,variant_id,vendor_id,product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label,color_label) VALUES(?,?,NULL,?,?,?,?,?,?,?,?)',[order.insertId,productId,product.vendor_id||null,product.name_bn||product.name_en||product.sku,product.image_url||'',pricing.customerUnitPricePaisa,qty,subtotal,'','']);
    await tx.execute('INSERT INTO reseller_order_price_snapshots(order_item_id,pricing_mode,quantity,official_unit_price_paisa,customer_unit_price_paisa,vendor_entitlement_unit_paisa,platform_fee_unit_paisa,reseller_commission_unit_paisa,reseller_earning_paisa,platform_revenue_paisa,adjustment_paisa,snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[item.insertId,mode,qty,retail,pricing.customerUnitPricePaisa,vendorEntitlement,feeUnit,pricing.resellerCommissionPaisa,pricing.resellerEarningPaisa,pricing.platformRevenuePaisa,0,JSON.stringify(pricing)]);
    await tx.execute('INSERT INTO order_price_snapshots(order_item_id,vendor_id,reseller_id,quantity,customer_unit_price_paisa,vendor_entitlement_unit_paisa,reseller_margin_unit_paisa,marketplace_revenue_unit_paisa) VALUES(?,?,?,?,?,?,?,?)',[item.insertId,product.vendor_id||null,rid,qty,pricing.customerUnitPricePaisa,vendorEntitlement,pricing.resellerEarningPaisa/qty,pricing.platformRevenuePaisa/qty]);
    if(product.vendor_id){const vendorOrderNo=`${invoice}-${product.vendor_id}`;const vendorOrder=await tx.execute('INSERT INTO vendor_sub_orders(order_id,vendor_id,vendor_order_no,status,cod_due_paisa,vendor_entitlement_paisa,marketplace_fee_paisa,net_payable_paisa) VALUES(?,?,?,\'order_placed\',?,?,?,?)',[order.insertId,product.vendor_id,vendorOrderNo,total,pricing.vendorEntitlementPaisa,pricing.platformFeePaisa,pricing.vendorEntitlementPaisa]);await tx.execute('INSERT INTO vendor_sub_order_items(vendor_sub_order_id,order_item_id,quantity) VALUES(?,?,?)',[vendorOrder.insertId,item.insertId,qty]);}
    await tx.execute("INSERT INTO order_status_history(order_id,from_status,to_status,note,changed_by_user_id) VALUES(?,'','pending','Reseller order submitted',NULL)",[order.insertId]);
    await lifecycle.reserveOrderInventoryTx(tx,Number(order.insertId),{type:'reseller',id:rid});
    await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address) VALUES('reseller',?,'reseller.order.created','order',?,'{}',?,?)",[rid,String(order.insertId),JSON.stringify({invoice,productId,qty,totalPaisa:total,pricingMode:mode}),String(ip||'').slice(0,64)]);
    return{id:Number(order.insertId),invoice,replayed:false};
  },{pool,isolationLevel:'REPEATABLE READ'});}catch(error){if(error.code==='DB_DUPLICATE_ENTRY'){const row=await mysql.createQueryClient(pool||mysql.getPool()).queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=?',[idempotency]);if(row){if(row.checkout_request_hash!==digest)throw new ConflictError('This request key was already used for different order details.');return{id:Number(row.id),invoice:row.invoice_no,replayed:true};}}throw error;}
}
async function quote({productId,mode,quantity,sellingUnitPricePaisa}={}){
  assertMysql();
  const id=requirePositiveInt(productId,'product ID'),qty=requirePositiveInt(quantity,'quantity',{max:99});
  const db= mysql.createQueryClient(mysql.getPool());
  const product=await db.queryOne("SELECT id,regular_price_paisa,sale_price_paisa,status,is_archived,approval_status FROM products WHERE id=?",[id]);
  const settings=await db.queryOne('SELECT * FROM reseller_commerce_settings WHERE id=1');
  const eligibility=await db.queryOne('SELECT * FROM reseller_product_eligibility WHERE product_id=?',[id]);
  if(!product||Number(product.status)!==1||Number(product.is_archived)||product.approval_status!=='approved'||!settings||!eligibility)throw new NotFoundError('Product is not eligible for reseller pricing.');
  const enabled=mode===MODES.RESELLER?Number(settings.reseller_price_mode_enabled)===1&&Number(eligibility.reseller_price_mode_enabled)===1:mode===MODES.OFFICIAL?Number(settings.official_price_mode_enabled)===1&&Number(eligibility.official_price_mode_enabled)===1:false;
  if(!enabled)throw new ConflictError('Selected reseller pricing mode is not enabled for this product.');
  const official=Number(product.sale_price_paisa)>0?Number(product.sale_price_paisa):Number(product.regular_price_paisa);
  const sell=mode===MODES.RESELLER?Number(sellingUnitPricePaisa):official;
  const feeUnit=String(settings.platform_fee_type||'fixed')==='percent'
    ? Number((BigInt(sell)*BigInt(settings.platform_fee_bps||0))/10000n)
    : Number(settings.platform_fee_paisa);
  const pricing=calculateResellerPricing({mode,quantity:qty,officialUnitPricePaisa:official,resellerSellingUnitPaisa:mode===MODES.RESELLER?sellingUnitPricePaisa:null,vendorEntitlementUnitPaisa:eligibility.vendor_entitlement_paisa,platformFeeUnitPaisa:feeUnit,resellerCommissionBps:Number(settings.official_commission_bps),minimumSellingUnitPaisa:eligibility.minimum_price_paisa??settings.minimum_price_paisa,maximumSellingUnitPaisa:eligibility.maximum_price_paisa??settings.maximum_price_paisa});
  return {productAmountPaisa:pricing.productAmountPaisa,resellerEarningPaisa:pricing.resellerEarningPaisa};
}
module.exports={create,quote};
