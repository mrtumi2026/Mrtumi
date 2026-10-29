'use strict';

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const sqlite = require('../db/database');
const { withTransaction } = require('../db/mysqlPool');
const { recordAuditLog } = require('./auditLogRepository');
const { ValidationError, NotFoundError, AppError, ConflictError } = require('../utils/errors');
const { bdtToPaisa } = require('../utils/money');

function isMysql() {
  return env.db.client === 'mysql';
}

function cleanText(value, max, label, required = false) {
  const out = String(value ?? '').trim();
  if (required && !out) throw new ValidationError(`${label} is required.`);
  if (out.length > max) throw new ValidationError(`${label} is too long (maximum ${max} characters).`);
  return out;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(`${label} must be a positive integer.`);
  return id;
}

function positiveInteger(value, label, allowZero = false) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (allowZero ? n < 0 : n <= 0)) throw new ValidationError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} whole number.`);
  return n;
}

function toPaisa(value, label, allowZero = true) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) throw new ValidationError(`${label} must be a non-negative BDT amount with at most 2 decimals.`);
  let paisa;
  try { paisa = bdtToPaisa(text); } catch (_err) { throw new ValidationError(`${label} is outside the supported amount range.`); }
  if (!Number.isSafeInteger(paisa) || (allowZero ? paisa < 0 : paisa <= 0)) throw new ValidationError(`${label} is outside the supported amount range.`);
  return paisa;
}

function slugify(text) {
  const slug = cleanText(text, 191, 'Slug', true).toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]+/gu, '').replace(/^-+|-+$/g, '');
  if (!slug) throw new ValidationError('Slug must contain at least one letter or number.');
  return slug;
}

async function createSupplier(input, actor = {}) {
  const supplier = {
    code: cleanText(input.supplier_code || '', 48, 'Supplier code'),
    name: cleanText(input.name, 191, 'Supplier name', true),
    company: cleanText(input.company, 191, 'Company'),
    contact: cleanText(input.contact_person, 191, 'Contact person'),
    phone: cleanText(input.phone, 32, 'Phone', true),
    email: cleanText(input.email, 191, 'Email'),
    address: cleanText(input.address, 4000, 'Address'),
    businessId: cleanText(input.tax_or_trade_id, 100, 'Business identifier'),
    notes: cleanText(input.notes, 4000, 'Notes'),
  };
  if (supplier.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.email)) throw new ValidationError('Email address is invalid.');
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    return withTransaction(async (tx) => {
      const result = await tx.execute(
        `INSERT INTO suppliers (supplier_code, name, company, contact_person, phone, email, address, tax_or_trade_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [supplier.code || null, supplier.name, supplier.company, supplier.contact, supplier.phone, supplier.email || null, supplier.address || null, supplier.businessId, supplier.notes || null]
      );
      const out = { id: result.insertId, ...supplier };
      await recordAuditLog({ actorType: 'admin', actorId: actor.id || null, action: 'supplier.create', entityType: 'supplier', entityId: result.insertId, afterState: supplier, ipAddress: actor.ip || '', userAgent: actor.userAgent || '' }, tx);
      return out;
    }, { pool });
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const result = sqlite.run(
      `INSERT INTO suppliers (supplier_code, name, company, contact_person, phone, email, address, tax_or_trade_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      supplier.code || null, supplier.name, supplier.company, supplier.contact, supplier.phone, supplier.email, supplier.address, supplier.businessId, supplier.notes
    );
    const out = { id: Number(result.lastInsertRowid), ...supplier };
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent)
      VALUES ('admin',?,'supplier.create','supplier',?,?,?,?)`, actor.id || null, String(out.id), JSON.stringify(supplier), String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return out;
  } catch (err) {
    try { sqlite.rawDb.exec('ROLLBACK'); } catch (_e) {}
    throw err;
  }
}

async function listSuppliers() {
  if (isMysql()) {
    return require('../db/mysqlPool').queryAll(`SELECT s.*, COUNT(DISTINCT p.id) AS purchase_count,
      COALESCE(SUM(CASE WHEN pi.ordered_qty > pi.received_qty THEN pi.ordered_qty - pi.received_qty ELSE 0 END), 0) AS outstanding_qty
      FROM suppliers s LEFT JOIN purchases p ON p.supplier_id=s.id
      LEFT JOIN purchase_items pi ON pi.purchase_id=p.id
      GROUP BY s.id ORDER BY s.id DESC LIMIT 500`);
  }
  return sqlite.all(`SELECT s.*, COUNT(DISTINCT p.id) AS purchase_count,
    COALESCE(SUM(CASE WHEN pi.ordered_qty > pi.received_qty THEN pi.ordered_qty-pi.received_qty ELSE 0 END),0) AS outstanding_qty
    FROM suppliers s LEFT JOIN purchases p ON p.supplier_id=s.id LEFT JOIN purchase_items pi ON pi.purchase_id=p.id
    GROUP BY s.id ORDER BY s.id DESC LIMIT 500`);
}

async function getSupplierForEdit(idInput) {
  const id=positiveId(idInput,'Supplier');
  const supplier=isMysql()
    ? await require('../db/mysqlPool').queryOne(`SELECT id,supplier_code,name,company,contact_person,phone,email,address,tax_or_trade_id,notes,status FROM suppliers WHERE id=?`,[id])
    : sqlite.get(`SELECT id,supplier_code,name,company,contact_person,phone,email,address,tax_or_trade_id,notes,status FROM suppliers WHERE id=?`,id);
  if(!supplier)throw new NotFoundError('Supplier not found.');
  return supplier;
}

function normalizeSupplierEditInput(input) {
  const supplier={
    code:cleanText(input.supplier_code||'',48,'Supplier code'),
    name:cleanText(input.name,191,'Supplier name',true),
    company:cleanText(input.company,191,'Company'),
    contact:cleanText(input.contact_person,191,'Contact person'),
    phone:cleanText(input.phone,32,'Phone',true),
    email:cleanText(input.email,191,'Email'),
    address:cleanText(input.address,4000,'Address'),
    businessId:cleanText(input.tax_or_trade_id,100,'Business identifier'),
    notes:cleanText(input.notes,4000,'Notes'),
  };
  if(supplier.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.email))throw new ValidationError('Email address is invalid.');
  const status=String(input.status??'');
  if(status!=='0'&&status!=='1')throw new ValidationError('Supplier status must be active or inactive.');
  supplier.status=Number(status);
  return supplier;
}

function supplierAuditState(supplier) {
  return {supplierCode:supplier.supplier_code||null,name:supplier.name,company:supplier.company||'',contactPerson:supplier.contact_person||'',
    phone:supplier.phone,email:supplier.email||'',address:supplier.address||'',businessIdentifier:supplier.tax_or_trade_id||'',notes:supplier.notes||'',status:Number(supplier.status)};
}

