'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const { getPool, withTransaction, createQueryClient } = require('../db/mysqlPool');
const { normalizeBdPhone, requirePaisaFromBdt, requireString } = require('../utils/validator');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const { paisaToBdtString } = require('../utils/money');
const logger = require('../utils/logger');

const PAYMENT_METHODS = Object.freeze(['Cash On Delivery', 'Cash', 'bKash', 'Nagad']);
const MAX_POS_LINES = 100;
const MAX_POS_QTY = 100_000;

function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Admin POS repository requires MySQL.');
}
function client() { assertMysql(); return createQueryClient(getPool()); }
function optionalText(value, field, max) {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new ValidationError(`${field} must not exceed ${max} characters.`);
  return text;
}
function parsePosLines(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    if (raw.length > 20000) throw new ValidationError('POS cart is too large.');
    try { parsed = JSON.parse(raw); } catch { throw new ValidationError('POS cart payload is invalid.'); }
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_POS_LINES) {
    throw new ValidationError('Select between 1 and 100 products for the POS order.');
  }
  const quantities = new Map();
  for (const line of parsed) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw new ValidationError('POS cart contains an invalid line.');
    const productId = Number(line.id ?? line.product_id);
    const qty = Number(line.qty);
    if (!Number.isSafeInteger(productId) || productId < 1) throw new ValidationError('POS cart contains an invalid product ID.');
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_POS_QTY) throw new ValidationError('POS quantities must be whole numbers between 1 and 100000.');
    const sum = (quantities.get(productId) || 0) + qty;
    if (!Number.isSafeInteger(sum) || sum > MAX_POS_QTY) throw new ValidationError('Combined POS quantity exceeds the supported limit.');
    quantities.set(productId, sum);
  }
  return [...quantities.entries()].map(([productId, qty]) => ({ productId, qty })).sort((a,b) => a.productId-b.productId);
}
function normalizePaymentMethod(value) {
  const method = String(value || 'Cash On Delivery').trim();
  if (!PAYMENT_METHODS.includes(method)) throw new ValidationError('Select a supported POS payment method.');
  return method;
}
async function listPosFormData(poolOverride = null) {
  assertMysql();
  const db = createQueryClient(poolOverride || getPool());
  const [products, categories, customers, couriers] = await Promise.all([
    db.queryAll(`SELECT p.id,p.sku AS code,COALESCE(NULLIF(p.name_en,''),p.name_bn) AS name,
                        p.sale_price_paisa,p.image_url AS image,
                        GREATEST(p.stock_on_hand-p.stock_reserved,0) AS stock,
                        p.unit_label AS sizes,COALESCE(NULLIF(c.name_en,''),c.name_bn) AS category_name
                   FROM products p LEFT JOIN categories c ON c.id=p.category_id
                  WHERE p.status=1 AND p.is_archived=0 AND p.approval_status='approved' AND p.vendor_id IS NULL
                  ORDER BY p.id DESC`),
    db.queryAll(`SELECT id,COALESCE(NULLIF(name_en,''),name_bn) AS name
                   FROM categories WHERE status=1 ORDER BY sort_order ASC,id ASC`),
    db.queryAll('SELECT id,name,phone,address FROM customers ORDER BY id DESC LIMIT 100'),
    db.queryAll('SELECT id,name,code FROM courier_apis WHERE status=1 ORDER BY id ASC'),
  ]);
  return {
    products: products.map((row) => ({ ...row, new_price: paisaToBdtString(Number(row.sale_price_paisa || 0)) })),
    categories,
    customers,
    couriers,
  };
}
function invoiceCandidate() { return String(crypto.randomInt(10000, 100000)); }
async function uniqueInvoice(tx) {
  for (let attempt=0; attempt<12; attempt++) {
    const invoiceNo=invoiceCandidate();
    if (!await tx.queryOne('SELECT id FROM orders WHERE invoice_no=?',[invoiceNo])) return invoiceNo;
  }
  throw new ConflictError('Unable to allocate a unique POS invoice number. Please retry.');
}
async function insertAudit(tx, actor, orderId, invoiceNo, totalPaisa, paymentStatus, itemCount) {
  const after = JSON.stringify(logger.redactValue({ invoiceNo, totalPaisa, paymentStatus, itemCount, channel:'pos' }));
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,'order.pos.created','order',?,NULL,?,?,?)`, [actor.id || null, String(orderId), after, String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255)]);
}
async function createPosOrder(input = {}, actor = {}) {
  assertMysql();
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const customerName = requireString(values.customer_name, 'customer name', { min:2, max:191 });
  const phone = normalizeBdPhone(values.phone, 'customer phone');
  const address = optionalText(values.address, 'address', 2000) || 'POS Walk-in / Phone Order';
  const shippingZone = optionalText(values.shipping_area, 'shipping area', 80) || 'ঢাকার ভিতরে';
  const shippingPaisa = requirePaisaFromBdt(values.shipping_charge ?? 0, 'shipping charge');
  const discountPaisa = requirePaisaFromBdt(values.discount ?? 0, 'discount');
  const paymentMethod = normalizePaymentMethod(values.payment_method);
  const note = optionalText(values.note, 'order note', 1000);
  const lines = parsePosLines(values.items_json ?? values.items);
  const selectedCourier = optionalText(values.courier_name, 'courier name', 100);

  try {
    return await withTransaction(async (tx) => {
      const products = await tx.queryAll(`SELECT id,sku,COALESCE(NULLIF(name_en,''),name_bn) AS name,
          image_url,sale_price_paisa,unit_label,stock_on_hand,stock_reserved,vendor_id,status,is_archived,approval_status
        FROM products WHERE id IN (${lines.map(()=>'?').join(',')}) ORDER BY id ASC FOR UPDATE`, lines.map((line)=>line.productId));
      if (products.length !== lines.length) throw new NotFoundError('One or more POS products no longer exist.');
      const productsById = new Map(products.map((product)=>[Number(product.id),product]));
      const canonicalLines = lines.map((line)=>{
        const product=productsById.get(line.productId);
        if (!product || Number(product.status)!==1 || Number(product.is_archived)===1 || product.approval_status!=='approved' || product.vendor_id!=null) {
          throw new ConflictError('One or more POS products are no longer available for sale.');
        }
        const unitPricePaisa=Number(product.sale_price_paisa);
        const lineTotalPaisa=unitPricePaisa*line.qty;
        if (!Number.isSafeInteger(unitPricePaisa) || unitPricePaisa<0 || !Number.isSafeInteger(lineTotalPaisa)) throw new ValidationError('Product price exceeds the supported POS amount.');
        const available=Number(product.stock_on_hand)-Number(product.stock_reserved);
        if (!Number.isSafeInteger(available) || available<line.qty) throw new ConflictError(`Insufficient available stock for ${product.name}.`);
        return { ...line, product, unitPricePaisa, lineTotalPaisa };
      });
      const subtotalPaisa=canonicalLines.reduce((sum,line)=>sum+line.lineTotalPaisa,0);
      if (!Number.isSafeInteger(subtotalPaisa)) throw new ValidationError('POS subtotal exceeds the supported amount.');
      const totalPaisa=Math.max(0,subtotalPaisa+shippingPaisa-discountPaisa);
      if (!Number.isSafeInteger(totalPaisa)) throw new ValidationError('POS total exceeds the supported amount.');
      const paymentStatus=paymentMethod==='Cash'?'paid':'unpaid';
      const paidPaisa=paymentStatus==='paid'?totalPaisa:0;
      const codDuePaisa=paymentMethod==='Cash On Delivery'?totalPaisa:0;
      let courierCode='';
      if (selectedCourier) {
        const courier=await tx.queryOne('SELECT code FROM courier_apis WHERE name=? AND status=1 ORDER BY id LIMIT 1 FOR UPDATE',[selectedCourier]);
        if (!courier) throw new ValidationError('Selected courier is not active.');
        courierCode=requireString(courier.code,'courier code',{min:1,max:32});
      }
      let customer=await tx.queryOne('SELECT id FROM customers WHERE phone=? FOR UPDATE',[phone]);
      if (!customer) {
        const result=await tx.execute('INSERT INTO customers(name,phone,address,total_orders) VALUES(?,?,?,1)',[customerName,phone,address]);
        customer={id:result.insertId};
      } else {
        await tx.execute('UPDATE customers SET total_orders=total_orders+1 WHERE id=?',[customer.id]);
      }
      const invoiceNo=await uniqueInvoice(tx);
      const order=await tx.execute(`INSERT INTO orders(invoice_no,customer_id,customer_name,customer_phone,shipping_address,shipping_zone,
          subtotal_paisa,discount_paisa,shipping_paisa,total_paisa,paid_paisa,cod_due_paisa,payment_method,payment_status,order_status,
          order_channel,traffic_source,courier_code,customer_note,is_seen)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'processing','pos','POS',?,?,1)`,
      [invoiceNo,customer.id,customerName,phone,address,shippingZone,subtotalPaisa,discountPaisa,shippingPaisa,totalPaisa,paidPaisa,codDuePaisa,paymentMethod,paymentStatus,courierCode,note]);
      const orderId=Number(order.insertId);
      await tx.execute("INSERT INTO order_status_history(order_id,from_status,to_status,note,changed_by_user_id) VALUES(?,'','processing','POS order created',?)",[orderId,actor.id||null]);
      for (const line of canonicalLines) {
        const product=line.product;
        const image=String(product.image_url||'');
        const size=String(product.unit_label||'');
        await tx.execute(`INSERT INTO order_items(order_id,product_id,product_name,product_image,unit_price_paisa,qty,line_total_paisa,size_label)
          VALUES(?,?,?,?,?,?,?,?)`,[orderId,line.productId,product.name,image,line.unitPricePaisa,line.qty,line.lineTotalPaisa,size]);
        const balanceAfter=Number(product.stock_on_hand)-line.qty;
        const stockUpdate=await tx.execute('UPDATE products SET stock_on_hand=stock_on_hand-?,sold_count=sold_count+? WHERE id=? AND stock_on_hand-stock_reserved>=?',
          [line.qty,line.qty,line.productId,line.qty]);
        if(stockUpdate.affectedRows!==1)throw new ConflictError(`Insufficient available stock for ${product.name}.`);
        await tx.execute(`INSERT INTO stock_ledger(product_id,stock_pool,movement_type,qty_delta,balance_after,reference_type,reference_id,reason,actor_user_id)
          VALUES(?,'warehouse','pos_sale',?,?,'order',?,?,?)`,[line.productId,-line.qty,balanceAfter,orderId,`POS invoice ${invoiceNo}`,actor.id||null]);
      }
      await insertAudit(tx,actor,orderId,invoiceNo,totalPaisa,paymentStatus,canonicalLines.length);
      return { id:orderId, invoiceNo, totalPaisa, paymentStatus };
    });
  } catch (error) {
    if (error.code==='DB_DUPLICATE_ENTRY') throw new ConflictError('A POS order with this invoice number already exists. Please retry.');
    throw error;
  }
}

module.exports = { PAYMENT_METHODS, parsePosLines, listPosFormData, createPosOrder };
