'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
const { recordAuditLog } = require('./auditLogRepository');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

const TAXONOMY = Object.freeze({
  categories:{table:'categories',name:'Category',join:'',select:'c.id,c.name_bn AS name,c.slug,c.icon,c.status,COUNT(p.id) AS product_count',from:'categories c LEFT JOIN products p ON p.category_id=c.id',group:'GROUP BY c.id,c.name_bn,c.slug,c.icon,c.status,c.sort_order',order:'c.sort_order ASC,c.id ASC'},
  subcategories:{table:'subcategories',name:'Subcategory',join:' JOIN categories c ON c.id=s.category_id',select:'s.id,s.name_bn AS name,s.slug,s.status,c.name_bn AS category_name',from:'subcategories s',group:'',order:'s.id DESC'},
  childcategories:{table:'childcategories',name:'Childcategory',join:' JOIN subcategories s ON s.id=ch.subcategory_id',select:'ch.id,ch.name_bn AS name,ch.slug,ch.status,s.name_bn AS subcategory_name',from:'childcategories ch',group:'',order:'ch.id DESC'},
  brands:{table:'brands',name:'Brand',join:'',select:'id,name_bn AS name,slug,status',from:'brands',group:'',order:'id DESC'},
  colors:{table:'colors',name:'Color',join:'',select:'id,name_bn AS name,hex_code,status',from:'colors',group:'',order:'id DESC'},
  sizes:{table:'sizes',name:'Size',join:'',select:'id,name_bn AS name,status',from:'sizes',group:'',order:'id DESC'},
});

function client(pool=null){
  if(env.db.client!=='mysql'&&!pool)throw new Error('Admin catalog repository requires MySQL.');
  return createQueryClient(pool||getPool());
}
function taxonomyType(value){
  const key=String(value||'');
  if(!Object.hasOwn(TAXONOMY,key))throw new ValidationError('Unsupported catalog record type.');
  return key;
}
function text(value,label,max,{required=false}={}){
  if(value!==undefined&&value!==null&&typeof value!=='string'&&typeof value!=='number')throw new ValidationError(`${label} must be text.`);
  const result=String(value??'').trim();
  if(required&&!result)throw new ValidationError(`${label} is required.`);
  if(result.length>max)throw new ValidationError(`${label} must not exceed ${max} characters.`);
  return result;
}
function id(value,label){
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<=0)throw new ValidationError(`${label} must be a positive integer.`);
  return parsed;
}
function slug(value,fallback){
  const out=String(value||fallback||'').trim().toLowerCase().replace(/\s+/g,'-').replace(/[^\p{L}\p{N}-]+/gu,'').replace(/^-+|-+$/g,'');
  if(!out||out.length>191)throw new ValidationError('Slug must contain 1 to 191 letters, numbers, or hyphens.');
  return out;
}
function modeFilter(mode){
  const value=String(mode||'all');
  if(!['all','inhouse','vendor','pending','wholesale'].includes(value))throw new ValidationError('Unsupported catalog product filter.');
  return value;
}

async function listProducts({mode='all',search=''}={}, {pool=null}={}){
  mode=modeFilter(mode);
  const q=text(search,'Search',120);
  const where=['p.is_archived=0'];const params=[];
  if(mode==='inhouse')where.push('p.vendor_id IS NULL');
  if(mode==='vendor')where.push('p.vendor_id IS NOT NULL');
  if(mode==='pending'){where.push('p.vendor_id IS NOT NULL');where.push("p.approval_status='pending'");}
  if(mode==='wholesale')where.push('(p.is_wholesale=1 OR p.wholesale_price_paisa>0)');
  if(q){where.push("(p.name_bn LIKE ? ESCAPE '!' OR p.name_en LIKE ? ESCAPE '!' OR p.sku LIKE ? ESCAPE '!')");const escaped=q.replace(/[!%_]/g,c=>`!${c}`);params.push(`%${escaped}%`,`%${escaped}%`,`%${escaped}%`);}
  return client(pool).queryAll(`SELECT p.id,p.sku AS code,p.slug,p.name_bn AS name,p.image_url AS image,
      p.regular_price_paisa/100 AS old_price,p.sale_price_paisa/100 AS new_price,
      p.wholesale_price_paisa/100 AS wholesale_price,p.wholesale_min_qty,
      p.stock_on_hand AS stock,p.is_flash_sale,p.is_hot_deal,p.is_wholesale,p.approval_status,p.status,
      c.name_bn AS category_name,v.shop_name AS vendor_name
    FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN vendors v ON v.id=p.vendor_id
    WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 1000`,params);
}

