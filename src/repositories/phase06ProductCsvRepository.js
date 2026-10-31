'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const sqlite = require('../db/database');
const { withTransaction } = require('../db/mysqlPool');
const { recordAuditLog } = require('./auditLogRepository');
const { normalizeProductEditInput } = require('./phase06Repository');
const { AppError, ValidationError } = require('../utils/errors');
const { paisaToBdtString } = require('../utils/money');
const {
  PRODUCT_CSV_COLUMNS, MAX_PRODUCT_CSV_ROWS, MAX_PRODUCT_CSV_BYTES, MAX_PRODUCT_EXPORT_ROWS,
  parseCsv, serializeCsv, decodeSpreadsheetSafeValue,
} = require('../utils/productCsv');

function isMysql() { return env.db.client === 'mysql'; }
function rowKey(value) { return String(value ?? '').trim().toLowerCase(); }
function placeholders(values) { return values.map(() => '?').join(','); }

function dbClient() {
  if (isMysql()) return require('../db/mysqlPool');
  return {
    queryAll: async (sql, params = []) => sqlite.all(sql, ...params),
    queryOne: async (sql, params = []) => sqlite.get(sql, ...params),
  };
}

function currentProductSql(lock = false) {
  if (isMysql()) return `SELECT id,sku,barcode,slug,product_type,name_bn,name_en,category_id,brand_id,regular_price_paisa,sale_price_paisa,
    cost_price_paisa,wholesale_price_paisa,wholesale_min_qty,low_stock_threshold,unit_label,is_archived,status FROM products WHERE sku=?${lock ? ' FOR UPDATE' : ''}`;
  return `SELECT id,code AS sku,barcode,slug,product_type,name AS name_bn,name_en,category_id,brand_id,
    ROUND(old_price*100) AS regular_price_paisa,ROUND(new_price*100) AS sale_price_paisa,ROUND(purchase_price*100) AS cost_price_paisa,
    ROUND(wholesale_price*100) AS wholesale_price_paisa,wholesale_min_qty,low_stock_threshold,unit AS unit_label,is_archived,status
    FROM products WHERE code=?`;
}

function rowError(row, message) {
  if (!row.errors.includes(message)) row.errors.push(message);
}

function parseAndNormalizeCsv(csvText) {
  let records;
  try { records = parseCsv(csvText); }
  catch (err) {
    const rowMatch = String(err.message || '').match(/CSV row (\d+)/i);
    return { rows:[], errors:[{ row:rowMatch ? Number(rowMatch[1]) : 1, errors:[err.message || 'CSV could not be parsed.'] }], totalRows:0 };
  }
  if (!records.length) return { rows:[],errors:[{row:1,errors:['CSV is empty; include the exported header and at least one product row.']}],totalRows:0 };
  const headerRecord = records[0];
  const headers = headerRecord.cells.map((cell) => String(cell).trim());
  const duplicateHeaders = headers.filter((name,index) => headers.indexOf(name) !== index);
  const missing = PRODUCT_CSV_COLUMNS.filter((name) => !headers.includes(name));
  const extra = headers.filter((name) => !PRODUCT_CSV_COLUMNS.includes(name));
  if (duplicateHeaders.length || missing.length || extra.length) {
    const errors = [];
    if (duplicateHeaders.length) errors.push('Header names must be unique.');
    if (missing.length) errors.push(`Required columns are missing: ${missing.join(', ')}.`);
    if (extra.length) errors.push(`Unsupported columns are present: ${extra.join(', ')}.`);
    return { rows:[],errors:[{row:headerRecord.line,errors}],totalRows:0 };
  }
  const columnIndex = new Map(headers.map((name,index) => [name,index]));
  const dataRecords = records.slice(1);
  if (!dataRecords.length) return { rows:[],errors:[{row:headerRecord.line,errors:['CSV must contain at least one product data row.']}],totalRows:0 };
  if (dataRecords.length > MAX_PRODUCT_CSV_ROWS) {
    return { rows:[],errors:[{row:dataRecords[MAX_PRODUCT_CSV_ROWS].line,errors:[`A single import is limited to ${MAX_PRODUCT_CSV_ROWS} product rows.`]}],totalRows:dataRecords.length };
  }

  const rows = dataRecords.map((record) => ({ line:record.line, cells:record.cells, sku:'', barcode:'', product:null, errors:[] }));
  for (const row of rows) {
    if (row.cells.length !== headers.length) {
      rowError(row, `Expected ${headers.length} columns but found ${row.cells.length}.`);
      continue;
    }
    const values = Object.fromEntries(headers.map((header,index) => [header,decodeSpreadsheetSafeValue(row.cells[index])]));
    row.sku = String(values.sku || '').trim();
    row.barcode = String(values.barcode || '').trim();
    if (!row.sku) rowError(row,'SKU is required and is used only to locate an existing product.');
    else if (row.sku.length > 64) rowError(row,'SKU exceeds the existing 64-character limit.');
    if (row.barcode.length > 64) rowError(row,'Barcode exceeds the existing 64-character limit.');
    try {
      row.product = normalizeProductEditInput({
        name_bn:values.name_bn,name_en:values.name_en,slug:values.slug,product_type:values.product_type,
        category_id:values.category_id,brand_id:values.brand_id,unit_label:values.unit_label,
        regular_price_bdt:values.regular_price_bdt,sale_price_bdt:values.sale_price_bdt,cost_price_bdt:values.cost_price_bdt,
        wholesale_price_bdt:values.wholesale_price_bdt,wholesale_min_qty:values.wholesale_min_qty,low_stock_threshold:values.low_stock_threshold,
        short_desc_bn:values.short_desc_bn,short_desc_en:values.short_desc_en,description_bn:values.description_bn,description_en:values.description_en,
      });
    } catch (err) {
      rowError(row,err.message || 'Product fields are invalid.');
    }
  }

  for (const [property,label] of [['sku','SKU'],['barcode','Barcode']]) {
    const grouped = new Map();
    for (const row of rows) {
      const value = rowKey(row[property]);
      if (!value) continue;
      if (!grouped.has(value)) grouped.set(value,[]);
      grouped.get(value).push(row);
    }
    for (const duplicates of grouped.values()) {
      if (duplicates.length > 1) for (const row of duplicates) rowError(row,`Duplicate ${label} appears in this CSV (also row${duplicates.filter((item)=>item!==row).map((item)=>` ${item.line}`).join(',')}).`);
    }
  }
  const slugs = new Map();
  for (const row of rows) {
    if (!row.product) continue;
    const key = rowKey(row.product.slug);
    if (!slugs.has(key)) slugs.set(key,[]);
    slugs.get(key).push(row);
  }
  for (const duplicates of slugs.values()) if (duplicates.length > 1) for (const row of duplicates) rowError(row,'Slug duplicates another row in this CSV.');

  return { rows,errors:[],totalRows:rows.length };
}