async function updateSupplier(idInput,input,actor={}) {
  const id=positiveId(idInput,'Supplier');
  const supplier=normalizeSupplierEditInput(input);
  const params=[supplier.code||null,supplier.name,supplier.company,supplier.contact,supplier.phone,supplier.email||null,supplier.address||null,
    supplier.businessId,supplier.notes||null,supplier.status,id];
  if(isMysql()){
    const pool=require('../db/mysqlPool').getPool();
    try {
      return await withTransaction(async(tx)=>{
        const current=await tx.queryOne('SELECT id,supplier_code,name,company,contact_person,phone,email,address,tax_or_trade_id,notes,status FROM suppliers WHERE id=? FOR UPDATE',[id]);
        if(!current)throw new NotFoundError('Supplier not found.');
        if(supplier.code){
          const duplicate=await tx.queryOne('SELECT id FROM suppliers WHERE supplier_code=? AND id<>? FOR UPDATE',[supplier.code,id]);
          if(duplicate)throw new ConflictError('Supplier code is already assigned to another supplier.');
        }
        const before=supplierAuditState(current);
        await tx.execute(`UPDATE suppliers SET supplier_code=?,name=?,company=?,contact_person=?,phone=?,email=?,address=?,tax_or_trade_id=?,notes=?,status=? WHERE id=?`,params);
        const after={supplierCode:supplier.code||null,name:supplier.name,company:supplier.company,contactPerson:supplier.contact,phone:supplier.phone,
          email:supplier.email,address:supplier.address,businessIdentifier:supplier.businessId,notes:supplier.notes,status:supplier.status};
        await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'supplier.update',entityType:'supplier',entityId:id,
          beforeState:before,afterState:after,ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
        return {id,...supplier};
      },{pool});
    }catch(err){
      if(err?.code==='ER_DUP_ENTRY'||err?.code==='SQLITE_CONSTRAINT_UNIQUE')throw new ConflictError('Supplier code is already assigned to another supplier.');
      throw err;
    }
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const current=sqlite.get('SELECT id,supplier_code,name,company,contact_person,phone,email,address,tax_or_trade_id,notes,status FROM suppliers WHERE id=?',id);
    if(!current)throw new NotFoundError('Supplier not found.');
    if(supplier.code&&sqlite.get('SELECT id FROM suppliers WHERE supplier_code=? AND id<>?',supplier.code,id))throw new ConflictError('Supplier code is already assigned to another supplier.');
    const before=supplierAuditState(current);
    sqlite.run(`UPDATE suppliers SET supplier_code=?,name=?,company=?,contact_person=?,phone=?,email=?,address=?,tax_or_trade_id=?,notes=?,status=? WHERE id=?`,...params);
    const after={supplierCode:supplier.code||null,name:supplier.name,company:supplier.company,contactPerson:supplier.contact,phone:supplier.phone,
      email:supplier.email,address:supplier.address,businessIdentifier:supplier.businessId,notes:supplier.notes,status:supplier.status};
    sqlite.run(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES('admin',?,'supplier.update','supplier',?,?,?,?,?)`,actor.id||null,String(id),JSON.stringify(before),JSON.stringify(after),
      String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return {id,...supplier};
  }catch(err){
    try{sqlite.rawDb.exec('ROLLBACK');}catch(_e){}
    if(err?.code==='SQLITE_CONSTRAINT_UNIQUE')throw new ConflictError('Supplier code is already assigned to another supplier.');
    throw err;
  }
}

async function getSupplierPurchaseHistory(idInput,pageInput=1) {
  const supplierId=positiveId(idInput,'Supplier');
  const page=positiveInteger(pageInput,'Page');
  if(page>1000000)throw new ValidationError('Page is outside the supported range.');
  const offset=(page-1)*100;
  const db=isMysql()?require('../db/mysqlPool'):null;
  const supplier=isMysql()
    ? await db.queryOne('SELECT id,supplier_code,name,company,phone,status FROM suppliers WHERE id=?',[supplierId])
    : sqlite.get('SELECT id,supplier_code,name,company,phone,status FROM suppliers WHERE id=?',supplierId);
  if(!supplier)throw new NotFoundError('Supplier not found.');

  const rawPurchases=isMysql()
    ? await db.queryAll(`SELECT p.id,p.reference_no,p.purchase_date,p.receive_status AS status,p.created_at,COUNT(DISTINCT pi.id) AS line_count,
        COALESCE(SUM(pi.ordered_qty),0) AS ordered_qty,COALESCE(SUM(pi.received_qty),0) AS received_qty
      FROM purchases p LEFT JOIN purchase_items pi ON pi.purchase_id=p.id WHERE p.supplier_id=?
      GROUP BY p.id ORDER BY p.id DESC LIMIT 101 OFFSET ?`,[supplierId,offset])
    : await sqlite.all(`SELECT p.id,p.reference_no,p.purchase_date,p.status,p.created_at,COUNT(DISTINCT pi.id) AS line_count,
        COALESCE(SUM(pi.ordered_qty),0) AS ordered_qty,COALESCE(SUM(pi.received_qty),0) AS received_qty
      FROM purchases p LEFT JOIN purchase_items pi ON pi.purchase_id=p.id WHERE p.supplier_id=?
      GROUP BY p.id ORDER BY p.id DESC LIMIT 101 OFFSET ?`,supplierId,offset);
  const hasMorePurchases=rawPurchases.length>100;
  const purchases=rawPurchases.slice(0,100).map((row)=>({
    id:Number(row.id),referenceNo:row.reference_no,purchaseDate:row.purchase_date,status:row.status,createdAt:row.created_at,
    lineCount:Number(row.line_count||0),orderedQty:Number(row.ordered_qty||0),receivedQty:Number(row.received_qty||0),lines:[],receipts:[],
  }));
  const purchaseIds=purchases.map((row)=>row.id);
  if(purchaseIds.length){
    const marks=purchaseIds.map(()=>'?').join(',');
    const lines=isMysql()
      ? await db.queryAll(`SELECT pi.id,pi.purchase_id,pi.product_id,p.sku,p.name_bn,p.name_en,pi.ordered_qty,pi.received_qty
          FROM purchase_items pi JOIN purchases po ON po.id=pi.purchase_id JOIN products p ON p.id=pi.product_id
          WHERE po.supplier_id=? AND pi.purchase_id IN (${marks}) ORDER BY pi.purchase_id DESC,pi.id LIMIT 2000`,[supplierId,...purchaseIds])
      : await sqlite.all(`SELECT pi.id,pi.purchase_id,pi.product_id,p.code AS sku,p.name AS name_bn,p.name_en,pi.ordered_qty,pi.received_qty
          FROM purchase_items pi JOIN purchases po ON po.id=pi.purchase_id JOIN products p ON p.id=pi.product_id
          WHERE po.supplier_id=? AND pi.purchase_id IN (${marks}) ORDER BY pi.purchase_id DESC,pi.id LIMIT 2000`,supplierId,...purchaseIds);
    const purchaseById=new Map(purchases.map((row)=>[row.id,row]));
    for(const line of lines){
      const parent=purchaseById.get(Number(line.purchase_id));
      if(parent)parent.lines.push({id:Number(line.id),productId:Number(line.product_id),sku:line.sku,nameBn:line.name_bn,nameEn:line.name_en,
        orderedQty:Number(line.ordered_qty),receivedQty:Number(line.received_qty)});
    }
    const receipts=isMysql()
      ? await db.queryAll(`SELECT r.id,r.purchase_id,r.receipt_no,r.event_type,r.total_qty,r.note,r.created_at
          FROM purchase_receipts r JOIN purchases p ON p.id=r.purchase_id
          WHERE p.supplier_id=? AND r.purchase_id IN (${marks}) ORDER BY r.id DESC LIMIT 500`,[supplierId,...purchaseIds])
      : await sqlite.all(`SELECT r.id,r.purchase_id,r.receipt_no,r.event_type,r.total_qty,r.note,r.created_at
          FROM purchase_receipts r JOIN purchases p ON p.id=r.purchase_id
          WHERE p.supplier_id=? AND r.purchase_id IN (${marks}) ORDER BY r.id DESC LIMIT 500`,supplierId,...purchaseIds);
    for(const receipt of receipts){
      const parent=purchaseById.get(Number(receipt.purchase_id));
      if(parent)parent.receipts.push({id:Number(receipt.id),receiptNo:receipt.receipt_no,eventType:receipt.event_type,
        totalQty:Number(receipt.total_qty),note:receipt.note,createdAt:receipt.created_at});
    }
  }
  return {supplier:{id:Number(supplier.id),supplierCode:supplier.supplier_code||null,name:supplier.name,company:supplier.company||'',phone:supplier.phone,status:Number(supplier.status)},
    purchases,page,hasPreviousPurchases:page>1,hasMorePurchases};
}

async function listProducts() {
  if (isMysql()) return require('../db/mysqlPool').queryAll(`SELECT id, sku, name_bn, name_en, stock_on_hand, vendor_stock_on_hand, low_stock_threshold,
    regular_price_paisa, sale_price_paisa, cost_price_paisa, vendor_id, is_archived
    FROM products WHERE is_archived=0 ORDER BY id DESC LIMIT 1000`);
  return sqlite.all(`SELECT id, code AS sku, name AS name_bn, name AS name_en, stock AS stock_on_hand, vendor_stock_on_hand,
    low_stock_threshold, old_price, new_price, purchase_price, vendor_id, is_archived FROM products WHERE is_archived=0 ORDER BY id DESC LIMIT 1000`);
}

async function listInventoryPage(filters={}) {
  const q=String(filters.q||'').trim().slice(0,100);
  const filter=filters.filter==='low'?'low':'all';
  const sort=['newest','sku','name','available','threshold'].includes(filters.sort)?filters.sort:'newest';
  const pageSize=25;
  const requested=Number.parseInt(filters.page,10);
  const requestedPage=Number.isSafeInteger(requested)&&requested>0?Math.min(requested,100000):1;
  const escaped=q.replace(/[!%_]/g,(character)=>`!${character}`);
  const pattern=`%${escaped}%`;
  const mysql=isMysql();
  const table='products';
  const sku=mysql?'p.sku':'p.code';
  const nameBn=mysql?'p.name_bn':'p.name';
  const stock=mysql?'p.stock_on_hand':'p.stock';
  const reserved='p.stock_reserved';
  const available=`(${stock}-${reserved})`;
  const sortSql={
    newest:'p.id DESC',
    sku:`${sku} ASC,p.id DESC`,
    name:`LOWER(COALESCE(NULLIF(p.name_en,''),${nameBn},'')) ASC,p.id DESC`,
    available:`${available} ASC,p.id DESC`,
    threshold:`p.low_stock_threshold ASC,p.id DESC`,
  }[sort];
  const where=[`p.is_archived=0`];
  const params=[];
  if(q){where.push(`(${sku} LIKE ? ESCAPE '!' OR ${nameBn} LIKE ? ESCAPE '!' OR p.name_en LIKE ? ESCAPE '!')`);params.push(pattern,pattern,pattern);}
  if(filter==='low')where.push(`${available}<=p.low_stock_threshold`);
  const whereSql=where.join(' AND ');
  const countSql=`SELECT COUNT(*) AS total FROM ${table} p WHERE ${whereSql}`;
  const count= mysql
    ? Number((await require('../db/mysqlPool').queryOne(countSql,params)).total)
    : Number(sqlite.get(countSql,...params).total);
  const totalPages=Math.max(1,Math.ceil(count/pageSize));
  const page=Math.min(requestedPage,totalPages);
  const sql=`SELECT p.id,${sku} AS sku,${nameBn} AS name_bn,p.name_en,p.low_stock_threshold,
    ${stock} AS stock_on_hand,${reserved} AS stock_reserved,${available} AS warehouse_available,
    p.vendor_stock_on_hand,p.vendor_stock_reserved,(p.vendor_stock_on_hand-p.vendor_stock_reserved) AS vendor_available
    FROM ${table} p WHERE ${whereSql} ORDER BY ${sortSql} LIMIT ? OFFSET ?`;
  const values=[...params,pageSize,(page-1)*pageSize];
  const rows=mysql?await require('../db/mysqlPool').queryAll(sql,values):sqlite.all(sql,...values);
  return {rows,total:count,page,pageSize,totalPages,q,filter,sort,hasPrevious:page>1,hasNext:page<totalPages};
}

async function getProductForEdit(idInput) {
  const id = positiveId(idInput, 'Product');
  if (isMysql()) {
    const product = await require('../db/mysqlPool').queryOne(`SELECT id,sku,barcode,slug,product_type,name_bn,name_en,category_id,subcategory_id,childcategory_id,brand_id,
      regular_price_paisa,sale_price_paisa,cost_price_paisa,wholesale_price_paisa,wholesale_min_qty,low_stock_threshold,unit_label,
      image_url,short_desc_bn,short_desc_en,description_bn,description_en,stock_on_hand,vendor_stock_on_hand,is_archived,status
      FROM products WHERE id=?`, [id]);
    if (!product) throw new NotFoundError('Product not found.');
    return product;
  }
  const product = sqlite.get(`SELECT id,code AS sku,barcode,slug,product_type,name AS name_bn,name_en,category_id,subcategory_id,childcategory_id,brand_id,
    ROUND(old_price*100) AS regular_price_paisa,ROUND(new_price*100) AS sale_price_paisa,ROUND(purchase_price*100) AS cost_price_paisa,
    ROUND(wholesale_price*100) AS wholesale_price_paisa,wholesale_min_qty,low_stock_threshold,unit AS unit_label,image AS image_url,
    short_desc AS short_desc_bn,short_desc_en,description AS description_bn,description_en,stock AS stock_on_hand,
    vendor_stock_on_hand,is_archived,status FROM products WHERE id=?`, id);
  if (!product) throw new NotFoundError('Product not found.');
  return product;
}

async function listProductEditOptions() {
  if (isMysql()) {
    const pool = require('../db/mysqlPool');
    const [categories, subcategories, childcategories, brands] = await Promise.all([
      pool.queryAll('SELECT id,name_bn,name_en FROM categories WHERE status=1 ORDER BY sort_order,name_bn LIMIT 500'),
      pool.queryAll('SELECT id,category_id,name_bn,name_en FROM subcategories WHERE status=1 ORDER BY name_bn LIMIT 1000'),
      pool.queryAll('SELECT id,subcategory_id,name_bn,name_en FROM childcategories WHERE status=1 ORDER BY name_bn LIMIT 2000'),
      pool.queryAll('SELECT id,name_bn,name_en FROM brands WHERE status=1 ORDER BY name_bn LIMIT 500'),
    ]);
    return { categories, subcategories, childcategories, brands };
  }
  return {
    categories: sqlite.all('SELECT id,name AS name_bn,name_en FROM categories WHERE status=1 ORDER BY sort_order,name LIMIT 500'),
    subcategories: sqlite.all('SELECT id,category_id,name AS name_bn,name_en FROM subcategories WHERE status=1 ORDER BY name LIMIT 1000'),
    childcategories: sqlite.all('SELECT id,subcategory_id,name AS name_bn,name_en FROM childcategories WHERE status=1 ORDER BY name LIMIT 2000'),
    brands: sqlite.all('SELECT id,name AS name_bn,name_en FROM brands WHERE status=1 ORDER BY name LIMIT 500'),
  };
}

async function validateTaxonomyRelations(ids, db = null) {
  const mysql = isMysql();
  const one = async (sql, params) => mysql
    ? (db ? db.queryOne(sql, params) : require('../db/mysqlPool').queryOne(sql, params))
    : sqlite.get(sql, ...params);
  if (ids.categoryId) {
    const row = await one('SELECT id FROM categories WHERE id=? AND status=1', [ids.categoryId]);
    if (!row) throw new ValidationError('Selected category does not exist or is inactive.');
  }
  if (ids.subcategoryId) {
    if (!ids.categoryId) throw new ValidationError('A category is required when selecting a subcategory.');
    const row = await one('SELECT id,category_id FROM subcategories WHERE id=? AND status=1', [ids.subcategoryId]);
    if (!row) throw new ValidationError('Selected subcategory does not exist or is inactive.');
    if (Number(row.category_id) !== Number(ids.categoryId)) throw new ValidationError('Selected subcategory does not belong to the selected category.');
  }
  if (ids.childcategoryId) {
    if (!ids.subcategoryId) throw new ValidationError('A subcategory is required when selecting a child category.');
    const row = await one('SELECT id,subcategory_id FROM childcategories WHERE id=? AND status=1', [ids.childcategoryId]);
    if (!row) throw new ValidationError('Selected child category does not exist or is inactive.');
    if (Number(row.subcategory_id) !== Number(ids.subcategoryId)) throw new ValidationError('Selected child category does not belong to the selected subcategory.');
  }
}

function normalizeProductEditInput(input) {
  const product = {
    nameBn: cleanText(input.name_bn, 255, 'Bangla product name', true),
    nameEn: cleanText(input.name_en, 255, 'English product name'),
    slug: slugify(input.slug),
    type: cleanText(input.product_type || 'grocery', 32, 'Product type', true),
    categoryId: positiveId(input.category_id, 'Category'),
    subcategoryId: input.subcategory_id ? positiveId(input.subcategory_id, 'Subcategory') : null,
    childcategoryId: input.childcategory_id ? positiveId(input.childcategory_id, 'Child category') : null,
    brandId: input.brand_id ? positiveId(input.brand_id, 'Brand') : null,
    unit: cleanText(input.unit_label, 50, 'Unit', true),
    regular: toPaisa(input.regular_price_bdt, 'Regular price'),
    sale: toPaisa(input.sale_price_bdt, 'Sale price'),
    cost: toPaisa(input.cost_price_bdt, 'Cost price'),
    wholesale: toPaisa(input.wholesale_price_bdt ?? '0', 'Wholesale price'),
    minQty: positiveInteger(input.wholesale_min_qty ?? 0, 'Wholesale minimum quantity', true),
    threshold: positiveInteger(input.low_stock_threshold ?? 0, 'Low-stock threshold', true),
    image: cleanText(input.image_url, 500, 'Image URL'),
    shortBn: cleanText(input.short_desc_bn, 2000, 'Short description'),
    shortEn: cleanText(input.short_desc_en, 2000, 'English short description'),
    descriptionBn: cleanText(input.description_bn, 20000, 'Description'),
    descriptionEn: cleanText(input.description_en, 20000, 'English description'),
  };
  if (product.sale > product.regular && product.regular > 0) throw new ValidationError('Sale price cannot exceed regular price.');
  if (product.wholesale > 0 && (!product.minQty || product.wholesale >= (product.sale || product.regular))) throw new ValidationError('Wholesale price requires a minimum quantity and must be lower than selling price.');
  return product;
}

async function updateProduct(idInput, input, actor = {}) {
  const id = positiveId(idInput, 'Product');
  const product = normalizeProductEditInput(input);
  const snapshot = { ...product };
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    return withTransaction(async (tx) => {
      const before = await tx.queryOne(`SELECT id,sku,barcode,slug,product_type,name_bn,name_en,category_id,subcategory_id,childcategory_id,brand_id,
        regular_price_paisa,sale_price_paisa,cost_price_paisa,wholesale_price_paisa,wholesale_min_qty,low_stock_threshold,unit_label,
        image_url,short_desc_bn,short_desc_en,description_bn,description_en,stock_on_hand,vendor_stock_on_hand,is_archived,status
        FROM products WHERE id=? FOR UPDATE`, [id]);
      if (!before) throw new NotFoundError('Product not found.');
      if (Number(before.is_archived)) throw new ValidationError('Archived products must be restored before editing.');
      await validateTaxonomyRelations(product, tx);
      if (product.brandId) {
        const brand = await tx.queryOne('SELECT id FROM brands WHERE id=? AND status=1 FOR UPDATE', [product.brandId]);
        if (!brand) throw new ValidationError('Selected brand does not exist or is inactive.');
      }
      const duplicate = await tx.queryOne('SELECT id FROM products WHERE slug=? AND id<>? FOR UPDATE', [product.slug, id]);
      if (duplicate) throw new AppError('DUPLICATE_PRODUCT_SLUG', 'Product slug is already in use.', 409);
      await tx.execute(`UPDATE products SET slug=?,product_type=?,name_bn=?,name_en=?,category_id=?,subcategory_id=?,childcategory_id=?,brand_id=?,regular_price_paisa=?,
        sale_price_paisa=?,cost_price_paisa=?,wholesale_price_paisa=?,wholesale_min_qty=?,low_stock_threshold=?,unit_label=?,image_url=?,
        short_desc_bn=?,short_desc_en=?,description_bn=?,description_en=? WHERE id=?`,
        [product.slug,product.type,product.nameBn,product.nameEn,product.categoryId,product.subcategoryId,product.childcategoryId,product.brandId,product.regular,product.sale,
          product.cost,product.wholesale,product.minQty,product.threshold,product.unit,product.image,product.shortBn,product.shortEn,
          product.descriptionBn,product.descriptionEn,id]);
      await recordAuditLog({ actorType:'admin',actorId:actor.id||null,action:'product.update',entityType:'product',entityId:id,
        beforeState:before,afterState:snapshot,ipAddress:actor.ip||'',userAgent:actor.userAgent||'' }, tx);
      return { id, sku:before.sku, product:snapshot };
    }, { pool });
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const before = sqlite.get(`SELECT id,code AS sku,barcode,slug,product_type,name AS name_bn,name_en,category_id,subcategory_id,childcategory_id,brand_id,
      ROUND(old_price*100) AS regular_price_paisa,ROUND(new_price*100) AS sale_price_paisa,ROUND(purchase_price*100) AS cost_price_paisa,
      ROUND(wholesale_price*100) AS wholesale_price_paisa,wholesale_min_qty,low_stock_threshold,unit AS unit_label,image AS image_url,
      short_desc AS short_desc_bn,short_desc_en,description AS description_bn,description_en,stock AS stock_on_hand,
      vendor_stock_on_hand,is_archived,status FROM products WHERE id=?`, id);
    if (!before) throw new NotFoundError('Product not found.');
    if (Number(before.is_archived)) throw new ValidationError('Archived products must be restored before editing.');
    await validateTaxonomyRelations(product);
    if (product.brandId && !sqlite.get('SELECT id FROM brands WHERE id=? AND status=1', product.brandId)) throw new ValidationError('Selected brand does not exist or is inactive.');
    if (sqlite.get('SELECT id FROM products WHERE slug=? AND id<>?', product.slug, id)) throw new AppError('DUPLICATE_PRODUCT_SLUG', 'Product slug is already in use.', 409);
    sqlite.run(`UPDATE products SET slug=?,product_type=?,name=?,name_en=?,category_id=?,subcategory_id=?,childcategory_id=?,brand_id=?,old_price=?,new_price=?,purchase_price=?,
      wholesale_price=?,wholesale_min_qty=?,low_stock_threshold=?,unit=?,image=?,short_desc=?,short_desc_en=?,description=?,description_en=? WHERE id=?`,
      product.slug,product.type,product.nameBn,product.nameEn,product.categoryId,product.subcategoryId,product.childcategoryId,product.brandId,product.regular/100,product.sale/100,
      product.cost/100,product.wholesale/100,product.minQty,product.threshold,product.unit,product.image,product.shortBn,product.shortEn,
      product.descriptionBn,product.descriptionEn,id);
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES ('admin',?,'product.update','product',?,?,?,?,?)`, actor.id||null,String(id),JSON.stringify(before),JSON.stringify(snapshot),
      String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return { id, sku:before.sku, product:snapshot };
  } catch (err) {
    try { sqlite.rawDb.exec('ROLLBACK'); } catch (_e) {}
    throw err;
  }
}

const GALLERY_IMAGE_EXTENSIONS = new Set(['.jpg','.jpeg','.png','.webp','.gif']);

function isApprovedGalleryPath(rawPath) {
  const value = String(rawPath ?? '');
  const match = value.match(/^\/uploads\/(custom|product)\/([A-Za-z0-9][A-Za-z0-9._-]{0,249})$/);
  if (!match || value.includes('..') || value.includes('\\') || value.includes('%') || /[?#\u0000-\u001f]/.test(value)) return false;
  const [, kind, basename] = match;
  if (!GALLERY_IMAGE_EXTENSIONS.has(path.extname(basename).toLowerCase())) return false;
  const root = kind === 'product'
    ? path.resolve(__dirname, '../../public/uploads/product')
    : path.resolve(env.uploadDir, 'custom');
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(path.join(realRoot, basename));
    if (path.relative(realRoot, realFile) !== basename || !fs.statSync(realFile).isFile()) return false;
    return require('../middleware/upload').hasValidRasterMagicBytes(realFile);
  } catch (_err) {
    return false;
  }
}

function collectEditableGallery(row) {
  const galleryField = row.gallery_json ?? row.gallery;
  let rawItems = [];
  let blockedCount = 0;
  if (galleryField !== null && galleryField !== undefined && String(galleryField).trim() !== '') {
    try {
      rawItems = typeof galleryField === 'string' ? JSON.parse(galleryField) : galleryField;
      if (!Array.isArray(rawItems)) { rawItems = []; blockedCount += 1; }
    } catch (_err) { rawItems = []; blockedCount += 1; }
  }
  const paths = [];
  for (const item of rawItems) {
    const candidate = typeof item === 'string' ? item : item && typeof item === 'object' ? (item.url || item.image) : '';
    if (!isApprovedGalleryPath(candidate)) { blockedCount += 1; continue; }
    if (!paths.includes(candidate)) paths.push(candidate);
  }
  const primary = String(row.image_url ?? row.image ?? '').trim();
  if (primary) {
    if (!isApprovedGalleryPath(primary)) blockedCount += 1;
    else if (!paths.includes(primary)) paths.unshift(primary);
    else {
      paths.splice(paths.indexOf(primary), 1);
      paths.unshift(primary);
    }
  }
  return { paths, blockedCount };
}

function parseGalleryOrder(input) {
  let values;
  if (Array.isArray(input)) values = input;
  else if (typeof input === 'string') values = input.split(/\r?\n/);
  else throw new ValidationError('Gallery order must be a list of image paths.');
  const paths = values.map((value) => String(value ?? '').trim()).filter(Boolean);
  if (!paths.length) throw new ValidationError('At least one existing gallery image is required.');
  if (paths.some((item) => !isApprovedGalleryPath(item))) throw new ValidationError('Gallery entries must be existing safe raster images under the approved upload paths.');
  if (new Set(paths).size !== paths.length) throw new ValidationError('Each gallery image must appear exactly once.');
  return paths;
}

async function getProductGalleryForEdit(productIdInput) {
  const productId = positiveId(productIdInput, 'Product');
  const row = isMysql()
    ? await require('../db/mysqlPool').queryOne('SELECT id,image_url,gallery_json,is_archived FROM products WHERE id=?', [productId])
    : sqlite.get('SELECT id,image AS image_url,gallery AS gallery_json,is_archived FROM products WHERE id=?', productId);
  if (!row) throw new NotFoundError('Product not found.');
  return { productId, ...collectEditableGallery(row), isArchived:Boolean(Number(row.is_archived)) };
}

async function updateProductGallery(productIdInput, input, actor = {}) {
  const productId = positiveId(productIdInput, 'Product');
  const submitted = parseGalleryOrder(input.gallery_paths);
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    return withTransaction(async (tx) => {
      const row = await tx.queryOne('SELECT id,image_url,gallery_json,is_archived FROM products WHERE id=? FOR UPDATE', [productId]);
      if (!row) throw new NotFoundError('Product not found.');
      if (Number(row.is_archived)) throw new ValidationError('Archived products must be restored before managing galleries.');
      const current = collectEditableGallery(row);
      if (current.blockedCount) throw new ValidationError('This product has legacy or missing gallery entries; no gallery changes were applied. Review those references before retrying.');
      const allowed = new Set(current.paths);
      if (submitted.length !== current.paths.length || submitted.some((item) => !allowed.has(item))) {
        throw new ValidationError('Gallery order must include every current image exactly once; new or cross-product paths are not accepted.');
      }
      const beforeState = { imageUrl:current.paths[0] || '', galleryPaths:current.paths };
      await tx.execute('UPDATE products SET image_url=?,gallery_json=? WHERE id=?', [submitted[0],JSON.stringify(submitted),productId]);
      const afterState = { imageUrl:submitted[0],galleryPaths:submitted };
      await recordAuditLog({ actorType:'admin',actorId:actor.id||null,action:'product.gallery.reorder',entityType:'product',entityId:productId,
        beforeState,afterState,ipAddress:actor.ip||'',userAgent:actor.userAgent||'' }, tx);
      return { productId,imageUrl:submitted[0],galleryPaths:submitted };
    }, { pool });
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const row = sqlite.get('SELECT id,image AS image_url,gallery AS gallery_json,is_archived FROM products WHERE id=?', productId);
    if (!row) throw new NotFoundError('Product not found.');
    if (Number(row.is_archived)) throw new ValidationError('Archived products must be restored before managing galleries.');
    const current = collectEditableGallery(row);
    if (current.blockedCount) throw new ValidationError('This product has legacy or missing gallery entries; no gallery changes were applied. Review those references before retrying.');
    const allowed = new Set(current.paths);
    if (submitted.length !== current.paths.length || submitted.some((item) => !allowed.has(item))) {
      throw new ValidationError('Gallery order must include every current image exactly once; new or cross-product paths are not accepted.');
    }
    const beforeState = { imageUrl:current.paths[0] || '',galleryPaths:current.paths };
    sqlite.run('UPDATE products SET image=?,gallery=? WHERE id=?', submitted[0],JSON.stringify(submitted),productId);
    const afterState = { imageUrl:submitted[0],galleryPaths:submitted };
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES ('admin',?,'product.gallery.reorder','product',?,?,?,?,?)`, actor.id||null,String(productId),JSON.stringify(beforeState),JSON.stringify(afterState),
      String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return { productId,imageUrl:submitted[0],galleryPaths:submitted };
  } catch (err) {
    try { sqlite.rawDb.exec('ROLLBACK'); } catch (_e) {}
    throw err;
  }
}

function parseGalleryUploads(imagePaths) {
  if(!Array.isArray(imagePaths)||imagePaths.length<1||imagePaths.length>6)throw new ValidationError('Upload between 1 and 6 gallery images per request.');
  const paths=imagePaths.map((value)=>String(value??'').trim());
  if(paths.some((value)=>!/^\/uploads\/custom\/[A-Za-z0-9][A-Za-z0-9._-]{0,249}$/.test(value)||!isApprovedGalleryPath(value)))
    throw new ValidationError('Gallery uploads must be existing safe raster images under the approved custom upload root.');
  if(new Set(paths).size!==paths.length)throw new ValidationError('Each uploaded gallery image must be unique.');
  return paths;
}

async function appendProductGalleryImages(productIdInput,imagePaths,actor={}) {
  const productId=positiveId(productIdInput,'Product');
  const uploaded=parseGalleryUploads(imagePaths);
  const save=async(tx)=>{
    const row=await tx.queryOne('SELECT id,image_url,gallery_json,is_archived FROM products WHERE id=? FOR UPDATE',[productId]);
    if(!row)throw new NotFoundError('Product not found.');
    if(Number(row.is_archived))throw new ValidationError('Archived products must be restored before managing galleries.');
    const current=collectEditableGallery(row);
    if(current.blockedCount)throw new ValidationError('This product has legacy or missing gallery entries; no gallery changes were applied. Review those references before retrying.');
    if(uploaded.some((value)=>current.paths.includes(value)))throw new ValidationError('An uploaded image is already assigned to this product.');
    const paths=[...current.paths,...uploaded];
    const beforeState={imageUrl:current.paths[0]||'',galleryPaths:current.paths};
    const imageUrl=current.paths[0]||uploaded[0];
    await tx.execute('UPDATE products SET image_url=?,gallery_json=? WHERE id=?',[imageUrl,JSON.stringify(paths),productId]);
    const afterState={imageUrl,galleryPaths:paths,addedPaths:uploaded};
    await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'product.gallery.upload',entityType:'product',entityId:productId,
      beforeState,afterState,ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
    return {productId,imageUrl,galleryPaths:paths,addedPaths:uploaded};
  };
  if(isMysql()){
    const pool=require('../db/mysqlPool').getPool();
    return withTransaction((tx)=>save(tx),{pool});
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try{
    const row=sqlite.get('SELECT id,image AS image_url,gallery AS gallery_json,is_archived FROM products WHERE id=?',productId);
    if(!row)throw new NotFoundError('Product not found.');
    if(Number(row.is_archived))throw new ValidationError('Archived products must be restored before managing galleries.');
    const current=collectEditableGallery(row);
    if(current.blockedCount)throw new ValidationError('This product has legacy or missing gallery entries; no gallery changes were applied. Review those references before retrying.');
    if(uploaded.some((value)=>current.paths.includes(value)))throw new ValidationError('An uploaded image is already assigned to this product.');
    const paths=[...current.paths,...uploaded];
    const beforeState={imageUrl:current.paths[0]||'',galleryPaths:current.paths};
    const imageUrl=current.paths[0]||uploaded[0];
    sqlite.run('UPDATE products SET image=?,gallery=? WHERE id=?',imageUrl,JSON.stringify(paths),productId);
    const afterState={imageUrl,galleryPaths:paths,addedPaths:uploaded};
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES ('admin',?,'product.gallery.upload','product',?,?,?,?,?)`,actor.id||null,String(productId),JSON.stringify(beforeState),JSON.stringify(afterState),
      String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return {productId,imageUrl,galleryPaths:paths,addedPaths:uploaded};
  }catch(err){try{sqlite.rawDb.exec('ROLLBACK');}catch(_e){}throw err;}
}

async function listProductVariants(productIdInput) {
  const productId = positiveId(productIdInput, 'Product');
  if (isMysql()) {
    const pool = require('../db/mysqlPool');
    if (!await pool.queryOne('SELECT id FROM products WHERE id=?', [productId])) throw new NotFoundError('Product not found.');
    return pool.queryAll(`SELECT id,product_id,variant_sku,size_label,color_label,price_paisa,stock_on_hand,stock_reserved,status,created_at
      FROM product_variants WHERE product_id=? ORDER BY id`, [productId]);
  }
  if (!sqlite.get('SELECT id FROM products WHERE id=?', productId)) throw new NotFoundError('Product not found.');
  return sqlite.all(`SELECT id,product_id,variant_sku,size_label,color_label,ROUND(price*100) AS price_paisa,
    stock_on_hand,stock_reserved,status,created_at FROM product_variants WHERE product_id=? ORDER BY id`, productId);
}

function normalizeVariantInput(input) {
  return {
    sku: cleanText(input.variant_sku, 80, 'Variant SKU', true),
    size: cleanText(input.size_label, 80, 'Size label'),
    color: cleanText(input.color_label, 80, 'Color label'),
    price: toPaisa(input.price_bdt ?? '0', 'Variant price'),
  };
}

function duplicateVariantSku(err) {
  if (err?.code === 'DB_DUPLICATE_ENTRY' || /UNIQUE constraint failed: product_variants\.variant_sku/i.test(String(err?.message || ''))) {
    throw new ConflictError('Variant SKU is already in use.');
  }
  throw err;
}

async function createProductVariant(productIdInput, input, actor = {}) {
  const productId = positiveId(productIdInput, 'Product');
  const variant = normalizeVariantInput(input);
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    try {
      return await withTransaction(async (tx) => {
        const product = await tx.queryOne('SELECT id,is_archived FROM products WHERE id=? FOR UPDATE', [productId]);
        if (!product) throw new NotFoundError('Product not found.');
        if (Number(product.is_archived)) throw new ValidationError('Archived products must be restored before managing variants.');
        const inserted = await tx.execute(`INSERT INTO product_variants (product_id,variant_sku,size_label,color_label,price_paisa,status)
          VALUES (?,?,?,?,?,1)`, [productId,variant.sku,variant.size,variant.color,variant.price]);
        const after = { id:Number(inserted.insertId),productId,variantSku:variant.sku,sizeLabel:variant.size,colorLabel:variant.color,pricePaisa:variant.price,status:1,stockOnHand:0,stockReserved:0 };
        await recordAuditLog({ actorType:'admin',actorId:actor.id||null,action:'product.variant.create',entityType:'product_variant',entityId:inserted.insertId,
          beforeState:null,afterState:after,ipAddress:actor.ip||'',userAgent:actor.userAgent||'' }, tx);
        return after;
      }, { pool });
    } catch (err) { duplicateVariantSku(err); }
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const product = sqlite.get('SELECT id,is_archived FROM products WHERE id=?', productId);
    if (!product) throw new NotFoundError('Product not found.');
    if (Number(product.is_archived)) throw new ValidationError('Archived products must be restored before managing variants.');
    const inserted = sqlite.run('INSERT INTO product_variants (product_id,variant_sku,size_label,color_label,price,status) VALUES (?,?,?,?,?,1)',
      productId,variant.sku,variant.size,variant.color,variant.price/100);
    const after = { id:Number(inserted.lastInsertRowid),productId,variantSku:variant.sku,sizeLabel:variant.size,colorLabel:variant.color,pricePaisa:variant.price,status:1,stockOnHand:0,stockReserved:0 };
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES ('admin',?,'product.variant.create','product_variant',?,NULL,?,?,?)`, actor.id||null,String(after.id),JSON.stringify(after),
      String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return after;
  } catch (err) {
    try { sqlite.rawDb.exec('ROLLBACK'); } catch (_e) {}
    duplicateVariantSku(err);
  }
}

async function updateProductVariant(productIdInput, variantIdInput, input, actor = {}) {
  const productId = positiveId(productIdInput, 'Product');
  const variantId = positiveId(variantIdInput, 'Variant');
  for (const field of ['size_label','color_label','price_bdt','status']) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) throw new ValidationError(`Variant update requires ${field}.`);
  }
  const variant = {
    size: cleanText(input.size_label, 80, 'Size label'),
    color: cleanText(input.color_label, 80, 'Color label'),
    price: toPaisa(input.price_bdt, 'Variant price'),
  };
  const statusText = String(input.status);
  if (!['0','1'].includes(statusText)) throw new ValidationError('Variant status must be active or inactive.');
  const status = Number(statusText);
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    return withTransaction(async (tx) => {
      const product = await tx.queryOne('SELECT id,is_archived FROM products WHERE id=? FOR UPDATE', [productId]);
      if (!product) throw new NotFoundError('Product not found.');
      if (Number(product.is_archived)) throw new ValidationError('Archived products must be restored before managing variants.');
      const before = await tx.queryOne(`SELECT id,product_id,variant_sku,size_label,color_label,price_paisa,stock_on_hand,stock_reserved,status
        FROM product_variants WHERE id=? AND product_id=? FOR UPDATE`, [variantId,productId]);
      if (!before) throw new NotFoundError('Variant not found for this product.');
      await tx.execute('UPDATE product_variants SET size_label=?,color_label=?,price_paisa=?,status=? WHERE id=? AND product_id=?',
        [variant.size,variant.color,variant.price,status,variantId,productId]);
      const after = { id:variantId,productId,variantSku:before.variant_sku,sizeLabel:variant.size,colorLabel:variant.color,pricePaisa:variant.price,
        stockOnHand:Number(before.stock_on_hand),stockReserved:Number(before.stock_reserved),status };
      await recordAuditLog({ actorType:'admin',actorId:actor.id||null,action:'product.variant.update',entityType:'product_variant',entityId:variantId,
        beforeState:before,afterState:after,ipAddress:actor.ip||'',userAgent:actor.userAgent||'' }, tx);
      return after;
    }, { pool });
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const product = sqlite.get('SELECT id,is_archived FROM products WHERE id=?', productId);
    if (!product) throw new NotFoundError('Product not found.');
    if (Number(product.is_archived)) throw new ValidationError('Archived products must be restored before managing variants.');
    const before = sqlite.get(`SELECT id,product_id,variant_sku,size_label,color_label,ROUND(price*100) AS price_paisa,stock_on_hand,stock_reserved,status
      FROM product_variants WHERE id=? AND product_id=?`, variantId,productId);
    if (!before) throw new NotFoundError('Variant not found for this product.');
    sqlite.run('UPDATE product_variants SET size_label=?,color_label=?,price=?,status=? WHERE id=? AND product_id=?',
      variant.size,variant.color,variant.price/100,status,variantId,productId);
    const after = { id:variantId,productId,variantSku:before.variant_sku,sizeLabel:variant.size,colorLabel:variant.color,pricePaisa:variant.price,
      stockOnHand:Number(before.stock_on_hand),stockReserved:Number(before.stock_reserved),status };
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES ('admin',?,'product.variant.update','product_variant',?,?,?,?,?)`, actor.id||null,String(variantId),JSON.stringify(before),JSON.stringify(after),
      String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return after;
  } catch (err) {
    try { sqlite.rawDb.exec('ROLLBACK'); } catch (_e) {}
    throw err;
  }
}