async function listTaxonomy(typeInput,{pool=null}={}){
  const type=taxonomyType(typeInput);const spec=TAXONOMY[type];
  const sql=`SELECT ${spec.select} FROM ${spec.from}${spec.join?spec.join:''} ${spec.group} ORDER BY ${spec.order} LIMIT 2000`;
  return client(pool).queryAll(sql);
}

async function validateParent(type,input,tx){
  if(type==='subcategories'){
    const parent=id(input.category_id,'Parent category');
    if(!await tx.queryOne('SELECT id FROM categories WHERE id=? AND status=1 FOR UPDATE',[parent]))throw new ValidationError('Selected category does not exist or is inactive.');
    return {parentColumn:'category_id',parentId:parent};
  }
  if(type==='childcategories'){
    const parent=id(input.subcategory_id,'Parent subcategory');
    if(!await tx.queryOne('SELECT s.id FROM subcategories s JOIN categories c ON c.id=s.category_id WHERE s.id=? AND s.status=1 AND c.status=1 FOR UPDATE',[parent]))throw new ValidationError('Selected subcategory or its parent category does not exist or is inactive.');
    return {parentColumn:'subcategory_id',parentId:parent};
  }
  return null;
}
async function createTaxonomy(typeInput,input={},actor={}, {pool=null}={}){
  const type=taxonomyType(typeInput);const spec=TAXONOMY[type];
  const name=text(input.name,`${spec.name} name`,191,{required:true});
  const nameEn=text(input.name_en||'',`${spec.name} English name`,191);
  const hasSlug=['categories','subcategories','childcategories','brands'].includes(type);
  const entrySlug=hasSlug?slug(input.slug,name):'';
  const metadata={name_bn:name,name_en:nameEn,...(hasSlug?{slug:entrySlug}:{})};
  let icon='';let sortOrder=0;let hex='#dc2626';
  if(type==='categories'){
    icon=text(input.icon||'🍒','Category icon',120);const raw=input.sort_order===undefined||input.sort_order===''?'1':input.sort_order;sortOrder=Number(raw);
    if(!Number.isSafeInteger(sortOrder)||sortOrder<0||sortOrder>2147483647)throw new ValidationError('Sort order must be a non-negative whole number.');
    metadata.icon=icon;metadata.sort_order=sortOrder;
  }
  if(type==='colors'){
    hex=text(input.hex_code||'#dc2626','Color code',16);
    if(!/^#[0-9a-fA-F]{6}$/.test(hex))throw new ValidationError('Color code must be a six-digit hexadecimal color.');
    metadata.hex_code=hex;
  }
  try{
    return await withTransaction(async tx=>{
      const parent=await validateParent(type,input,tx);
      let result;
      if(parent){
        const columns=[parent.parentColumn,'name_bn','name_en','slug'];
        const values=[parent.parentId,name,nameEn,entrySlug];
        result=await tx.execute(`INSERT INTO ${spec.table}(${columns.join(',')}) VALUES(?,?,?,?)`,values);
        metadata[parent.parentColumn]=parent.parentId;
      }else if(type==='categories'){
        result=await tx.execute('INSERT INTO categories(name_bn,name_en,slug,icon,sort_order) VALUES(?,?,?,?,?)',[name,nameEn,entrySlug,icon,sortOrder]);
      }else if(type==='brands'){
        result=await tx.execute('INSERT INTO brands(name_bn,name_en,slug) VALUES(?,?,?)',[name,nameEn,entrySlug]);
      }else if(type==='colors'){
        result=await tx.execute('INSERT INTO colors(name_bn,name_en,hex_code) VALUES(?,?,?)',[name,nameEn,hex]);
      }else{
        result=await tx.execute('INSERT INTO sizes(name_bn,name_en) VALUES(?,?)',[name,nameEn]);
      }
      const created={id:Number(result.insertId),...metadata};
      await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:`catalog.${type}.create`,entityType:type,entityId:created.id,afterState:metadata,ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
      return created;
    },{pool:pool||getPool()});
  }catch(error){if(error.code==='DB_DUPLICATE_ENTRY')throw new ConflictError(`A ${spec.name.toLowerCase()} with this slug already exists.`);throw error;}
}

async function toggleProductStatus(idInput,actor={}, {pool=null}={}){
  const productId=id(idInput,'Product');
  return withTransaction(async tx=>{
    const before=await tx.queryOne('SELECT id,status,is_archived FROM products WHERE id=? FOR UPDATE',[productId]);
    if(!before)throw new NotFoundError('Product not found.');
    if(Number(before.is_archived))throw new ValidationError('Archived products must be restored before changing status.');
    const status=Number(before.status)?0:1;
    await tx.execute('UPDATE products SET status=? WHERE id=?',[status,productId]);
    await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'product.status.toggle',entityType:'product',entityId:productId,beforeState:{status:Number(before.status)},afterState:{status},ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
    return {id:productId,status};
  },{pool:pool||getPool()});
}
async function listReviews(filter='all',{pool=null}={}){
  if(!['all','pending'].includes(filter))throw new ValidationError('Unsupported review filter.');
  const where=filter==='pending'?"WHERE r.status='pending'":'';
  return client(pool).queryAll(`SELECT r.id,r.product_id,r.customer_id,r.customer_name,r.rating,r.comment,r.status,r.created_at,p.name_bn AS product_name
    FROM reviews r LEFT JOIN products p ON p.id=r.product_id ${where} ORDER BY r.id DESC LIMIT 2000`);
}
async function listReviewProductOptions({pool=null}={}){
  return client(pool).queryAll('SELECT id,name_bn AS name,name_en FROM products WHERE status=1 AND is_archived=0 ORDER BY id ASC LIMIT 2000');
}
async function createReview(input={},actor={}, {pool=null}={}){
  const productId=id(input.product_id,'Product');const customerName=text(input.customer_name,'Customer name',191,{required:true});
  const rating=Number(input.rating??5);if(!Number.isSafeInteger(rating)||rating<1||rating>5)throw new ValidationError('Review rating must be a whole number from 1 to 5.');
  const comment=text(input.comment,'Review comment',5000,{required:true});
  return withTransaction(async tx=>{
    const product=await tx.queryOne('SELECT id FROM products WHERE id=? AND status=1 AND is_archived=0 FOR UPDATE',[productId]);
    if(!product)throw new ValidationError('Selected product does not exist or is inactive.');
    const result=await tx.execute("INSERT INTO reviews(product_id,customer_name,rating,comment,status) VALUES(?,?,?,?,'approved')",[productId,customerName,rating,comment]);
    await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'catalog.review.create',entityType:'review',entityId:result.insertId,afterState:{productId,customerName,rating,commentLength:comment.length,status:'approved'},ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
    return {id:Number(result.insertId),product_id:productId,customer_name:customerName,rating,status:'approved'};
  },{pool:pool||getPool()});
}
async function approveReview(idInput,actor={}, {pool=null}={}){
  const reviewId=id(idInput,'Review');
  return withTransaction(async tx=>{
    const before=await tx.queryOne('SELECT id,status FROM reviews WHERE id=? FOR UPDATE',[reviewId]);
    if(!before)throw new NotFoundError('Review not found.');
    if(before.status==='approved')return {id:reviewId,status:'approved',replayed:true};
    await tx.execute("UPDATE reviews SET status='approved' WHERE id=?",[reviewId]);
    await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'catalog.review.approve',entityType:'review',entityId:reviewId,beforeState:{status:before.status},afterState:{status:'approved'},ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
    return {id:reviewId,status:'approved',replayed:false};
  },{pool:pool||getPool()});
}

async function approvePendingVendorProduct(idInput,actor={}, {pool=null}={}){
  const productId=id(idInput,'Product');
  return withTransaction(async tx=>{
    const before=await tx.queryOne('SELECT id,vendor_id,approval_status,status,is_archived FROM products WHERE id=? FOR UPDATE',[productId]);
    if(!before)throw new NotFoundError('Product not found.');
    if(!before.vendor_id||before.approval_status!=='pending')throw new ConflictError('Only pending vendor products can be approved.');
    if(Number(before.is_archived))throw new ValidationError('Archived products cannot be approved.');
    await tx.execute("UPDATE products SET approval_status='approved',status=1 WHERE id=?",[productId]);
    await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'product.vendor.approve',entityType:'product',entityId:productId,beforeState:{approval_status:before.approval_status,status:Number(before.status)},afterState:{approval_status:'approved',status:1},ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
    return {id:productId,status:1,approval_status:'approved'};
  },{pool:pool||getPool()});
}

module.exports={listProducts,listTaxonomy,createTaxonomy,toggleProductStatus,approvePendingVendorProduct,listReviews,listReviewProductOptions,createReview,approveReview};