async function validateRows(client, rows, { lock = false } = {}) {
  const sqlLock = lock && isMysql() ? ' FOR UPDATE' : '';
  const withSku = rows.filter((row) => row.product && row.sku && row.sku.length <= 64 && !row.errors.some((error)=>error.startsWith('Duplicate SKU')));
  const matchedIds = new Map();
  for (const row of [...withSku].sort((a,b)=>rowKey(a.sku).localeCompare(rowKey(b.sku)))) {
    const matches = await client.queryAll(currentProductSql(lock),[row.sku]);
    if (!matches.length) { rowError(row,'SKU does not identify an existing product. CSV import updates existing products only.'); continue; }
    if (matches.length > 1) { rowError(row,'SKU is ambiguous in the product table; resolve duplicate SKU records first.'); continue; }
    const product = matches[0];
    if (matchedIds.has(Number(product.id))) {
      rowError(row,'This SKU resolves to a product already matched by another CSV row.');
      rowError(matchedIds.get(Number(product.id)),'A different SKU in this CSV resolves to the same product record.');
    } else matchedIds.set(Number(product.id),row);
    row.current = product;
    if (Number(product.is_archived)) rowError(row,'Archived products cannot be changed by this import.');
    if (String(product.barcode || '') !== row.barcode) rowError(row,'Barcode is read-only and must exactly match the product selected by SKU.');
  }

  const categoryIds = [...new Set(rows.filter((row)=>row.product).map((row)=>row.product.categoryId))];
  const activeCategories = categoryIds.length
    ? await client.queryAll(`SELECT id FROM categories WHERE status=1 AND id IN (${placeholders(categoryIds)})${sqlLock}`,categoryIds)
    : [];
  const activeCategoryIds = new Set(activeCategories.map((row)=>Number(row.id)));
  const brandIds = [...new Set(rows.filter((row)=>row.product&&row.product.brandId).map((row)=>row.product.brandId))];
  const activeBrands = brandIds.length
    ? await client.queryAll(`SELECT id FROM brands WHERE status=1 AND id IN (${placeholders(brandIds)})${sqlLock}`,brandIds)
    : [];
  const activeBrandIds = new Set(activeBrands.map((row)=>Number(row.id)));
  for (const row of rows) {
    if (!row.product) continue;
    if (!activeCategoryIds.has(row.product.categoryId)) rowError(row,'Category ID must refer to an existing active category.');
    if (row.product.brandId && !activeBrandIds.has(row.product.brandId)) rowError(row,'Brand ID must refer to an existing active brand or be blank.');
  }

  for (const row of rows) {
    if (!row.current || !row.product || row.errors.length) continue;
    if (row.barcode) {
      const barcodeRows = await client.queryAll(
        `SELECT id FROM products WHERE barcode=?${sqlLock}`,[row.barcode]
      );
      if (barcodeRows.length > 1) rowError(row,'Barcode is assigned to multiple products and is ambiguous; resolve it before importing.');
      else if (!barcodeRows.length || Number(barcodeRows[0].id) !== Number(row.current.id)) rowError(row,'Barcode does not uniquely belong to the product identified by this SKU.');
    }
    const slugRows = await client.queryAll(
      `SELECT id FROM products WHERE slug=? AND id<>?${sqlLock}`,[row.product.slug,row.current.id]
    );
    if (slugRows.length) rowError(row,'Slug is already assigned to another product.');
  }
  return rows;
}