async function createProduct(input, actor = {}) {
  const product = {
    sku: cleanText(input.sku || input.code, 64, 'SKU', true),
    barcode: cleanText(input.barcode, 64, 'Barcode'),
    nameBn: cleanText(input.name_bn || input.name, 255, 'Bangla product name', true),
    nameEn: cleanText(input.name_en, 255, 'English product name'),
    slug: slugify(input.slug || input.name_en || input.name_bn || input.name),
    type: cleanText(input.product_type || 'grocery', 32, 'Product type', true),
    categoryId: input.category_id ? positiveId(input.category_id, 'Category') : null,
    subcategoryId: input.subcategory_id ? positiveId(input.subcategory_id, 'Subcategory') : null,
    childcategoryId: input.childcategory_id ? positiveId(input.childcategory_id, 'Child category') : null,
    brandId: input.brand_id ? positiveId(input.brand_id, 'Brand') : null,
    unit: cleanText(input.unit_label || input.unit || '1 pc', 50, 'Unit', true),
    regular: toPaisa(input.regular_price_bdt ?? input.old_price ?? '0', 'Regular price'),
    sale: toPaisa(input.sale_price_bdt ?? input.new_price ?? '0', 'Sale price'),
    cost: toPaisa(input.cost_price_bdt ?? input.purchase_price ?? '0', 'Cost price'),
    wholesale: toPaisa(input.wholesale_price_bdt ?? '0', 'Wholesale price'),
    minQty: positiveInteger(input.wholesale_min_qty ?? 0, 'Wholesale minimum quantity', true),
    threshold: positiveInteger(input.low_stock_threshold ?? 0, 'Low-stock threshold', true),
    image: cleanText(input.image_url, 500, 'Image URL'),
    shortBn: cleanText(input.short_desc_bn || input.short_desc, 2000, 'Short description'),
    shortEn: cleanText(input.short_desc_en, 2000, 'English short description'),
    descriptionBn: cleanText(input.description_bn || input.description, 20000, 'Description'),
    descriptionEn: cleanText(input.description_en, 20000, 'English description'),
  };
  if (product.sale > product.regular && product.regular > 0) throw new ValidationError('Sale price cannot exceed regular price.');
  if (product.wholesale > 0 && (!product.minQty || product.wholesale >= (product.sale || product.regular))) throw new ValidationError('Wholesale price requires a minimum quantity and must be lower than selling price.');
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    const out = await withTransaction(async (tx) => {
      await validateTaxonomyRelations(product, tx);
      if (product.brandId) {
        const brand = await tx.queryOne('SELECT id FROM brands WHERE id=? AND status=1 FOR UPDATE', [product.brandId]);
        if (!brand) throw new ValidationError('Selected brand does not exist or is inactive.');
      }
      const result = await tx.execute(`INSERT INTO products (sku, barcode, slug, product_type, name_bn, name_en, category_id, subcategory_id, childcategory_id, brand_id,
        regular_price_paisa, sale_price_paisa, cost_price_paisa, wholesale_price_paisa, wholesale_min_qty, low_stock_threshold,
        unit_label, image_url, short_desc_bn, short_desc_en, description_bn, description_en, approval_status, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1)`,
        [product.sku, product.barcode || null, product.slug, product.type, product.nameBn, product.nameEn, product.categoryId, product.subcategoryId, product.childcategoryId, product.brandId,
          product.regular, product.sale, product.cost, product.wholesale, product.minQty, product.threshold, product.unit,
          product.image, product.shortBn, product.shortEn, product.descriptionBn, product.descriptionEn]);
      if (input.opening_stock !== undefined && String(input.opening_stock).trim() !== '') {
        const qty = positiveInteger(input.opening_stock, 'Opening stock', true);
        if (qty > 0) {
          await tx.execute('UPDATE products SET stock_on_hand=? WHERE id=?', [qty, result.insertId]);
          await tx.execute(`INSERT INTO stock_ledger (product_id,stock_pool,movement_type,qty_delta,balance_after,unit_cost_paisa,reference_type,reference_id,reason,actor_user_id)
            VALUES (?,'warehouse','opening',?,?,?,'product',?,'Initial opening stock',?)`, [result.insertId, qty, qty, product.cost, result.insertId, actor.id || null]);
        }
      }
      return { id: result.insertId, product };
    }, { pool });
    await recordAuditLog({ actorType: 'admin', actorId: actor.id || null, action: 'product.create', entityType: 'product', entityId: out.id, afterState: product, ipAddress: actor.ip || '', userAgent: actor.userAgent || '' });
    return out;
  }
  if (sqlite.get('SELECT id FROM products WHERE code=?', product.sku)) throw new AppError('DUPLICATE_SKU', 'SKU already exists.', 409);
  await validateTaxonomyRelations(product);
  const result = sqlite.run(`INSERT INTO products (code, barcode, slug, product_type, name, name_en, category_id, subcategory_id, childcategory_id, brand_id, old_price, new_price, purchase_price,
    wholesale_price, wholesale_min_qty, low_stock_threshold, unit, image, short_desc, short_desc_en, description, description_en, stock, status, approval_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,'approved')`, product.sku, product.barcode || null, product.slug, product.type, product.nameBn, product.nameEn,
    product.categoryId || 1, product.subcategoryId, product.childcategoryId, product.brandId || null, product.regular / 100, product.sale / 100, product.cost / 100, product.wholesale / 100,
    product.minQty, product.threshold, product.unit, product.image, product.shortBn, product.shortEn, product.descriptionBn, product.descriptionEn);
  const id = Number(result.lastInsertRowid);
  if (input.opening_stock !== undefined && String(input.opening_stock).trim() !== '') {
    const qty = positiveInteger(input.opening_stock, 'Opening stock', true);
    if (qty > 0) {
      sqlite.run('UPDATE products SET stock=? WHERE id=?', qty, id);
      sqlite.run(`INSERT INTO stock_ledger (product_id,stock_pool,movement_type,qty_delta,balance_after,unit_cost,reference_type,reference_id,reason,actor_user_id)
        VALUES (?,'warehouse','opening',?,?,?,'product',?,'Initial opening stock',?)`, id, qty, qty, product.cost / 100, id, actor.id || null);
    }
  }
  return { id, product };
}

