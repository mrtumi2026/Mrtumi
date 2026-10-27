'use strict';

const { env } = require('../config/env');
const sqlite = require('../db/database');
const { withTransaction } = require('../db/mysqlPool');
const { recordAuditLog } = require('./auditLogRepository');
const { ValidationError, NotFoundError, AppError } = require('../utils/errors');
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
  return cleanText(text, 191, 'Slug', true).toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]+/gu, '').replace(/^-+|-+$/g, '');
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
    const [result] = await pool.execute(
      `INSERT INTO suppliers (supplier_code, name, company, contact_person, phone, email, address, tax_or_trade_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [supplier.code || null, supplier.name, supplier.company, supplier.contact, supplier.phone, supplier.email || null, supplier.address || null, supplier.businessId, supplier.notes || null]
    );
    await recordAuditLog({ actorType: 'admin', actorId: actor.id || null, action: 'supplier.create', entityType: 'supplier', entityId: result.insertId, afterState: supplier, ipAddress: actor.ip || '', userAgent: actor.userAgent || '' });
    return { id: result.insertId, ...supplier };
  }
  const result = sqlite.run(
    `INSERT INTO suppliers (supplier_code, name, company, contact_person, phone, email, address, tax_or_trade_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    supplier.code || null, supplier.name, supplier.company, supplier.contact, supplier.phone, supplier.email, supplier.address, supplier.businessId, supplier.notes
  );
  return { id: Number(result.lastInsertRowid), ...supplier };
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

async function listProducts() {
  if (isMysql()) return require('../db/mysqlPool').queryAll(`SELECT id, sku, name_bn, name_en, stock_on_hand, vendor_stock_on_hand, low_stock_threshold,
    regular_price_paisa, sale_price_paisa, cost_price_paisa, vendor_id, is_archived
    FROM products WHERE is_archived=0 ORDER BY id DESC LIMIT 1000`);
  return sqlite.all(`SELECT id, code AS sku, name AS name_bn, name AS name_en, stock AS stock_on_hand, vendor_stock_on_hand,
    low_stock_threshold, old_price, new_price, purchase_price, vendor_id, is_archived FROM products WHERE is_archived=0 ORDER BY id DESC LIMIT 1000`);
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
      if (product.categoryId) {
        const category = await tx.queryOne('SELECT id FROM categories WHERE id=? AND status=1 FOR UPDATE', [product.categoryId]);
        if (!category) throw new ValidationError('Selected category does not exist or is inactive.');
      }
      if (product.brandId) {
        const brand = await tx.queryOne('SELECT id FROM brands WHERE id=? AND status=1 FOR UPDATE', [product.brandId]);
        if (!brand) throw new ValidationError('Selected brand does not exist or is inactive.');
      }
      const result = await tx.execute(`INSERT INTO products (sku, barcode, slug, product_type, name_bn, name_en, category_id, brand_id,
        regular_price_paisa, sale_price_paisa, cost_price_paisa, wholesale_price_paisa, wholesale_min_qty, low_stock_threshold,
        unit_label, image_url, short_desc_bn, short_desc_en, description_bn, description_en, approval_status, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1)`,
        [product.sku, product.barcode || null, product.slug, product.type, product.nameBn, product.nameEn, product.categoryId, product.brandId,
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
  if (product.categoryId && !sqlite.get('SELECT id FROM categories WHERE id=? AND status=1', product.categoryId)) throw new ValidationError('Selected category does not exist or is inactive.');
  const result = sqlite.run(`INSERT INTO products (code, barcode, slug, product_type, name, name_en, category_id, brand_id, old_price, new_price, purchase_price,
    wholesale_price, wholesale_min_qty, low_stock_threshold, unit, image, short_desc, short_desc_en, description, description_en, stock, status, approval_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,'approved')`, product.sku, product.barcode || null, product.slug, product.type, product.nameBn, product.nameEn,
    product.categoryId || 1, product.brandId || null, product.regular / 100, product.sale / 100, product.cost / 100, product.wholesale / 100,
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

async function listInventory() {
  if (isMysql()) return require('../db/mysqlPool').queryAll(`SELECT p.id,p.sku,p.name_bn,p.name_en,p.unit_label,p.low_stock_threshold,
    p.stock_on_hand,p.stock_reserved,(p.stock_on_hand-p.stock_reserved) AS warehouse_available,
    p.vendor_stock_on_hand,p.vendor_stock_reserved,(p.vendor_stock_on_hand-p.vendor_stock_reserved) AS vendor_available,
    p.cost_price_paisa, COALESCE(SUM(CASE WHEN sl.stock_pool='warehouse' AND sl.unit_cost_paisa IS NOT NULL THEN sl.qty_delta*sl.unit_cost_paisa END),0) AS remaining_value_paisa
    FROM products p LEFT JOIN stock_ledger sl ON sl.product_id=p.id
    WHERE p.is_archived=0 GROUP BY p.id ORDER BY p.id DESC LIMIT 1000`);
  return sqlite.all(`SELECT p.id,p.code AS sku,p.name AS name_bn,p.name_en,p.unit AS unit_label,p.low_stock_threshold,
    p.stock AS stock_on_hand,p.stock_reserved,(p.stock-p.stock_reserved) AS warehouse_available,
    p.vendor_stock_on_hand,p.vendor_stock_reserved,(p.vendor_stock_on_hand-p.vendor_stock_reserved) AS vendor_available,
    p.purchase_price*100 AS cost_price_paisa,0 AS remaining_value_paisa
    FROM products p WHERE p.is_archived=0 ORDER BY p.id DESC LIMIT 1000`);
}

async function listStockLedger(productId = null) {
  if (isMysql()) return require('../db/mysqlPool').queryAll(`SELECT sl.*,p.sku,p.name_bn FROM stock_ledger sl JOIN products p ON p.id=sl.product_id
    WHERE (? IS NULL OR sl.product_id=?) ORDER BY sl.id DESC LIMIT 500`, [productId, productId]);
  return sqlite.all(`SELECT sl.*,p.code AS sku,p.name AS name_bn FROM stock_ledger sl JOIN products p ON p.id=sl.product_id
    WHERE (? IS NULL OR sl.product_id=?) ORDER BY sl.id DESC LIMIT 500`, productId, productId);
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
      return { id: po.insertId, referenceNo: ref, totalPaisa: total, status: 'draft' };
    }, { pool });
    await recordAuditLog({ actorType:'admin',actorId:actor.id||null,action:'purchase.create',entityType:'purchase',entityId:result.id,afterState:{supplierId,lines:cooked,totalPaisa:total},ipAddress:actor.ip||'',userAgent:actor.userAgent||'' });
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
    sqlite.rawDb.exec('COMMIT');
    return {id:Number(po.lastInsertRowid),referenceNo:ref,totalPaisa:total,status:'draft'};
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
      if (['cancelled','received'].includes(po.receive_status)) throw new AppError('PURCHASE_STATE_INVALID','Purchase is cancelled or fully received.',409);
      const exists = await tx.queryOne('SELECT id,request_hash FROM purchase_receipts WHERE idempotency_key=? FOR UPDATE',[idem]);
      if (exists) {
        if (exists.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH','Receipt idempotency key was reused with different receipt lines.',409);
        return {id:exists.id,replayed:true};
      }
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
      return {id:r.insertId,receiptNo,totalQty,totalValuePaisa:totalValue,status,replayed:false};
    },{pool});
    await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'purchase.receive',entityType:'purchase',entityId:purchaseId,afterState:result,ipAddress:actor.ip||'',userAgent:actor.userAgent||''});
    return result;
  }
  sqlite.rawDb.exec('BEGIN IMMEDIATE');
  try {
    const po=sqlite.get('SELECT * FROM purchases WHERE id=?',purchaseId);
    if(!po) throw new NotFoundError('Purchase order not found.');
    if(['cancelled','received'].includes(po.status)) throw new AppError('PURCHASE_STATE_INVALID','Purchase is cancelled or fully received.',409);
    const prior=sqlite.get('SELECT * FROM purchase_receipts WHERE idempotency_key=?',idem);
    if(prior){
      if(prior.request_hash!==requestHash) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH','Receipt idempotency key was reused with different receipt lines.',409);
      sqlite.rawDb.exec('COMMIT');return {id:prior.id,replayed:true};
    }
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
    sqlite.rawDb.exec('COMMIT');
    return {id:Number(r.lastInsertRowid),receiptNo,totalQty,totalValuePaisa:Math.round(totalValue*100),status,replayed:false};
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

module.exports = { createSupplier,listSuppliers,createProduct,listProducts,adjustStock,listInventory,listStockLedger,createPurchase,listPurchases,receivePurchase,archiveProduct };