function publicPreview(rows) {
  return rows.map((row)=>({
    row:row.line,sku:row.sku,slug:row.product?.slug || '',nameBn:row.product?.nameBn || '',
    regularPricePaisa:row.product?.regular ?? null,salePricePaisa:row.product?.sale ?? null,
    errors:row.errors,
  }));
}

function beforeAuditState(row) {
  return {
    sku:row.sku,barcode:String(row.barcode || ''),slug:row.slug,productType:row.product_type,
    nameBn:row.name_bn,nameEn:row.name_en,categoryId:Number(row.category_id),brandId:row.brand_id===null?null:Number(row.brand_id),
    regularPricePaisa:Number(row.regular_price_paisa),salePricePaisa:Number(row.sale_price_paisa),costPricePaisa:Number(row.cost_price_paisa),
    wholesalePricePaisa:Number(row.wholesale_price_paisa),wholesaleMinQty:Number(row.wholesale_min_qty),lowStockThreshold:Number(row.low_stock_threshold),unitLabel:row.unit_label,
  };
}

function afterAuditState(row) {
  const product=row.product;
  return {
    sku:row.sku,slug:product.slug,productType:product.type,nameBn:product.nameBn,nameEn:product.nameEn,categoryId:product.categoryId,brandId:product.brandId,
    regularPricePaisa:product.regular,salePricePaisa:product.sale,costPricePaisa:product.cost,wholesalePricePaisa:product.wholesale,
    wholesaleMinQty:product.minQty,lowStockThreshold:product.threshold,unitLabel:product.unit,shortDescBn:product.shortBn,shortDescEn:product.shortEn,
    descriptionBn:product.descriptionBn,descriptionEn:product.descriptionEn,source:'csv_import',
  };
}

async function previewProductCsv(csvText) {
  const parsed=parseAndNormalizeCsv(csvText);
  if (parsed.errors.length) return {valid:false,totalRows:parsed.totalRows,errors:parsed.errors,rows:[]};
  const rows=await validateRows(dbClient(),parsed.rows);
  const errors=rows.filter((row)=>row.errors.length).map((row)=>({row:row.line,sku:row.sku,errors:row.errors}));
  return {valid:errors.length===0,totalRows:parsed.totalRows,errors,rows:publicPreview(rows)};
}