async function adjustStock(input, actor = {}) {
  const productId = positiveId(input.product_id, 'Product');
  const delta = Number(input.qty_delta);
  if (!Number.isSafeInteger(delta) || delta === 0) throw new ValidationError('Stock movement must be a non-zero whole number.');
  if (!['warehouse', 'vendor'].includes(input.stock_pool || 'warehouse')) throw new ValidationError('Stock pool must be warehouse or vendor.');
  const poolName = input.stock_pool === 'vendor' ? 'vendor' : 'warehouse';
  const reason = cleanText(input.reason, 255, 'Reason', true);
  if (isMysql()) {
    const { adjustProductStockAtomically } = require('./inventoryFoundationRepository');
    const pool = require('../db/mysqlPool').getPool();
    return withTransaction(async (tx) => {
      const movement = await adjustProductStockAtomically({ productId, stockPool: poolName, movementType: 'adjustment', qtyDelta: delta, reason, actorUserId: actor.id || null, existingTx: tx });
      await recordAuditLog({ actorType: 'admin', actorId: actor.id || null, action: 'inventory.adjust', entityType: 'product', entityId: productId, afterState: { ...movement, reason }, ipAddress: actor.ip || '', userAgent: actor.userAgent || '' }, tx);
      return movement;
    }, { pool });
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const col = poolName === 'warehouse' ? 'stock' : 'vendor_stock_on_hand';
    const product = sqlite.get(`SELECT id,${col} AS balance FROM products WHERE id=?`, productId);
    if (!product) throw new NotFoundError('Product not found.');
    const next = Number(product.balance || 0) + delta;
    if (next < 0) throw new AppError('INSUFFICIENT_STOCK', 'Adjustment would make stock negative.', 409);
    sqlite.run(`UPDATE products SET ${col}=? WHERE id=?`, next, productId);
    sqlite.run(`INSERT INTO stock_ledger (product_id,stock_pool,movement_type,qty_delta,balance_after,reason,actor_user_id)
      VALUES (?,?,'adjustment',?,?,?,?)`, productId, poolName, delta, next, reason, actor.id || null);
    const movement = { productId, stockPool: poolName, previousBalance: Number(product.balance || 0), qtyDelta: delta, balanceAfter: next };
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent)
      VALUES ('admin',?,'inventory.adjust','product',?,?,?,?)`, actor.id || null, String(productId), JSON.stringify({ ...movement, reason }), String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return movement;
  } catch (err) {
    try { sqlite.rawDb.exec('ROLLBACK'); } catch (_e) {}
    throw err;
  }
}

async function adjustVariantStock(productIdInput, variantIdInput, input, actor = {}) {
  const productId=positiveId(productIdInput,'Product');
  const variantId=positiveId(variantIdInput,'Variant');
  const delta=Number(input.qty_delta);
  if(!Number.isSafeInteger(delta)||delta===0)throw new ValidationError('Stock movement must be a non-zero whole number.');
  const reason=cleanText(input.reason,255,'Reason',true);
  if(isMysql()){
    const pool=require('../db/mysqlPool').getPool();
    return withTransaction(async(tx)=>{
      const product=await tx.queryOne('SELECT id,is_archived FROM products WHERE id=? FOR UPDATE',[productId]);
      if(!product)throw new NotFoundError('Product not found.');
      if(Number(product.is_archived))throw new ValidationError('Archived products cannot have variant stock adjustments.');
      const variant=await tx.queryOne('SELECT id,product_id,stock_on_hand,stock_reserved FROM product_variants WHERE id=? AND product_id=? FOR UPDATE',[variantId,productId]);
      if(!variant)throw new NotFoundError('Variant not found for this product.');
      const before=Number(variant.stock_on_hand),reserved=Number(variant.stock_reserved),after=before+delta;
      if(!Number.isSafeInteger(after)||after<reserved)throw new AppError('INSUFFICIENT_STOCK','Adjustment cannot reduce variant stock below its reserved quantity.',409);
      await tx.execute('UPDATE product_variants SET stock_on_hand=? WHERE id=? AND product_id=?',[after,variantId,productId]);
      await tx.execute(`INSERT INTO stock_ledger (product_id,variant_id,stock_pool,movement_type,qty_delta,balance_after,reason,actor_user_id)
        VALUES (?,?,'warehouse','adjustment',?,?,?,?)`,[productId,variantId,delta,after,reason,actor.id||null]);
      const movement={productId,variantId,previousBalance:before,reservedBalance:reserved,qtyDelta:delta,balanceAfter:after,stockPool:'warehouse'};
      await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'inventory.variant.adjust',entityType:'product_variant',entityId:variantId,afterState:{...movement,reason},ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
      return movement;
    },{pool});
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try{
    const product=sqlite.get('SELECT id,is_archived FROM products WHERE id=?',productId);
    if(!product)throw new NotFoundError('Product not found.');
    if(Number(product.is_archived))throw new ValidationError('Archived products cannot have variant stock adjustments.');
    const variant=sqlite.get('SELECT id,product_id,stock_on_hand,stock_reserved FROM product_variants WHERE id=? AND product_id=?',variantId,productId);
    if(!variant)throw new NotFoundError('Variant not found for this product.');
    const before=Number(variant.stock_on_hand),reserved=Number(variant.stock_reserved),after=before+delta;
    if(!Number.isSafeInteger(after)||after<reserved)throw new AppError('INSUFFICIENT_STOCK','Adjustment cannot reduce variant stock below its reserved quantity.',409);
    sqlite.run('UPDATE product_variants SET stock_on_hand=? WHERE id=? AND product_id=?',after,variantId,productId);
    sqlite.run(`INSERT INTO stock_ledger (product_id,variant_id,stock_pool,movement_type,qty_delta,balance_after,reason,actor_user_id)
      VALUES (?,?,'warehouse','adjustment',?,?,?,?)`,productId,variantId,delta,after,reason,actor.id||null);
    const movement={productId,variantId,previousBalance:before,reservedBalance:reserved,qtyDelta:delta,balanceAfter:after,stockPool:'warehouse'};
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent)
      VALUES ('admin',?,'inventory.variant.adjust','product_variant',?,?,?,?)`,actor.id||null,String(variantId),JSON.stringify({...movement,reason}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return movement;
  }catch(err){try{sqlite.rawDb.exec('ROLLBACK');}catch(_e){}throw err;}
}

