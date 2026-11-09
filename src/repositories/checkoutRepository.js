'use strict';

const crypto=require('crypto');
const mysql=require('../db/mysqlPool');
const {env}=require('../config/env');
const {normalizeBdPhone,requirePositiveInt,requireString}=require('../utils/validator');
const {ValidationError,ConflictError,NotFoundError}=require('../utils/errors');
const lifecycle=require('./phase08Repository');
const settingsRepository=require('./settingsRepository');
const {CONSENT_VERSION, EMPTY_ATTRIBUTION, normalizeAttribution}=require('../analytics/attribution');

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
    if(!item||typeof item!=='object'||Array.isArray(item))throw new ValidationError('Your cart contains an invalid item.');
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
  const vendorIds=[...new Set(products.map(p=>Number(p.vendor_id)).filter(Boolean))];
  const vendors=vendorIds.length?await tx.queryAll(`SELECT id,lifecycle_status,status,commission_rate_bps FROM vendors WHERE id IN (${vendorIds.map(()=>'?').join(',')}) ORDER BY id ${lock?'FOR UPDATE':''}`,vendorIds):[];
  const vendorMap=new Map(vendors.map(v=>[Number(v.id),v]));
  const variantIds=lines.filter(x=>x.variantId).map(x=>x.variantId);
  const variants=variantIds.length?await tx.queryAll(`SELECT id,product_id,variant_sku,size_label,color_label,price_paisa,stock_on_hand,stock_reserved,status FROM product_variants WHERE id IN (${variantIds.map(()=>'?').join(',')}) ORDER BY id ${lock?'FOR UPDATE':''}`,variantIds):[];
  const variantMap=new Map(variants.map(v=>[Number(v.id),v]));
  const result=[];
  for(const line of lines){
    const p=productMap.get(line.productId);if(!p||Number(p.status)!==1||Number(p.is_archived)===1||p.approval_status!=='approved')throw new ConflictError(`Product ${line.productId} is unavailable.`);
    if(p.vendor_id){const owner=vendorMap.get(Number(p.vendor_id));if(!owner||Number(owner.status)!==1||owner.lifecycle_status!=='active')throw new ConflictError(`Product ${line.productId} is unavailable.`);}
    const v=line.variantId?variantMap.get(line.variantId):null;
    if(line.variantId&&(!v||Number(v.product_id)!==line.productId||Number(v.status)!==1))throw new ConflictError(`Variant ${line.variantId} is unavailable.`);
    const price=asSafeInteger(unitPrice(p,v,line.qty),'Unit price');if(price<1)throw new ConflictError(`Product ${line.productId} has no valid sale price.`);
    const pool=p.vendor_id?'vendor':'warehouse';
    const hand=Number(v?v.stock_on_hand:p[pool==='vendor'?'vendor_stock_on_hand':'stock_on_hand']);
    const held=Number(v?v.stock_reserved:p[pool==='vendor'?'vendor_stock_reserved':'stock_reserved']);
    if(!Number.isSafeInteger(hand)||!Number.isSafeInteger(held)||hand-held<line.qty)throw new ConflictError(`Insufficient available stock for product ${line.productId}.`);
    const lineTotalPaisa=price*line.qty;if(!Number.isSafeInteger(lineTotalPaisa))throw new ValidationError('Order line total exceeds the safe calculation range.');
    result.push({...line,product:p,variant:v,vendorCommissionRateBps:Number(vendorMap.get(Number(p.vendor_id))?.commission_rate_bps||0),unitPricePaisa:price,lineTotalPaisa,name:localizedText(locale,p.name_bn,p.name_en,p.sku),image:String(p.image_url||''),size:String(v?.size_label||''),color:String(v?.color_label||'')});
  }
  return result;
}
async function quoteCart(cart,{locale='bn'}={}){
  assertMysql();const lines=normalizeLines(cart);const tx=client();const loaded=await loadLines(tx,lines,locale,false);
  return{items:loaded.map(x=>({product_id:x.productId,variant_id:x.variantId,qty:x.qty,name:x.name,image:x.image,price_paisa:x.unitPricePaisa,price:x.unitPricePaisa/100,size:x.size,color:x.color})),subtotalPaisa:loaded.reduce((s,x)=>s+x.lineTotalPaisa,0),count:loaded.reduce((s,x)=>s+x.qty,0)};
}
function fallbackDeliveryLocations(siteSettings={}){
  const chargePaisa=(value,fallback)=>{
    const amount=Number(value||fallback);
    return Number.isFinite(amount)&&amount>=0?Math.round(amount*100):fallback*100;
  };
  return [
    {id:1,division:'Dhaka',district:'Dhaka',upazila:'ঢাকার ভিতরে',delivery_charge_paisa:chargePaisa(siteSettings.inside_dhaka_charge,60)},
    {id:2,division:'All',district:'All',upazila:'ঢাকার বাইরে',delivery_charge_paisa:chargePaisa(siteSettings.outside_dhaka_charge,120)},
  ];
}
async function listDeliveryLocations(){
  assertMysql();
  const locations=await client().queryAll('SELECT id,division,district,upazila,delivery_charge_paisa FROM delivery_locations WHERE status=1 ORDER BY division,district,upazila,id');
  if(locations.length)return locations;
  return fallbackDeliveryLocations(await settingsRepository.getAllSettings());
}
async function listCheckoutMethods(){
  assertMysql();
  const rows = await client().queryAll("SELECT code,name,account_number,instructions,instructions_bn,gateway_type,mode FROM payment_gateways WHERE (status=1 AND is_active=1) AND (gateway_type='manual' OR code IN ('cod','bkash_api','bkash_manual','nagad_api','nagad_manual','rocket_api','rocket_manual','bkash','nagad','rocket')) ORDER BY CASE WHEN code='cod' THEN 0 ELSE 1 END,id");
  const hasBkash = rows.some(r => r.code === 'bkash' || r.code === 'bkash_manual' || r.code === 'bkash_api');
  const hasNagad = rows.some(r => r.code === 'nagad' || r.code === 'nagad_manual' || r.code === 'nagad_api');
  const hasRocket = rows.some(r => r.code === 'rocket' || r.code === 'rocket_manual' || r.code === 'rocket_api');
  if (!hasBkash) rows.push({ code: 'bkash', name: 'bKash (বিকাশ Send Money)', gateway_type: 'manual', mode: 'manual', account_number: '01711-000000', instructions: 'Send Money to our bKash number and enter TrxID below.', instructions_bn: 'আমাদের বিকাশ নম্বরে Send Money করুন এবং নিচে TrxID দিন।' });
  if (!hasNagad) rows.push({ code: 'nagad', name: 'Nagad (নগদ Send Money)', gateway_type: 'manual', mode: 'manual', account_number: '01711-000000', instructions: 'Send Money to our Nagad number and enter TrxID below.', instructions_bn: 'আমাদের নগদ নম্বরে Send Money করুন এবং নিচে TrxID দিন।' });
  if (!hasRocket) rows.push({ code: 'rocket', name: 'Rocket (রকেট Send Money)', gateway_type: 'manual', mode: 'manual', account_number: '01711-000000', instructions: 'Send Money to our Rocket number and enter TrxID below.', instructions_bn: 'আমাদের রকেট নম্বরে Send Money করুন এবং নিচে TrxID দিন।' });
  return rows;
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
  const lines=normalizeLines(cart);
  return mysql.withTransaction(async tx=>{
    const loaded=await loadLines(tx,lines,locale,false);
    const subtotalPaisa=loaded.reduce((sum,line)=>sum+line.lineTotalPaisa,0);
    if(!Number.isSafeInteger(subtotalPaisa))throw new ValidationError('Order subtotal exceeds the safe calculation range.');
    const row=await tx.queryOne('SELECT code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status FROM coupons WHERE UPPER(code)=? LIMIT 1',[clean]);
    return{...couponAmount(row,subtotalPaisa),subtotalPaisa};
  },{isolationLevel:'REPEATABLE READ'});
}
async function resolveQuickOrderVariant(productId,size,color){
  assertMysql();const id=requirePositiveInt(productId,'product ID');const selectedSize=String(size||'').trim().slice(0,191);const selectedColor=String(color||'').trim().slice(0,191);
  const variants=await client().queryAll('SELECT id,size_label,color_label,status FROM product_variants WHERE product_id=? ORDER BY id',[id]);
  if(!variants.length)return null;
  const matches=variants.filter(v=>Number(v.status)===1).filter(v=>{const vSize=String(v.size_label||'').trim(),vColor=String(v.color_label||'').trim();return(!vSize||vSize===selectedSize)&&(!vColor||vColor===selectedColor);});
  if(matches.length!==1)throw new ConflictError('The selected product size/color is no longer available. Refresh the product and choose a valid option.');
  return Number(matches[0].id);
}
async function quoteQuickOrder({productId,qty,size,color,deliveryLocationId,locale='bn'}){
  assertMysql();const variantId=await resolveQuickOrderVariant(productId,size,color);const cartQuote=await quoteCart([{product_id:productId,variant_id:variantId,qty}],{locale});
  const location=await client().queryOne('SELECT id,delivery_charge_paisa FROM delivery_locations WHERE id=? AND status=1',[requirePositiveInt(deliveryLocationId,'delivery location')]);
  if(!location)throw new ValidationError('Select an active, configured delivery location.');
  const shippingPaisa=asSafeInteger(location.delivery_charge_paisa,'Delivery charge');const totalPaisa=cartQuote.subtotalPaisa+shippingPaisa;
  if(!Number.isSafeInteger(totalPaisa))throw new ValidationError('Order total exceeds the supported calculation range.');
  return{variantId,subtotalPaisa:cartQuote.subtotalPaisa,shippingPaisa,totalPaisa,unitPricePaisa:cartQuote.items[0].price_paisa};
}
async function createOrder(input,options={}){
  const {locale='bn',sessionCustomer=null,ip='',requestKey,cart,incompleteOrderId=null,sessionSid='',analyticsConsent=false,attribution=null,clearSavedCart=true,deadlockRetry=0,campaignSlug=''}=options;
  const attributionAllowed=env.analyticsAttributionEnabled&&analyticsConsent===true;
  const attributionData=attributionAllowed?normalizeAttribution(attribution||{}):EMPTY_ATTRIBUTION;
  assertMysql();const name=requireString(input.customer_name,'customer name',{min:2,max:191});const phone=normalizeBdPhone(input.phone);const address=requireString(input.address,'shipping address',{min:5,max:2000});const zoneId=requirePositiveInt(input.delivery_location_id,'delivery location');const note=String(input.note||'').trim().slice(0,1000);
  const paymentMethod=String(input.payment_method||'cod').trim().toLowerCase();if(!/^[a-z0-9_-]{1,48}$/.test(paymentMethod))throw new ValidationError('Select a valid payment method.');
  const manualBrand=paymentMethod.replace(/^manual_/,'').replace(/_manual$/,'');
  const isManualPayment=paymentMethod!=='cod';
  if(isManualPayment&&!['bkash','nagad','rocket'].includes(manualBrand))throw new ValidationError('Choose Cash on Delivery, bKash, Nagad, or Rocket.');
  const trxId=isManualPayment?requireString(input.trx_id,'Transaction ID',{min:4,max:128}).trim():'';
  const senderNumber=isManualPayment?normalizeBdPhone(input.sender_number,'sender mobile number'):'';
  const recoveryId=incompleteOrderId?requirePositiveInt(incompleteOrderId,'incomplete order ID'):null;
  const campaignKey=campaignSlug?requireString(campaignSlug,'campaign slug',{min:1,max:191}):'';const key=requireString(recoveryId?`incomplete:${recoveryId}`:requestKey,'checkout request key',{min:8,max:100});const lines=normalizeLines(cart);if(campaignKey&&lines.length!==1)throw new ValidationError('Campaign checkout accepts exactly one campaign product.');
  const payload={name,phone,address,zoneId,note,paymentMethod,lines:lines.map(lineCanonical),coupon:String(input.coupon_code||'').trim().toUpperCase(),recoveryId,campaignSlug:campaignKey};
  if(isManualPayment){payload.trxId=trxId;payload.senderNumber=senderNumber;}
  const payloadHash=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  try {
  return await mysql.withTransaction(async tx=>{
    const replay=await tx.queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=?',[key]);
    if(replay){if(replay.checkout_request_hash!==payloadHash)throw new ConflictError('This checkout request key was already used with different order details.');return{id:Number(replay.id),invoiceNo:replay.invoice_no,replayed:true};}
    const blocked=await tx.queryOne('SELECT id FROM ip_blocks WHERE status=1 AND ip_or_phone IN (?,?) LIMIT 1 FOR UPDATE',[phone,String(ip||'').slice(0,64)]);
    if(blocked)throw new ConflictError('This phone number or IP address is blocked from placing orders.');
    const gateway=await tx.queryOne("SELECT code,gateway_type,mode FROM payment_gateways WHERE (code=? OR code=REPLACE(?,'_manual','') OR code=CONCAT(?,'_manual')) AND (status=1 AND is_active=1) LIMIT 1 FOR UPDATE",[paymentMethod,paymentMethod,paymentMethod]);
    if(!gateway || (isManualPayment && !['bkash','nagad','rocket'].includes(manualBrand)))throw new ConflictError('This payment method is not active or is not supported at checkout.');
    const zone=await tx.queryOne('SELECT id,division,district,upazila,delivery_charge_paisa FROM delivery_locations WHERE id=? AND status=1 FOR UPDATE',[zoneId]);
    if(!zone)throw new ValidationError('Select an active, configured delivery location.');
    let recovery=null;
    if(recoveryId){
      const sessionHash=crypto.createHmac('sha256',env.sessionSecret).update(String(sessionSid||'')).digest('hex');
      recovery=await tx.queryOne('SELECT id,status,phone,session_sid,consent_given,consent_withdrawn_at FROM incomplete_orders WHERE id=? FOR UPDATE',[recoveryId]);
      if(!recovery||recovery.session_sid!==sessionHash||Number(recovery.consent_given)!==1||recovery.consent_withdrawn_at||!['abandoned','contacted','recovery_started'].includes(recovery.status)||recovery.phone!==phone)throw new ConflictError('This consented recovery record is not available for this session and phone.');
    }
    let campaign=null;
    if(campaignKey){
      campaign=await tx.queryOne("SELECT id,slug,title,product_id,offer_price_paisa,publish_state,status FROM campaigns WHERE slug=? FOR UPDATE",[campaignKey]);
      if(!campaign||Number(campaign.status)!==1||campaign.publish_state!=='published')throw new ConflictError('This campaign is not active.');
      if(Number(campaign.product_id)!==lines[0].productId)throw new ConflictError('The campaign product changed; reload the campaign and try again.');
    }
    const items=await loadLines(tx,lines,locale,true);
    if(campaign){const offer=asSafeInteger(campaign.offer_price_paisa,'Campaign offer price');if(offer<1)throw new ConflictError('This campaign has no valid offer price.');items[0].unitPricePaisa=offer;items[0].lineTotalPaisa=offer*items[0].qty;if(!Number.isSafeInteger(items[0].lineTotalPaisa))throw new ValidationError('Campaign line total exceeds the safe calculation range.');}
    const subtotal=items.reduce((s,x)=>s+x.lineTotalPaisa,0);if(!Number.isSafeInteger(subtotal))throw new ValidationError('Order subtotal exceeds the safe calculation range.');
    const shipping=asSafeInteger(zone.delivery_charge_paisa,'Delivery charge');
    let coupon={amount:0,code:''};const couponCode=String(input.coupon_code||'').trim().toUpperCase();
    if(couponCode){const row=await tx.queryOne('SELECT code,discount_type,discount_value,min_purchase_paisa,max_discount_paisa,usage_limit,used_count,expires_at,status FROM coupons WHERE UPPER(code)=? FOR UPDATE',[couponCode]);coupon=couponAmount(row,subtotal);}
    const total=subtotal+shipping-coupon.amount;if(!Number.isSafeInteger(total)||total<0)throw new ValidationError('Order total is invalid.');
    // Resolve the session customer before the OTP policy check: the verified-phone bypass
    // needs the customer id, and referencing it before its declaration used to throw a
    // temporal-dead-zone ReferenceError (surfaced as DB_QUERY_FAILED) whenever OTP was on.
    const sessionCustomerId=sessionCustomer?.id?requirePositiveInt(sessionCustomer.id,'customer ID'):null;
    let customerId=sessionCustomerId;
    const settingsRows=await tx.queryAll("SELECT setting_key,setting_value FROM settings WHERE setting_key IN ('otp_mode','advance_payment_mode','advance_payment_value','advance_min_order_paisa','advance_max_order_paisa')");
    const settings=Object.fromEntries(settingsRows.map(x=>[x.setting_key,x.setting_value]));
    let isOtpVerified=Boolean(options.otpVerified);
    if(settings.otp_mode==='on'&&!isOtpVerified){
      if(options.sessionSid){
        const sidHash=crypto.createHash('sha256').update(String(options.sessionSid)).digest('hex');
        const verifiedRow=await tx.queryOne("SELECT id FROM order_otps WHERE phone=? AND (session_hash=? OR session_hash='') AND verified_at IS NOT NULL ORDER BY id DESC LIMIT 1",[phone,sidHash]);
        if(verifiedRow)isOtpVerified=true;
      }
      if(!isOtpVerified&&customerId){
        const custVerified=await tx.queryOne("SELECT phone_verified_at FROM customers WHERE id=? AND status=1",[customerId]);
        if(custVerified?.phone_verified_at)isOtpVerified=true;
      }
      if(!isOtpVerified){
        throw new ValidationError('অর্ডার সম্পন্ন করতে প্রথমে আপনার মোবাইলে পাঠানো ওটিপি (OTP) কোড ভেরিফাই করুন।');
      }
    }
    const policy=lifecycle.validateAdvancePolicy({mode:settings.advance_payment_mode||'off',value:Number(settings.advance_payment_value||0),minimumPaisa:settings.advance_min_order_paisa||0,maximumPaisa:settings.advance_max_order_paisa||null});
    const advance=lifecycle.calculateAdvance(total,policy);
    if(advance>0)throw new ConflictError('An advance is required by the current policy, but no verified payment provider is configured; checkout is paused rather than marking an unconfirmed payment paid.');
    if(customerId){const customer=await tx.queryOne('SELECT id,phone,status,is_blocked FROM customers WHERE id=? FOR UPDATE',[customerId]);if(!customer||Number(customer.status)!==1||Number(customer.is_blocked)===1||normalizeBdPhone(customer.phone)!==phone)throw new ConflictError('Sign in with an account matching the delivery phone, or continue as a guest.');customerId=Number(customer.id);}
    const invoice=`MT-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    const zoneLabel=[zone.division,zone.district,zone.upazila].filter(Boolean).join(' / ');
    const orderChannel=campaign?'campaign':'storefront';const trafficSource=campaign?`Campaign:${campaign.slug}`:attributionData.platformSource;const customerNote=note||(campaign?`Campaign: ${campaign.title}`:null);
    const codDue=isManualPayment?0:total;
    const paymentStatus=isManualPayment?'pending_verification':'unpaid';
    const order=await tx.execute(`INSERT INTO orders (invoice_no,idempotency_key,checkout_request_hash,customer_id,customer_name,customer_phone,shipping_address,division,district,upazila,shipping_zone,subtotal_paisa,discount_paisa,shipping_paisa,total_paisa,advance_required_paisa,paid_paisa,cod_due_paisa,coupon_code,payment_method,payment_status,order_status,order_channel,traffic_source,utm_source,utm_medium,utm_campaign,analytics_consent_at,analytics_consent_version,client_ip,customer_note,consent_accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,[invoice,key,payloadHash,customerId,name,phone,address,zone.division,zone.district,zone.upazila,zoneLabel,subtotal,coupon.amount,shipping,total,0,0,codDue,coupon.code,paymentMethod,paymentStatus,'pending',orderChannel,trafficSource,attributionData.utmSource,attributionData.utmMedium,attributionData.utmCampaign,attributionAllowed?new Date():null,attributionAllowed?CONSENT_VERSION:null,String(ip||'').slice(0,64),customerNote]);
    if(isManualPayment)await tx.execute("INSERT INTO order_payments (order_id,gateway_code,provider_trx_id,sender_number,amount_paisa,payment_purpose,status) VALUES (?,?,?,?,?,'full','pending_verification')",[order.insertId,gateway.code,trxId,senderNumber,total]);
    const vendorSubOrders=new Map();
    for(const item of items){
      const insertedItem=await tx.execute('INSERT INTO order_items (order_id,product_id,variant_id,vendor_id,product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label,color_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[order.insertId,item.productId,item.variantId,item.product.vendor_id||null,item.name,item.image,item.unitPricePaisa,item.qty,item.lineTotalPaisa,item.size,item.color]);
      const vendorId=item.product.vendor_id?Number(item.product.vendor_id):null;
      const bps=vendorId?Number(item.vendorCommissionRateBps):0;
      if(!Number.isSafeInteger(bps)||bps<0||bps>10000)throw new ConflictError('Vendor commission configuration is invalid.');
      const feeUnit=Number((BigInt(item.unitPricePaisa)*BigInt(bps))/10000n);
      const entitlementUnit=item.unitPricePaisa-feeUnit;
      await tx.execute('INSERT INTO order_price_snapshots(order_item_id,vendor_id,reseller_id,quantity,customer_unit_price_paisa,vendor_entitlement_unit_paisa,reseller_margin_unit_paisa,marketplace_revenue_unit_paisa) VALUES(?,?,NULL,?,?,?,0,?)',[insertedItem.insertId,vendorId,item.qty,item.unitPricePaisa,entitlementUnit,feeUnit]);
      if(vendorId){
        const current=vendorSubOrders.get(vendorId)||{vendorId,items:[],entitlementPaisa:0,feePaisa:0,customerSubtotalPaisa:0};
        current.items.push({orderItemId:Number(insertedItem.insertId),quantity:item.qty});
        current.entitlementPaisa+=entitlementUnit*item.qty;
        current.feePaisa+=feeUnit*item.qty;
        current.customerSubtotalPaisa+=item.lineTotalPaisa;
        vendorSubOrders.set(vendorId,current);
      }
    }
    const subOrders=[...vendorSubOrders.values()].sort((a,b)=>a.vendorId-b.vendorId);
    const vendorSubtotal=subOrders.reduce((sum,subOrder)=>sum+subOrder.customerSubtotalPaisa,0);
    let allocatedCod=0;
    for(let index=0;index<subOrders.length;index++){
      const subOrder=subOrders[index];
      let subOrderCodDue=subtotal>0?Number((BigInt(subOrder.customerSubtotalPaisa)*BigInt(total))/BigInt(subtotal)):0;
      if(index===subOrders.length-1&&vendorSubtotal===subtotal)subOrderCodDue=total-allocatedCod;
      allocatedCod+=subOrderCodDue;
      const vendorOrderNo=`${invoice}-${subOrder.vendorId}`;
      const insertedSubOrder=await tx.execute('INSERT INTO vendor_sub_orders(order_id,vendor_id,vendor_order_no,status,cod_due_paisa,vendor_entitlement_paisa,marketplace_fee_paisa,net_payable_paisa) VALUES(?,?,?,\'order_placed\',?,?,?,?)',[order.insertId,subOrder.vendorId,vendorOrderNo,subOrderCodDue,subOrder.entitlementPaisa,subOrder.feePaisa,subOrder.entitlementPaisa]);
      for(const item of subOrder.items)await tx.execute('INSERT INTO vendor_sub_order_items(vendor_sub_order_id,order_item_id,quantity) VALUES(?,?,?)',[insertedSubOrder.insertId,item.orderItemId,item.quantity]);
    }
    await tx.execute("INSERT INTO order_status_history (order_id,from_status,to_status,note,changed_by_user_id) VALUES (?,'','pending','Customer checkout submitted',NULL)",[order.insertId]);
    try {
      const { splitOrderByVendor } = require('../services/splitOrderService');
      await splitOrderByVendor(Number(order.insertId), {
        gatewayCode: paymentMethod,
        actor: { type: 'customer', id: customerId || null },
        tx,
      });
    } catch (_splitErr) {
      // Split order fallback logging
    }
    // Reserve only after the durable order and lines exist, in this same transaction.
    await lifecycle.reserveOrderInventoryTx(tx,Number(order.insertId),{type:'system'});
    if(coupon.code)await tx.execute('UPDATE coupons SET used_count=used_count+1 WHERE code=?',[coupon.code]);
    const referralCode = options.referralCode || null;
    if (referralCode) {
      try {
        const referralService = require('../services/referralService');
        await referralService.recordReferralOrderPending({
          orderId: order.insertId,
          orderTotalPaisa: total,
          referralCode,
          refereePhone: phone,
          refereeCustomerId: customerId,
          tx,
        });
      } catch (_refErr) {}
    }
    const affiliateCode = options.affiliateCode || null;
    if (affiliateCode) {
      try {
        const affiliateService = require('../services/affiliateService');
        await affiliateService.recordOrderAffiliatePending({
          orderId: order.insertId,
          orderTotalPaisa: total,
          affiliateCode,
          tx,
        });
      } catch (_affErr) {}
    }
    if(customerId){
      await tx.execute('UPDATE customers SET total_orders=total_orders+1,address=? WHERE id=?',[address,customerId]);
      if(clearSavedCart){
        // The order, inventory reservation, and saved-cart clear must commit or roll back together.
        // Cart mutations acquire the same customer lock, so this clear cannot race a line-scoped write.
        await tx.execute('DELETE FROM customer_cart_items WHERE customer_id=?',[customerId]);
      }
    }
    if(recovery){
      await tx.execute("UPDATE incomplete_orders SET status='recovered',recovered_order_id=? WHERE id=? AND consent_withdrawn_at IS NULL",[order.insertId,recoveryId]);
      await tx.execute("INSERT INTO incomplete_order_history (incomplete_order_id,from_status,to_status,reason) VALUES (?,?,'recovered','Customer placed order through the same consented checkout session')",[recoveryId,recovery.status]);
      await tx.execute("INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES ('customer',NULL,'checkout.recovery.recovered','incomplete_order',?,?,?,?,'')",[String(recoveryId),JSON.stringify({status:recovery.status}),JSON.stringify({status:'recovered',orderId:Number(order.insertId)}),String(ip||'').slice(0,64)]);
    }
    await tx.execute(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES ('system',NULL,'checkout.order.created','order',?,NULL,?,?, '')`,[String(order.insertId),JSON.stringify({invoiceNo:invoice,totalPaisa:total,status:'pending',paymentStatus:'unpaid',reservation:'active'}),String(ip||'').slice(0,64)]);
    if(isOtpVerified){
      await tx.execute("UPDATE orders SET otp_status='verified' WHERE id=?",[order.insertId]);
      await tx.execute("UPDATE order_otps SET order_id=? WHERE phone=? AND order_id IS NULL AND verified_at IS NOT NULL",[order.insertId,phone]);
    }
    return{id:Number(order.insertId),invoiceNo:invoice,replayed:false,totalPaisa:total,paidPaisa:0,codDuePaisa:codDue,paymentStatus};
  });
  if (result && !result.replayed) {
    try {
      const smsService = require('../services/smsService');
      smsService.sendOrderPlacedSms({
        orderId: result.id,
        invoiceNo: result.invoiceNo,
        customerName: input.customer_name,
        phone: input.phone,
        totalAmount: (Number(result.totalPaisa || 0) / 100).toFixed(0),
        deliveryArea: input.address
      });
    } catch (_smsErr) {
      // Non-blocking SMS trigger
    }
    try {
      const pushService = require('../services/pushNotificationService');
      pushService.notifyPartnerNewOrder({
        orderId: result.id,
        invoiceNo: result.invoiceNo,
        totalBdt: (Number(result.totalPaisa || 0) / 100).toFixed(0)
      });
    } catch (_pushErr) {}
    try {
      const capiService = require('../services/facebookCapiService');
      capiService.sendOrderPurchaseEvent({
        invoiceNo: result.invoiceNo,
        totalAmount: (Number(result.totalPaisa || 0) / 100).toFixed(2),
        customerName: input.customer_name,
        phone: input.phone,
        clientIp: options.ip || '',
        userAgent: options.userAgent || '',
        fbp: options.fbp || '',
        fbc: options.fbc || ''
      });
    } catch (_capiErr) {
      // Non-blocking CAPI trigger
    }
  }
  } catch(err) {
    if(err.code==='DB_DUPLICATE_ENTRY'||err.mysqlCode==='ER_LOCK_DEADLOCK'){
      const replay=await client().queryOne('SELECT id,invoice_no,checkout_request_hash FROM orders WHERE idempotency_key=?',[key]);
      if(replay){if(replay.checkout_request_hash!==payloadHash)throw new ConflictError('This checkout request key was already used with different order details.');return{id:Number(replay.id),invoiceNo:replay.invoice_no,replayed:true};}
      if(err.mysqlCode==='ER_LOCK_DEADLOCK'&&deadlockRetry<1)return createOrder(input,{...options,deadlockRetry:deadlockRetry+1});
    }
    throw err;
  }
}
async function createCampaignOrder(input={},options={}){
  assertMysql();
  const slug=requireString(options.campaignSlug,'campaign slug',{min:1,max:191});
  const qty=requirePositiveInt(options.qty,'quantity',{max:99});
  const row=await client().queryOne("SELECT product_id,publish_state,status FROM campaigns WHERE slug=? LIMIT 1",[slug]);
  if(!row||Number(row.status)!==1||row.publish_state!=='published'||!row.product_id)throw new ConflictError('This campaign is not active or has no linked product.');
  const sessionKey=requireString(options.requestKey,'campaign request key',{min:16,max:100});
  const requestKey=`campaign:${crypto.createHash('sha256').update(slug).digest('hex').slice(0,16)}:${crypto.createHash('sha256').update(sessionKey).digest('hex').slice(0,32)}`;
  return createOrder(input,{...options,requestKey,cart:[{product_id:Number(row.product_id),qty}],campaignSlug:slug,clearSavedCart:false});
}
async function getOrderForCancellation(invoiceNo){
  assertMysql();
  const value=requireString(invoiceNo,'invoice number',{min:8,max:40});
  return client().queryOne('SELECT id,invoice_no,order_status FROM orders WHERE invoice_no=? LIMIT 1',[value]);
}
async function getOrderForSuccess(invoiceNo){
  assertMysql();const db=client();const order=await db.queryOne('SELECT id,invoice_no,customer_name,total_paisa,paid_paisa,cod_due_paisa,order_status,payment_status,created_at FROM orders WHERE invoice_no=?',[requireString(invoiceNo,'invoice number',{min:8,max:40})]);
  if(!order)return null;const items=await db.queryAll('SELECT product_name,qty,unit_price_paisa,line_total_paisa,size_label,color_label FROM order_items WHERE order_id=? ORDER BY id',[order.id]);return{order,items};
}
module.exports={normalizeLines,unitPrice,quoteCart,fallbackDeliveryLocations,listDeliveryLocations,listCheckoutMethods,couponAmount,validateCoupon,resolveQuickOrderVariant,quoteQuickOrder,createOrder,getOrderForSuccess,getOrderForCancellation,createCampaignOrder};