async function commitProductCsv(csvText, actor = {}) {
  const importId=crypto.randomUUID();
  const parsed=parseAndNormalizeCsv(csvText);
  if (parsed.errors.length) return {committed:false,totalRows:parsed.totalRows,errors:parsed.errors};
  if (isMysql()) {
    const pool=require('../db/mysqlPool').getPool();
    return withTransaction(async(tx)=>{
      const rows=await validateRows(tx,parsed.rows,{lock:true});
      const errors=rows.filter((row)=>row.errors.length).map((row)=>({row:row.line,sku:row.sku,errors:row.errors}));
      if(errors.length)return {committed:false,totalRows:parsed.totalRows,errors};
      let updatedCount=0;
      for(const row of rows){
        const p=row.product;
        await tx.execute(`UPDATE products SET slug=?,product_type=?,name_bn=?,name_en=?,category_id=?,brand_id=?,regular_price_paisa=?,sale_price_paisa=?,
          cost_price_paisa=?,wholesale_price_paisa=?,wholesale_min_qty=?,low_stock_threshold=?,unit_label=?,short_desc_bn=?,short_desc_en=?,description_bn=?,description_en=? WHERE id=?`,
          [p.slug,p.type,p.nameBn,p.nameEn,p.categoryId,p.brandId,p.regular,p.sale,p.cost,p.wholesale,p.minQty,p.threshold,p.unit,p.shortBn,p.shortEn,p.descriptionBn,p.descriptionEn,row.current.id]);
        await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'product.csv_import.update',entityType:'product',entityId:row.current.id,
          beforeState:beforeAuditState(row.current),afterState:afterAuditState(row),ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
        updatedCount+=1;
      }
      await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'product.csv_import.commit',entityType:'product_import',entityId:importId,
        afterState:{updatedCount},ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
      return {committed:true,updatedCount,rows:rows.map((row)=>({row:row.line,sku:row.sku}))};
    },{pool});
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try{
    const rows=await validateRows(dbClient(),parsed.rows,{lock:true});
    const errors=rows.filter((row)=>row.errors.length).map((row)=>({row:row.line,sku:row.sku,errors:row.errors}));
    if(errors.length){sqlite.rawDb.exec('COMMIT');return {committed:false,totalRows:parsed.totalRows,errors};}
    let updatedCount=0;
    for(const row of rows){
      const p=row.product;
      sqlite.run(`UPDATE products SET slug=?,product_type=?,name=?,name_en=?,category_id=?,brand_id=?,old_price=?,new_price=?,purchase_price=?,
        wholesale_price=?,wholesale_min_qty=?,low_stock_threshold=?,unit=?,short_desc=?,short_desc_en=?,description=?,description_en=? WHERE id=?`,
        p.slug,p.type,p.nameBn,p.nameEn,p.categoryId,p.brandId,p.regular/100,p.sale/100,p.cost/100,p.wholesale/100,p.minQty,p.threshold,p.unit,
        p.shortBn,p.shortEn,p.descriptionBn,p.descriptionEn,row.current.id);
      sqlite.run(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
        VALUES('admin',?,'product.csv_import.update','product',?,?,?,?,?)`,actor.id||null,String(row.current.id),JSON.stringify(beforeAuditState(row.current)),JSON.stringify(afterAuditState(row)),
        String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
      updatedCount+=1;
    }
    sqlite.run(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent)
      VALUES('admin',?,'product.csv_import.commit','product_import',?,?,?,?)`,actor.id||null,importId,JSON.stringify({updatedCount}),
      String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255));
    sqlite.rawDb.exec('COMMIT');
    return {committed:true,updatedCount,rows:rows.map((row)=>({row:row.line,sku:row.sku}))};
  }catch(err){try{sqlite.rawDb.exec('ROLLBACK');}catch(_e){}throw err;}
}

async function exportProductsCsv() {
  const client=dbClient();
  const rows=isMysql()
    ? await client.queryAll(`SELECT id,sku,barcode,slug,product_type,name_bn,name_en,category_id,brand_id,regular_price_paisa,sale_price_paisa,cost_price_paisa,
        wholesale_price_paisa,wholesale_min_qty,low_stock_threshold,unit_label,short_desc_bn,short_desc_en,description_bn,description_en
      FROM products WHERE is_archived=0 ORDER BY id LIMIT ?`,[MAX_PRODUCT_EXPORT_ROWS+1])
    : await client.queryAll(`SELECT id,code AS sku,barcode,slug,product_type,name AS name_bn,name_en,category_id,brand_id,ROUND(old_price*100) AS regular_price_paisa,
        ROUND(new_price*100) AS sale_price_paisa,ROUND(purchase_price*100) AS cost_price_paisa,ROUND(wholesale_price*100) AS wholesale_price_paisa,
        wholesale_min_qty,low_stock_threshold,unit AS unit_label,short_desc AS short_desc_bn,short_desc_en,description AS description_bn,description_en
      FROM products WHERE is_archived=0 ORDER BY id LIMIT ?`,[MAX_PRODUCT_EXPORT_ROWS+1]);
  if(rows.length>MAX_PRODUCT_EXPORT_ROWS)throw new AppError('CSV_EXPORT_ROW_LIMIT',`CSV export is limited to ${MAX_PRODUCT_EXPORT_ROWS} products per request.`,413);
  const output=rows.map((row)=>({
    sku:row.sku,barcode:row.barcode||'',name_bn:row.name_bn||'',name_en:row.name_en||'',slug:row.slug||'',product_type:row.product_type||'',
    category_id:row.category_id??'',brand_id:row.brand_id??'',unit_label:row.unit_label||'',regular_price_bdt:paisaToBdtString(Number(row.regular_price_paisa||0)),
    sale_price_bdt:paisaToBdtString(Number(row.sale_price_paisa||0)),cost_price_bdt:paisaToBdtString(Number(row.cost_price_paisa||0)),
    wholesale_price_bdt:paisaToBdtString(Number(row.wholesale_price_paisa||0)),wholesale_min_qty:row.wholesale_min_qty??0,low_stock_threshold:row.low_stock_threshold??0,
    short_desc_bn:row.short_desc_bn||'',short_desc_en:row.short_desc_en||'',description_bn:row.description_bn||'',description_en:row.description_en||'',
  }));
  return {csv:serializeCsv(PRODUCT_CSV_COLUMNS,output),rowCount:rows.length};
}

module.exports={PRODUCT_CSV_COLUMNS,MAX_PRODUCT_CSV_ROWS,MAX_PRODUCT_CSV_BYTES,previewProductCsv,commitProductCsv,exportProductsCsv};