async function getInventorySummary() {
  const mysql=isMysql();
  const productSql=mysql
    ? `SELECT COUNT(*) AS product_count,
        COALESCE(SUM(p.stock_on_hand),0) AS warehouse_on_hand,
        COALESCE(SUM(p.stock_reserved),0) AS warehouse_reserved,
        COALESCE(SUM(p.stock_on_hand-p.stock_reserved),0) AS warehouse_available,
        COALESCE(SUM(p.vendor_stock_on_hand),0) AS vendor_on_hand,
        COALESCE(SUM(p.vendor_stock_reserved),0) AS vendor_reserved,
        COALESCE(SUM(p.vendor_stock_on_hand-p.vendor_stock_reserved),0) AS vendor_available,
        COALESCE(SUM(CASE WHEN p.stock_on_hand-p.stock_reserved<=p.low_stock_threshold THEN 1 ELSE 0 END),0) AS low_stock_products,
        COALESCE(SUM(CASE WHEN p.stock_on_hand-p.stock_reserved<=0 THEN 1 ELSE 0 END),0) AS no_available_products
      FROM products p WHERE p.is_archived=0`
    : `SELECT COUNT(*) AS product_count,
        COALESCE(SUM(p.stock),0) AS warehouse_on_hand,
        COALESCE(SUM(p.stock_reserved),0) AS warehouse_reserved,
        COALESCE(SUM(p.stock-p.stock_reserved),0) AS warehouse_available,
        COALESCE(SUM(p.vendor_stock_on_hand),0) AS vendor_on_hand,
        COALESCE(SUM(p.vendor_stock_reserved),0) AS vendor_reserved,
        COALESCE(SUM(p.vendor_stock_on_hand-p.vendor_stock_reserved),0) AS vendor_available,
        COALESCE(SUM(CASE WHEN p.stock-p.stock_reserved<=p.low_stock_threshold THEN 1 ELSE 0 END),0) AS low_stock_products,
        COALESCE(SUM(CASE WHEN p.stock-p.stock_reserved<=0 THEN 1 ELSE 0 END),0) AS no_available_products
      FROM products p WHERE p.is_archived=0`;
  const variantSql=`SELECT COUNT(*) AS variant_count,
      COALESCE(SUM(CASE WHEN v.status=1 THEN 1 ELSE 0 END),0) AS active_variant_count,
      COALESCE(SUM(CASE WHEN v.status=0 THEN 1 ELSE 0 END),0) AS inactive_variant_count,
      COALESCE(SUM(v.stock_on_hand),0) AS warehouse_on_hand,
      COALESCE(SUM(v.stock_reserved),0) AS warehouse_reserved,
      COALESCE(SUM(v.stock_on_hand-v.stock_reserved),0) AS warehouse_available,
      COALESCE(SUM(CASE WHEN v.stock_on_hand-v.stock_reserved<=0 THEN 1 ELSE 0 END),0) AS no_available_variants
    FROM product_variants v JOIN products p ON p.id=v.product_id
    WHERE p.is_archived=0`;
  const [productRows,variantRows]=mysql
    ? await Promise.all([require('../db/mysqlPool').queryOne(productSql),require('../db/mysqlPool').queryOne(variantSql)])
    : [sqlite.get(productSql),sqlite.get(variantSql)];
  const numeric=(row,keys)=>Object.fromEntries(keys.map((key)=>[key,Number(row[key]||0)]));
  return {
    products:numeric(productRows,['product_count','warehouse_on_hand','warehouse_reserved','warehouse_available','vendor_on_hand','vendor_reserved','vendor_available','low_stock_products','no_available_products']),
    variants:numeric(variantRows,['variant_count','active_variant_count','inactive_variant_count','warehouse_on_hand','warehouse_reserved','warehouse_available','no_available_variants']),
  };
}

async function listInventory() {
  if (isMysql()) return require('../db/mysqlPool').queryAll(`SELECT p.id,p.sku,p.name_bn,p.name_en,p.unit_label,p.low_stock_threshold,
    p.stock_on_hand,p.stock_reserved,(p.stock_on_hand-p.stock_reserved) AS warehouse_available,
    p.vendor_stock_on_hand,p.vendor_stock_reserved,(p.vendor_stock_on_hand-p.vendor_stock_reserved) AS vendor_available
    FROM products p WHERE p.is_archived=0 ORDER BY p.id DESC LIMIT 1000`);
  return sqlite.all(`SELECT p.id,p.code AS sku,p.name AS name_bn,p.name_en,p.unit AS unit_label,p.low_stock_threshold,
    p.stock AS stock_on_hand,p.stock_reserved,(p.stock-p.stock_reserved) AS warehouse_available,
    p.vendor_stock_on_hand,p.vendor_stock_reserved,(p.vendor_stock_on_hand-p.vendor_stock_reserved) AS vendor_available
    FROM products p WHERE p.is_archived=0 ORDER BY p.id DESC LIMIT 1000`);
}

async function listStockLedger(filters = {}) {
  const input = filters && typeof filters === 'object' ? filters : { ledger_product_id: filters };
  const rawProductId = String(input.ledger_product_id ?? input.product_id ?? '').trim();
  const productId = rawProductId ? positiveId(rawProductId, 'Product') : null;
  const pageSize = 25;
  const requested = Number.parseInt(input.ledger_page ?? input.page, 10);
  const requestedPage = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 100000) : 1;
  const mysql = isMysql();
  const where = productId ? 'WHERE sl.product_id=?' : '';
  const params = productId ? [productId] : [];
  const countSql = `SELECT COUNT(*) AS total FROM stock_ledger sl ${where}`;
  const total = mysql
    ? Number((await require('../db/mysqlPool').queryOne(countSql, params)).total)
    : Number(sqlite.get(countSql, ...params).total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const sql = `SELECT sl.id,sl.product_id,sl.variant_id,sl.stock_pool,sl.movement_type,sl.qty_delta,
      sl.balance_after,sl.reference_type,sl.reference_id,sl.reason,sl.created_at,
      ${mysql ? 'p.sku' : 'p.code'} AS sku,${mysql ? 'p.name_bn' : 'p.name'} AS name_bn,${mysql ? 'p.name_en' : 'p.name'} AS name_en,
      v.variant_sku,v.size_label,v.color_label
    FROM stock_ledger sl
    JOIN products p ON p.id=sl.product_id
    LEFT JOIN product_variants v ON v.id=sl.variant_id
    ${where}
    ORDER BY sl.id DESC LIMIT ? OFFSET ?`;
  const values = [...params, pageSize, (page - 1) * pageSize];
  const rows = mysql
    ? await require('../db/mysqlPool').queryAll(sql, values)
    : sqlite.all(sql, ...values);
  return { rows, total, page, pageSize, totalPages, productId, hasPrevious: page > 1, hasNext: page < totalPages };
}

async function createPurchase(input, actor = {}) {
  const supplierId = positiveId(input.supplier_id, 'Supplier');
  let lines;
  try { lines = typeof input.lines === 'string' ? JSON.parse(input.lines) : input.lines; } catch (_e) { throw new ValidationError('Purchase lines must be valid JSON.'); }
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100) throw new ValidationError('A purchase must contain between 1 and 100 product lines.');
  const cooked = lines.map((line) => ({
    productId: positiveId(line.product_id, 'Product'),
    qty: positiveInteger(line.ordered_qty, 'Ordered quantity'),
    unitCost: toPaisa(line.unit_cost_bdt ?? line.unit_cost ?? '0', 'Unit cost', false),
  }));
  const subtotal = cooked.reduce((sum, line) => sum + line.qty * line.unitCost, 0);
  if (!Number.isSafeInteger(subtotal)) throw new ValidationError('Purchase total exceeds supported integer range.');
  const discount = toPaisa(input.discount_bdt ?? '0', 'Discount');
  const charge = toPaisa(input.shipping_charge_bdt ?? '0', 'Shipping charge');
  if (discount > subtotal + charge) throw new ValidationError('Discount cannot exceed purchase subtotal and charges.');
  const total = subtotal + charge - discount;
  if (!Number.isSafeInteger(total)) throw new ValidationError('Purchase total exceeds supported integer range.');
  const paidPaisa = toPaisa(input.paid_amount_bdt ?? '0', 'Paid amount');
  if (paidPaisa > total) throw new ValidationError('Paid amount cannot exceed the server-calculated purchase total.');
  const ref = cleanText(input.reference_no, 64, 'Reference number') || `PO-${require('crypto').randomUUID().slice(0, 12).toUpperCase()}`;
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    const result = await withTransaction(async (tx) => {
      const supplier = await tx.queryOne('SELECT id FROM suppliers WHERE id=? AND status=1 FOR UPDATE', [supplierId]);
      if (!supplier) throw new NotFoundError('Active supplier not found.');
      const po = await tx.execute(`INSERT INTO purchases (reference_no,supplier_id,subtotal_paisa,discount_paisa,shipping_charge_paisa,total_cost_paisa,paid_amount_paisa,receive_status,purchase_date,note,created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`, [ref,supplierId,subtotal,discount,charge,total,paidPaisa, input.purchase_date || new Date().toISOString().slice(0,10), cleanText(input.note,255,'Note'),actor.id || null]);
      for (const line of cooked) {
        const product = await tx.queryOne('SELECT id FROM products WHERE id=? AND is_archived=0 FOR UPDATE', [line.productId]);
        if (!product) throw new NotFoundError(`Product #${line.productId} not found or archived.`);
        await tx.execute('INSERT INTO purchase_items (purchase_id,product_id,ordered_qty,unit_cost_paisa,line_total_paisa) VALUES (?,?,?,?,?)', [po.insertId,line.productId,line.qty,line.unitCost,line.qty*line.unitCost]);
      }
      const result={ id: po.insertId, referenceNo: ref, totalPaisa: total, status: 'draft' };
      await recordAuditLog({ actorType:'admin',actorId:actor.id||null,action:'purchase.create',entityType:'purchase',entityId:result.id,afterState:{supplierId,lines:cooked,totalPaisa:total},ipAddress:actor.ip||'',userAgent:actor.userAgent||'' },tx);
      return result;
    }, { pool });
    return result;
  }
  const supplier = sqlite.get('SELECT id FROM suppliers WHERE id=? AND status=1', supplierId);
  if (!supplier) throw new NotFoundError('Active supplier not found.');
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const [paid, date, note] = [paidPaisa/100,input.purchase_date || new Date().toISOString().slice(0,10),cleanText(input.note,255,'Note')];
    const firstLine = cooked[0];
    const po = sqlite.run(`INSERT INTO purchases (reference_no,supplier_id,product_id,qty,unit_cost,total_cost,subtotal,discount,shipping_charge,paid_amount,status,purchase_date,note)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'draft',?,?)`,ref,supplierId,firstLine.productId,firstLine.qty,firstLine.unitCost/100,total/100,subtotal/100,discount/100,charge/100,paid,date,note);
    for (const line of cooked) {
      if (!sqlite.get('SELECT id FROM products WHERE id=? AND is_archived=0', line.productId)) throw new NotFoundError(`Product #${line.productId} not found or archived.`);
      sqlite.run('INSERT INTO purchase_items (purchase_id,product_id,ordered_qty,unit_cost,line_total) VALUES (?,?,?,?,?)',Number(po.lastInsertRowid),line.productId,line.qty,line.unitCost/100,line.qty*line.unitCost/100);
    }
    const result={id:Number(po.lastInsertRowid),referenceNo:ref,totalPaisa:total,status:'draft'};
    sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent)
      VALUES ('admin',?,'purchase.create','purchase',?,?,?,?)`,actor.id||null,String(result.id),JSON.stringify({supplierId,lines:cooked,totalPaisa:total}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return result;
  } catch (err) { try{sqlite.rawDb.exec('ROLLBACK');}catch(_e){} throw err; }
}

async function listPurchases() {
  if (isMysql()) return require('../db/mysqlPool').queryAll(`SELECT p.*,s.name AS supplier_name,
    COUNT(DISTINCT pi.id) AS line_count,COALESCE(SUM(pi.ordered_qty-pi.received_qty),0) AS outstanding_qty
    FROM purchases p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN purchase_items pi ON pi.purchase_id=p.id
    GROUP BY p.id ORDER BY p.id DESC LIMIT 500`);
  return sqlite.all(`SELECT p.*,s.name AS supplier_name,COUNT(DISTINCT pi.id) AS line_count,
    COALESCE(SUM(pi.ordered_qty-pi.received_qty),0) AS outstanding_qty FROM purchases p JOIN suppliers s ON s.id=p.supplier_id
    LEFT JOIN purchase_items pi ON pi.purchase_id=p.id GROUP BY p.id ORDER BY p.id DESC LIMIT 500`);
}

async function receivePurchase(purchaseIdInput, input, actor = {}) {
  const purchaseId = positiveId(purchaseIdInput, 'Purchase');
  const idem = cleanText(input.idempotency_key, 128, 'Idempotency key', true);
  let lines;
  try { lines = typeof input.lines === 'string' ? JSON.parse(input.lines) : input.lines; } catch (_e) { throw new ValidationError('Receipt lines must be valid JSON.'); }
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100) throw new ValidationError('A receipt must contain between 1 and 100 lines.');
  const received = lines.map((x) => ({ itemId:positiveId(x.purchase_item_id,'Purchase item'), qty:positiveInteger(x.received_qty,'Received quantity') }));
  const requestHash = require('crypto').createHash('sha256').update(JSON.stringify({ purchaseId, received })).digest('hex');
  if (isMysql()) {
    const pool = require('../db/mysqlPool').getPool();
    const result = await withTransaction(async (tx) => {
      const po = await tx.queryOne('SELECT * FROM purchases WHERE id=? FOR UPDATE',[purchaseId]);
      if (!po) throw new NotFoundError('Purchase order not found.');
      const exists = await tx.queryOne('SELECT id,request_hash FROM purchase_receipts WHERE idempotency_key=? FOR UPDATE',[idem]);
      if (exists) {
        if (exists.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH','Receipt idempotency key was reused with different receipt lines.',409);
        const replayResult={id:exists.id,supplierId:Number(po.supplier_id),replayed:true};
        await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'purchase.receive',entityType:'purchase',entityId:purchaseId,afterState:replayResult,ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
        return replayResult;
      }
      if (['cancelled','received'].includes(po.receive_status)) throw new AppError('PURCHASE_STATE_INVALID','Purchase is cancelled or fully received.',409);
      let totalQty=0,totalValue=0;
      for (const line of received) {
        const item = await tx.queryOne('SELECT * FROM purchase_items WHERE id=? AND purchase_id=? FOR UPDATE',[line.itemId,purchaseId]);
        if (!item) throw new NotFoundError('Purchase line not found.');
        if (line.qty > Number(item.ordered_qty)-Number(item.received_qty)) throw new AppError('RECEIPT_EXCEEDS_REMAINING','Received quantity exceeds remaining ordered quantity.',409);
        const product = await tx.queryOne('SELECT id,stock_on_hand,cost_price_paisa FROM products WHERE id=? FOR UPDATE',[item.product_id]);
        if (!product) throw new NotFoundError('Product not found.');
        const current=Number(product.stock_on_hand), next=current+line.qty;
        if (!Number.isSafeInteger(next)) throw new ValidationError('Stock quantity exceeds supported integer range.');
        const oldCost=Number(product.cost_price_paisa||0), unitCost=Number(item.unit_cost_paisa||0);
        const average=current+line.qty>0?Math.round((current*oldCost+line.qty*unitCost)/(current+line.qty)):unitCost;
        await tx.execute('UPDATE products SET stock_on_hand=?,cost_price_paisa=? WHERE id=?',[next,average,product.id]);
        await tx.execute('UPDATE purchase_items SET received_qty=received_qty+? WHERE id=?',[line.qty,item.id]);
        await tx.execute(`INSERT INTO stock_ledger (product_id,stock_pool,movement_type,qty_delta,balance_after,unit_cost_paisa,reference_type,reference_id,reason,actor_user_id)
          VALUES (?,'warehouse','purchase_receipt',?,?,?,'purchase',?,?,?)`,[product.id,line.qty,next,unitCost,purchaseId,`Receipt for ${po.reference_no}`,actor.id||null]);
        totalQty+=line.qty; totalValue+=line.qty*unitCost;
      }
      const remaining = await tx.queryOne('SELECT COALESCE(SUM(ordered_qty-received_qty),0) AS qty FROM purchase_items WHERE purchase_id=?',[purchaseId]);
      const status=Number(remaining.qty)===0?'received':'partially_received';
      await tx.execute('UPDATE purchases SET receive_status=? WHERE id=?',[status,purchaseId]);
      const receiptNo=`RCV-${require('crypto').randomUUID().slice(0,12).toUpperCase()}`;
      const r=await tx.execute(`INSERT INTO purchase_receipts (purchase_id,receipt_no,idempotency_key,request_hash,event_type,total_qty,total_value_paisa,note,received_by_user_id)
        VALUES (?,?,?,?,'receipt',?,?,?,?)`,[purchaseId,receiptNo,idem,requestHash,totalQty,totalValue,cleanText(input.note,255,'Receipt note'),actor.id||null]);
      const result={id:r.insertId,receiptNo,totalQty,totalValuePaisa:totalValue,status,supplierId:Number(po.supplier_id),replayed:false};
      await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'purchase.receive',entityType:'purchase',entityId:purchaseId,afterState:result,ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
      return result;
    },{pool});
    return result;
  }
  const auditReceipt=(result)=>sqlite.run(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent)
    VALUES ('admin',?,'purchase.receive','purchase',?,?,?,?)`,actor.id||null,String(purchaseId),JSON.stringify(result),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const po=sqlite.get('SELECT * FROM purchases WHERE id=?',purchaseId);
    if(!po) throw new NotFoundError('Purchase order not found.');
    const prior=sqlite.get('SELECT * FROM purchase_receipts WHERE idempotency_key=?',idem);
    if(prior){
      if(prior.request_hash!==requestHash) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH','Receipt idempotency key was reused with different receipt lines.',409);
      const replayResult={id:prior.id,supplierId:Number(po.supplier_id),replayed:true};
      auditReceipt(replayResult);
      sqlite.rawDb.exec('COMMIT');return replayResult;
    }
    if(['cancelled','received'].includes(po.status)) throw new AppError('PURCHASE_STATE_INVALID','Purchase is cancelled or fully received.',409);
    let totalQty=0,totalValue=0;
    for(const line of received){
      const item=sqlite.get('SELECT * FROM purchase_items WHERE id=? AND purchase_id=?',line.itemId,purchaseId);
      if(!item) throw new NotFoundError('Purchase line not found.');
      if(line.qty>Number(item.ordered_qty)-Number(item.received_qty)+Number(item.returned_qty||0)) throw new AppError('RECEIPT_EXCEEDS_REMAINING','Received quantity exceeds remaining ordered quantity.',409);
      const product=sqlite.get('SELECT id,stock,purchase_price FROM products WHERE id=?',item.product_id);
      if(!product) throw new NotFoundError('Product not found.');
      const next=Number(product.stock||0)+line.qty;
      const old=Number(product.stock||0),unit=Number(item.unit_cost||0);
      const average=next?((old*Number(product.purchase_price||0)+line.qty*unit)/next):unit;
      sqlite.run('UPDATE products SET stock=?,purchase_price=? WHERE id=?',next,average,product.id);
      sqlite.run('UPDATE purchase_items SET received_qty=received_qty+? WHERE id=?',line.qty,item.id);
      sqlite.run(`INSERT INTO stock_ledger (product_id,stock_pool,movement_type,qty_delta,balance_after,unit_cost,reference_type,reference_id,reason,actor_user_id)
        VALUES (?,'warehouse','purchase_receipt',?,?,?,'purchase',?,?,?)`,product.id,line.qty,next,unit,purchaseId,`Receipt for ${po.reference_no}`,actor.id||null);
      totalQty+=line.qty;totalValue+=line.qty*unit;
    }
    const remain=sqlite.get('SELECT COALESCE(SUM(ordered_qty-received_qty),0) AS qty FROM purchase_items WHERE purchase_id=?',purchaseId);
    const status=Number(remain.qty)===0?'received':'partially_received';
    sqlite.run('UPDATE purchases SET status=? WHERE id=?',status,purchaseId);
    const receiptNo=`RCV-${require('crypto').randomUUID().slice(0,12).toUpperCase()}`;
    const r=sqlite.run(`INSERT INTO purchase_receipts (purchase_id,receipt_no,idempotency_key,request_hash,event_type,total_qty,total_value,note,received_by_user_id)
      VALUES (?,?,?,?,'receipt',?,?,?,?)`,purchaseId,receiptNo,idem,requestHash,totalQty,totalValue,cleanText(input.note,255,'Receipt note'),actor.id||null);
    const result={id:Number(r.lastInsertRowid),receiptNo,totalQty,totalValuePaisa:Math.round(totalValue*100),status,supplierId:Number(po.supplier_id),replayed:false};
    auditReceipt(result);
    sqlite.rawDb.exec('COMMIT');
    return result;
  }catch(err){try{sqlite.rawDb.exec('ROLLBACK');}catch(_e){}throw err;}
}

async function archiveProduct(idInput, archive, actor = {}) {
  const id=positiveId(idInput,'Product');
  if(isMysql()){
    const pool=require('../db/mysqlPool').getPool();
    const result=await withTransaction(async(tx)=>{
      const product=await tx.queryOne('SELECT id,is_archived FROM products WHERE id=? FOR UPDATE',[id]);
      if(!product) throw new NotFoundError('Product not found.');
      await tx.execute('UPDATE products SET is_archived=?,status=? WHERE id=?',[archive?1:0,archive?0:1,id]);
      return {id,archived:Boolean(archive)};
    },{pool});
    await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:archive?'product.archive':'product.restore',entityType:'product',entityId:id,afterState:result,ipAddress:actor.ip||'',userAgent:actor.userAgent||''});
    return result;
  }
  const product=sqlite.get('SELECT id,is_archived FROM products WHERE id=?',id);
  if(!product) throw new NotFoundError('Product not found.');
  sqlite.run('UPDATE products SET is_archived=?,status=? WHERE id=?',archive?1:0,archive?0:1,id);
  sqlite.run('INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?,?)', 'admin',actor.id||null,archive?'product.archive':'product.restore','product',String(id),JSON.stringify({archived:Boolean(archive)}));
  return {id,archived:Boolean(archive)};
}

module.exports = { createSupplier,listSuppliers,getSupplierForEdit,updateSupplier,getSupplierPurchaseHistory,createProduct,normalizeProductEditInput,listProducts,getProductForEdit,listProductEditOptions,updateProduct,getProductGalleryForEdit,updateProductGallery,appendProductGalleryImages,listProductVariants,createProductVariant,updateProductVariant,adjustStock,adjustVariantStock,listInventory,getInventorySummary,listInventoryPage,listStockLedger,createPurchase,listPurchases,receivePurchase,archiveProduct };
