'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const mysql = require('../db/mysqlPool');
const { normalizeBdPhone, requirePaisaInt, requireString, requirePositiveInt } = require('../utils/validator');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');

const TRANSITIONS = Object.freeze({
  pending: ['confirmed', 'cancelled', 'failed'],
  confirmed: ['processing', 'cancelled', 'failed'],
  processing: ['shipped', 'cancelled', 'failed'],
  shipped: ['delivered', 'return_requested'],
  delivered: ['return_requested'],
  // Final return acceptance/restock is intentionally disabled pending owner-approved partial-return, inspection, refund and disposition policy.
  return_requested: ['returned'],
  cancelled: [], failed: [], returned: [],
});
const REFUND_STATES = Object.freeze({
  requested: ['approved', 'rejected'],
  approved: ['rejected'],
  processing: ['failed'],
  succeeded: [], failed: [], rejected: [],
});
const RESERVED_REFUND_STATES = ['requested', 'pending', 'approved', 'processing', 'succeeded', 'completed'];
const INCOMPLETE_STATES = Object.freeze({
  abandoned: ['contacted', 'recovery_started', 'recovered', 'withdrawn'],
  contacted: ['recovery_started', 'recovered', 'withdrawn'],
  recovery_started: ['contacted', 'recovered', 'withdrawn'],
  recovered: [], withdrawn: [],
});

function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Phase 08 order operations require MySQL/InnoDB.');
}
function client() { assertMysql(); return mysql.createQueryClient(mysql.getPool()); }
function safeHash(value, secret = env.sessionSecret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}
function validateOtpPolicy(input = {}) {
  const expirySeconds = Number(input.expirySeconds ?? 300);
  const maxAttempts = Number(input.maxAttempts ?? 5);
  const cooldownSeconds = Number(input.cooldownSeconds ?? 60);
  const maxPerHour = Number(input.maxPerHour ?? 5);
  if (!Number.isInteger(expirySeconds) || expirySeconds < 60 || expirySeconds > 900) throw new ValidationError('OTP expiry must be 60–900 seconds.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new ValidationError('OTP attempts must be 1–10.');
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 30 || cooldownSeconds > 3600) throw new ValidationError('OTP cooldown must be 30–3600 seconds.');
  if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > 10) throw new ValidationError('OTP hourly issue limit must be 1–10.');
  return { enabled: input.enabled === true, expirySeconds, maxAttempts, cooldownSeconds, maxPerHour };
}
function validateAdvancePolicy(input = {}) {
  const mode = String(input.mode || 'off');
  if (!['off', 'fixed', 'percent'].includes(mode)) throw new ValidationError('Advance mode must be off, fixed or percent.');
  const value = Number(input.value ?? 0);
  if (!Number.isSafeInteger(value) || value < 0 || (mode === 'percent' && value > 100)) throw new ValidationError('Advance amount must be a non-negative integer (percent 0–100).');
  const minimumPaisa = requirePaisaInt(input.minimumPaisa ?? 0, 'minimum order');
  const maximumPaisa = input.maximumPaisa == null || input.maximumPaisa === '' ? null : requirePaisaInt(input.maximumPaisa, 'maximum order');
  if (maximumPaisa !== null && maximumPaisa < minimumPaisa) throw new ValidationError('Maximum order value cannot be below minimum.');
  return { mode, value, minimumPaisa, maximumPaisa };
}
function calculateAdvance(totalPaisa, policyInput) {
  const total = requirePaisaInt(totalPaisa, 'order total');
  const policy = validateAdvancePolicy(policyInput);
  if (policy.mode === 'off' || total < policy.minimumPaisa || (policy.maximumPaisa !== null && total > policy.maximumPaisa)) return 0;
  if (policy.mode === 'fixed') return Math.min(total, policy.value);
  // Percentage rounding is floor in integer paisa; no floating point is used.
  return Number((BigInt(total) * BigInt(policy.value)) / 100n);
}
function computeOrderPayment(totalPaisa, paidPaisa, policyInput) {
  const total = requirePaisaInt(totalPaisa, 'order total');
  const paid = requirePaisaInt(paidPaisa, 'recorded paid amount');
  if (paid > total) throw new ValidationError('Recorded paid amount cannot exceed the order total.');
  const requiredAdvance = calculateAdvance(total, policyInput);
  const dueAdvance = Math.max(0, requiredAdvance - paid);
  return { totalPaisa: total, paidPaisa: paid, requiredAdvancePaisa: requiredAdvance, advanceDuePaisa: dueAdvance, codDuePaisa: total - paid };
}
function otpDigest(phone, code, secret = env.sessionSecret) {
  return crypto.createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
}
function makeOtp() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }

async function insertAudit(tx, actor, action, entityType, entityId, beforeState, afterState) {
  const { logger } = require('../utils/logger');
  await tx.execute(`INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?)`, [actor?.type || (actor?.id ? 'admin' : 'system'), actor?.id || null, action, entityType, String(entityId), JSON.stringify(logger.redactValue(beforeState || {})), JSON.stringify(logger.redactValue(afterState || {})), String(actor?.ip || '').slice(0,64), String(actor?.userAgent || '').slice(0,255)]);
}
function orderReservationKey(orderId) { return `order:${orderId}`; }
function normalizeOrderLines(rawLines) {
  const byLine = new Map();
  for (const line of rawLines) {
    const productId = Number(line.product_id);
    const variantId = line.variant_id == null ? null : Number(line.variant_id);
    const qty = Number(line.qty);
    if (!Number.isSafeInteger(productId) || productId < 1 || (variantId !== null && (!Number.isSafeInteger(variantId) || variantId < 1)) || !Number.isSafeInteger(qty) || qty < 1 || qty > 100_000) throw new ValidationError('Order contains an invalid product, variant or quantity.');
    byLine.set(`${productId}:${variantId || 0}`, { productId, variantId, qty: (byLine.get(`${productId}:${variantId || 0}`)?.qty || 0) + qty });
  }
  return [...byLine.values()].sort((a,b) => a.productId-b.productId || (a.variantId||0)-(b.variantId||0));
}
async function reserveOrderInventoryTx(tx, orderId, actor = {}) {
  const key = orderReservationKey(orderId);
  const order=await tx.queryOne('SELECT id,order_status FROM orders WHERE id=? FOR UPDATE',[orderId]);
  if(!order)throw new NotFoundError('Order not found.');
  if(!['pending','confirmed'].includes(order.order_status))throw new ConflictError(`Cannot reserve inventory for an order in ${order.order_status} state.`);
  const items = await tx.queryAll('SELECT product_id, variant_id, SUM(qty) AS qty FROM order_items WHERE order_id=? GROUP BY product_id, variant_id ORDER BY product_id, variant_id', [orderId]);
  const lines = normalizeOrderLines(items);
  if (!lines.length) throw new ConflictError('Cannot confirm an order without order lines.');
  if(new Set(lines.map(line=>line.productId)).size!==lines.length)throw new ConflictError('The current reservation schema allows one product line per order; consolidate variant quantities before confirmation.');
  const hash = crypto.createHash('sha256').update(JSON.stringify(lines)).digest('hex');
  const existing = await tx.queryAll('SELECT product_id, variant_id, qty, request_hash, status FROM stock_reservations WHERE reservation_key=? ORDER BY product_id, variant_id', [key]);
  if (existing.length) {
    if (existing.length !== lines.length || existing.some((row) => row.request_hash !== hash)) throw new ConflictError('Order already has a different inventory reservation.');
    if (existing.every((row) => row.status === 'active' || row.status === 'consumed')) return { replayed: true, rows: existing.length };
    throw new ConflictError('This order reservation was already released and cannot be recreated.');
  }
  const products = await tx.lockRowsById('products', lines.map((l) => l.productId), ['id','vendor_id','stock_on_hand','stock_reserved','vendor_stock_on_hand','vendor_stock_reserved','status','is_archived']);
  const productsById = new Map(products.map((p) => [Number(p.id), p]));
  const variantIds = lines.filter((l) => l.variantId).map((l) => l.variantId);
  const variants = variantIds.length ? await tx.queryAll(`SELECT id, product_id, stock_on_hand, stock_reserved, status FROM product_variants WHERE id IN (${variantIds.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, variantIds) : [];
  const variantsById = new Map(variants.map((v) => [Number(v.id), v]));
  for (const line of lines) {
    const p = productsById.get(line.productId);
    if (!p || Number(p.status) !== 1 || Number(p.is_archived)) throw new ConflictError(`Product ${line.productId} is unavailable.`);
    if (line.variantId && (!variantsById.has(line.variantId) || Number(variantsById.get(line.variantId).product_id) !== line.productId || Number(variantsById.get(line.variantId).status) !== 1)) throw new ConflictError(`Variant ${line.variantId} is unavailable.`);
    if (line.variantId && p.vendor_id) throw new ConflictError('Variant reservations for vendor-stock products are not supported by the current inventory model.');
    const pool = p.vendor_id ? 'vendor' : 'warehouse';
    const onHand = line.variantId ? Number(variantsById.get(line.variantId).stock_on_hand) : Number(p[pool === 'vendor' ? 'vendor_stock_on_hand' : 'stock_on_hand']);
    const reserved = line.variantId ? Number(variantsById.get(line.variantId).stock_reserved) : Number(p[pool === 'vendor' ? 'vendor_stock_reserved' : 'stock_reserved']);
    if (onHand - reserved < line.qty) throw new ConflictError(`Insufficient available stock for product ${line.productId}.`);
  }
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  for (const line of lines) {
    const p = productsById.get(line.productId);
    const pool = p.vendor_id ? 'vendor' : 'warehouse';
    if (line.variantId) await tx.execute('UPDATE product_variants SET stock_reserved=stock_reserved+? WHERE id=?', [line.qty,line.variantId]);
    const reservationColumn = pool === 'vendor' ? 'vendor_stock_reserved' : 'stock_reserved';
    await tx.execute(`UPDATE products SET ${reservationColumn}=${reservationColumn}+? WHERE id=?`, [line.qty,line.productId]);
    await tx.execute('INSERT INTO stock_reservations (product_id,variant_id,stock_pool,qty,reservation_key,request_hash,status,expires_at) VALUES (?,?,?,?,?,?,?,?)', [line.productId,line.variantId,pool,line.qty,key,hash,'active',expiresAt]);
  }
  return { replayed: false, rows: lines.length };
}
async function releaseOrderInventoryTx(tx, orderId, actor = {}, reason = 'Order cancelled') {
  const reservations = await tx.queryAll('SELECT id,product_id,variant_id,stock_pool,qty FROM stock_reservations WHERE reservation_key=? AND status="active" ORDER BY product_id,variant_id FOR UPDATE', [orderReservationKey(orderId)]);
  if (!reservations.length) return { released: 0 };
  const lockedProducts=await tx.lockRowsById('products', reservations.map((r) => Number(r.product_id)), ['id','vendor_id','stock_reserved','vendor_stock_reserved']);
  const productMap=new Map(lockedProducts.map(p=>[Number(p.id),p]));
  for (const r of reservations) {
    const col = r.stock_pool === 'vendor' ? 'vendor_stock_reserved' : 'stock_reserved';
    const product=productMap.get(Number(r.product_id));
    if(!product || Number(product[col])<Number(r.qty)) throw new ConflictError('Cannot release an inventory reservation that is not held.');
    if(r.variant_id){const variant=await tx.queryOne('SELECT stock_reserved FROM product_variants WHERE id=? FOR UPDATE',[r.variant_id]);if(!variant||Number(variant.stock_reserved)<Number(r.qty))throw new ConflictError('Cannot release variant inventory that is not reserved.');}
    await tx.execute(`UPDATE products SET ${col}=${col}-? WHERE id=?`, [r.qty,r.product_id]);
    if (r.variant_id) await tx.execute('UPDATE product_variants SET stock_reserved=stock_reserved-? WHERE id=?', [r.qty,r.variant_id]);
    await tx.execute('UPDATE stock_reservations SET status="released" WHERE id=? AND status="active"', [r.id]);
    await tx.execute('INSERT INTO stock_ledger (product_id,variant_id,stock_pool,vendor_id,movement_type,qty_delta,balance_after,reference_type,reference_id,reason,actor_user_id) SELECT p.id,?,?,p.vendor_id,?,?,CASE WHEN ?="vendor" THEN p.vendor_stock_on_hand ELSE p.stock_on_hand END,"order",?,?,? FROM products p WHERE p.id=?', [r.variant_id,r.stock_pool,'release',0,r.stock_pool,orderId,reason,actor.id||null,r.product_id]);
  }
  return { released: reservations.length };
}
async function expireOrderInventoryTx(tx, orderId) {
  const id = requirePositiveInt(orderId, 'order ID');
  // Serialize against order transitions first, matching transitionOrder's lock order.
  const order = await tx.queryOne('SELECT id,order_status FROM orders WHERE id=? FOR UPDATE', [id]);
  if (!order) throw new NotFoundError('Order not found while expiring its reservation.');
  const key = orderReservationKey(id);
  const reservations = await tx.queryAll('SELECT id,product_id,variant_id,stock_pool,qty FROM stock_reservations WHERE reservation_key=? AND status="active" AND expires_at<=UTC_TIMESTAMP() ORDER BY product_id,variant_id FOR UPDATE', [key]);
  if (!reservations.length) return { expired: 0, orderId: id };
  const lockedProducts = await tx.lockRowsById('products', reservations.map((r) => Number(r.product_id)), ['id','vendor_id','stock_reserved','vendor_stock_reserved']);
  const productMap = new Map(lockedProducts.map((p) => [Number(p.id), p]));
  for (const r of reservations) {
    const col = r.stock_pool === 'vendor' ? 'vendor_stock_reserved' : 'stock_reserved';
    const product = productMap.get(Number(r.product_id));
    if (!product || Number(product[col]) < Number(r.qty)) throw new ConflictError('Cannot expire an inventory reservation that is not held.');
    if (r.variant_id) {
      const variant = await tx.queryOne('SELECT stock_reserved FROM product_variants WHERE id=? FOR UPDATE', [r.variant_id]);
      if (!variant || Number(variant.stock_reserved) < Number(r.qty)) throw new ConflictError('Cannot expire variant inventory that is not reserved.');
    }
    await tx.execute(`UPDATE products SET ${col}=${col}-? WHERE id=?`, [r.qty, r.product_id]);
    if (r.variant_id) await tx.execute('UPDATE product_variants SET stock_reserved=stock_reserved-? WHERE id=?', [r.qty, r.variant_id]);
    const changed = await tx.execute('UPDATE stock_reservations SET status="expired" WHERE id=? AND status="active" AND expires_at<=UTC_TIMESTAMP()', [r.id]);
    if (Number(changed.affectedRows) !== 1) throw new ConflictError('Reservation changed while it was being expired.');
    await tx.execute('INSERT INTO stock_ledger (product_id,variant_id,stock_pool,vendor_id,movement_type,qty_delta,balance_after,reference_type,reference_id,reason,actor_user_id) SELECT p.id,?,?,p.vendor_id,?,?,CASE WHEN ?="vendor" THEN p.vendor_stock_on_hand ELSE p.stock_on_hand END,"order",?,"Expired order reservation",NULL FROM products p WHERE p.id=?', [r.variant_id,r.stock_pool,'release',0,r.stock_pool,id,r.product_id]);
  }
  await insertAudit(tx, { type: 'system' }, 'inventory.reservation.expired', 'order', id, { activeReservationRows: reservations.length }, { expiredReservationRows: reservations.length, orderStatusUnchanged: order.order_status });
  return { expired: reservations.length, orderId: id };
}

function validateExpiryLimit(limit) {
  const batchSize = Number(limit);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new ValidationError('Reservation expiry batch limit must be an integer from 1 to 1000.');
  return batchSize;
}
async function listExpiredOrderReservationCandidates({ limit = 100 } = {}) {
  assertMysql();
  const batchSize = validateExpiryLimit(limit);
  return client().queryAll('SELECT reservation_key,COUNT(*) AS reservation_rows,MIN(expires_at) AS earliest_expiry FROM stock_reservations WHERE status="active" AND expires_at<=UTC_TIMESTAMP() AND reservation_key LIKE "order:%" GROUP BY reservation_key ORDER BY MIN(expires_at),reservation_key LIMIT ?', [batchSize]);
}
async function expireExpiredOrderReservations({ limit = 100 } = {}) {
  assertMysql();
  const batchSize = validateExpiryLimit(limit);
  const db = client();
  const candidates = await db.queryAll('SELECT reservation_key FROM stock_reservations WHERE status="active" AND expires_at<=UTC_TIMESTAMP() AND reservation_key LIKE "order:%" GROUP BY reservation_key ORDER BY MIN(expires_at),reservation_key LIMIT ?', [batchSize]);
  const results = [];
  for (const row of candidates) {
    const match = /^order:([1-9][0-9]*)$/.exec(String(row.reservation_key));
    if (!match) continue;
    const orderId = Number(match[1]);
    if (!Number.isSafeInteger(orderId)) continue;
    results.push(await mysql.withTransaction((tx) => expireOrderInventoryTx(tx, orderId)));
  }
  return { examined: candidates.length, expiredOrders: results.filter((result) => result.expired > 0).length, expiredReservations: results.reduce((sum, result) => sum + result.expired, 0), results };
}

async function consumeOrderInventoryTx(tx, orderId, actor = {}) {
  const rows = await tx.queryAll('SELECT id,product_id,variant_id,stock_pool,qty,expires_at FROM stock_reservations WHERE reservation_key=? AND status="active" ORDER BY product_id,variant_id FOR UPDATE', [orderReservationKey(orderId)]);
  if (!rows.length) throw new ConflictError('Order has no active inventory reservation; stock was not decremented.');
  if (rows.some((r) => new Date(r.expires_at).getTime() <= Date.now())) throw new ConflictError('Order inventory reservation expired; extend or re-reserve before shipping.');
  await tx.lockRowsById('products', rows.map((r) => Number(r.product_id)), ['id','vendor_id','stock_on_hand','stock_reserved','vendor_stock_on_hand','vendor_stock_reserved']);
  for (const r of rows) {
    const pool = r.stock_pool === 'vendor' ? 'vendor' : 'warehouse';
    const onHandCol = pool === 'vendor' ? 'vendor_stock_on_hand' : 'stock_on_hand';
    const reservedCol = pool === 'vendor' ? 'vendor_stock_reserved' : 'stock_reserved';
    const variant = r.variant_id ? await tx.queryOne('SELECT stock_on_hand,stock_reserved FROM product_variants WHERE id=? FOR UPDATE', [r.variant_id]) : null;
    if (r.variant_id && (!variant || Number(variant.stock_on_hand) < Number(r.qty) || Number(variant.stock_reserved) < Number(r.qty))) throw new ConflictError('Reserved variant stock is no longer consistent.');
    const product = await tx.queryOne(`SELECT ${onHandCol} AS hand,${reservedCol} AS reserved,vendor_id FROM products WHERE id=? FOR UPDATE`, [r.product_id]);
    if (!product || Number(product.hand) < Number(r.qty) || Number(product.reserved) < Number(r.qty)) throw new ConflictError('Reserved product stock is no longer consistent.');
    await tx.execute(`UPDATE products SET ${onHandCol}=${onHandCol}-?,${reservedCol}=${reservedCol}-?,sold_count=sold_count+? WHERE id=?`, [r.qty,r.qty,r.qty,r.product_id]);
    let balance = Number(product.hand) - Number(r.qty);
    if (r.variant_id) {
      await tx.execute('UPDATE product_variants SET stock_on_hand=stock_on_hand-?,stock_reserved=stock_reserved-? WHERE id=?', [r.qty,r.qty,r.variant_id]);
      balance = Number(variant.stock_on_hand) - Number(r.qty);
    }
    await tx.execute('UPDATE stock_reservations SET status="consumed" WHERE id=? AND status="active"', [r.id]);
    await tx.execute('INSERT INTO stock_ledger (product_id,variant_id,stock_pool,vendor_id,movement_type,qty_delta,balance_after,reference_type,reference_id,reason,actor_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [r.product_id,r.variant_id,pool,product.vendor_id,'sale',-Number(r.qty),balance,'order',orderId,'Order fulfilled',actor.id||null]);
  }
  return { consumed: rows.length };
}

async function restoreReturnedInventoryTx(tx, orderId, actor = {}, reason = 'Returned order') {
  const rows=await tx.queryAll('SELECT id,product_id,variant_id,stock_pool,qty FROM stock_reservations WHERE reservation_key=? AND status=\"consumed\" ORDER BY product_id,variant_id FOR UPDATE',[orderReservationKey(orderId)]);
  if(!rows.length)return {restored:0};
  const products=await tx.lockRowsById('products',rows.map(r=>Number(r.product_id)),['id','vendor_id','stock_on_hand','vendor_stock_on_hand']);
  const byId=new Map(products.map(p=>[Number(p.id),p]));
  for(const r of rows){
    const product=byId.get(Number(r.product_id));
    if(!product)throw new ConflictError('Cannot restore returned inventory because its product no longer exists.');
    const pool=r.stock_pool==='vendor'?'vendor':'warehouse';
    const onHandCol=pool==='vendor'?'vendor_stock_on_hand':'stock_on_hand';
    if(r.variant_id){
      const variant=await tx.queryOne('SELECT stock_on_hand FROM product_variants WHERE id=? FOR UPDATE',[r.variant_id]);
      if(!variant)throw new ConflictError('Cannot restore returned inventory because its variant no longer exists.');
      await tx.execute('UPDATE product_variants SET stock_on_hand=stock_on_hand+? WHERE id=?',[r.qty,r.variant_id]);
    }
    const balance=Number(product[onHandCol])+Number(r.qty);
    await tx.execute(`UPDATE products SET ${onHandCol}=${onHandCol}+? WHERE id=?`,[r.qty,r.product_id]);
    await tx.execute('UPDATE stock_reservations SET status=\"returned\" WHERE id=? AND status=\"consumed\"',[r.id]);
    await tx.execute('INSERT INTO stock_ledger (product_id,variant_id,stock_pool,vendor_id,movement_type,qty_delta,balance_after,reference_type,reference_id,reason,actor_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[r.product_id,r.variant_id,pool,product.vendor_id,'return',Number(r.qty),balance,'order',orderId,reason,actor.id||null]);
  }
  return {restored:rows.length};
}

async function transitionOrderTx(tx, orderIdInput, toStatus, note, actor = {}, requestKeyInput) {
  const id = requirePositiveInt(orderIdInput, 'order ID');
  const target = String(toStatus || '').trim();
  const reason = requireString(note, 'transition reason', { min: 3, max: 255 });
  const key = requireString(requestKeyInput, 'transition request key', { min: 8, max: 128 });
  if (!Object.hasOwn(TRANSITIONS, target)) throw new ValidationError('Invalid target order status.');
  let prior = await tx.queryOne('SELECT order_id,to_status FROM order_status_history WHERE request_key=?', [key]);
  if (prior) {
    if (Number(prior.order_id) !== id || prior.to_status !== target) throw new ConflictError('Status request key was already used for a different transition.');
    return { id, to: target, replayed: true };
  }
  const order = await tx.queryOne('SELECT id,order_status FROM orders WHERE id=? FOR UPDATE', [id]);
  if (!order) throw new NotFoundError('Order not found.');
  // Recheck after locking the parent order so a concurrent retry observes the committed key.
  prior = await tx.queryOne('SELECT order_id,to_status FROM order_status_history WHERE request_key=? FOR UPDATE', [key]);
  if (prior) {
    if (Number(prior.order_id) !== id || prior.to_status !== target) throw new ConflictError('Status request key was already used for a different transition.');
    return { id, to: target, replayed: true };
  }
  const from = String(order.order_status);
  if (!TRANSITIONS[from]?.includes(target)) throw new ConflictError(`Order cannot move from ${from} to ${target}.`);
  if(target==='returned'){
    const incomplete=await tx.queryOne(`SELECT COUNT(*) AS n FROM order_items oi LEFT JOIN (SELECT ri.order_item_id,SUM(ri.qty) AS inspected_qty FROM customer_return_items ri JOIN customer_return_requests rr ON rr.id=ri.return_request_id WHERE rr.order_id=? AND rr.status='inspected' AND ri.disposition<>'pending_inspection' GROUP BY ri.order_item_id) returned ON returned.order_item_id=oi.id WHERE oi.order_id=? AND COALESCE(returned.inspected_qty,0)<oi.qty`,[id,id]);
    if(!incomplete||Number(incomplete.n)>0)throw new ConflictError('An order can be marked returned only after every ordered unit is approved and inspected with a recorded disposition.');
  }
  if (target === 'confirmed') await reserveOrderInventoryTx(tx, id, actor);
  if (target === 'cancelled' || target === 'failed') await releaseOrderInventoryTx(tx, id, actor, reason);
  if (target === 'shipped') await consumeOrderInventoryTx(tx, id, actor);
  await tx.execute('UPDATE orders SET order_status=?,is_seen=1 WHERE id=?', [target,id]);
  await tx.execute('INSERT INTO order_status_history (order_id,from_status,to_status,note,request_key,changed_by_user_id) VALUES (?,?,?,?,?,?)', [id,from,target,reason,key,actor.id||null]);
  await insertAudit(tx, actor, `order.status.${target}`, 'order', id, { status:from }, { status:target, reason, requestKey:key });
  return { id, from, to:target, replayed:false };
}
async function transitionOrder(orderId, toStatus, note, actor = {}, requestKey) {
  assertMysql();
  const id = requirePositiveInt(orderId, 'order ID');
  const target = String(toStatus || '').trim();
  const reason = requireString(note, 'transition reason', { min: 3, max: 255 });
  const key = requireString(requestKey, 'transition request key', { min: 8, max: 128 });
  if (!Object.hasOwn(TRANSITIONS, target)) throw new ValidationError('Invalid target order status.');
  try {
    return await mysql.withTransaction((tx) => transitionOrderTx(tx,id,target,reason,actor,key));
  } catch(err) {
    if(err.code==='DB_DUPLICATE_ENTRY'){
      const prior=await client().queryOne('SELECT order_id,to_status FROM order_status_history WHERE request_key=?',[key]);
      if(prior){if(Number(prior.order_id)!==id||prior.to_status!==target)throw new ConflictError('Status request key was already used for a different transition.');return{id,to:target,replayed:true};}
    }
    throw err;
  }
}

async function requestRefund(orderId, amountPaisa, reason, requestKey, actor = {}) {
  assertMysql();
  const id = requirePositiveInt(orderId, 'order ID');
  const amount = requirePaisaInt(amountPaisa, 'refund amount');
  const note = requireString(reason, 'refund reason', { min:3, max:255 });
  const key = requireString(requestKey, 'refund request key', { min:8, max:128 });
  const lookupReplay = async () => {
    const existing = await client().queryOne('SELECT id,order_id,amount_paisa,status FROM refunds WHERE request_key=?', [key]);
    if (!existing) return null;
    if (Number(existing.order_id)!==id || Number(existing.amount_paisa)!==amount) throw new ConflictError('Refund idempotency key was already used with another request.');
    return { id:Number(existing.id), replayed:true, status:existing.status };
  };
  try {
    return await mysql.withTransaction(async (tx) => {
      let existing = await tx.queryOne('SELECT id,order_id,amount_paisa,status FROM refunds WHERE request_key=?', [key]);
      if (existing) {
        if (Number(existing.order_id)!==id || Number(existing.amount_paisa)!==amount) throw new ConflictError('Refund idempotency key was already used with another request.');
        return { id:Number(existing.id), replayed:true, status:existing.status };
      }
      const order = await tx.queryOne('SELECT id,invoice_no,paid_paisa,order_status FROM orders WHERE id=? FOR UPDATE', [id]);
      if (!order) throw new NotFoundError('Order not found.');
      existing = await tx.queryOne('SELECT id,order_id,amount_paisa,status FROM refunds WHERE request_key=? FOR UPDATE', [key]);
      if (existing) {
        if (Number(existing.order_id)!==id || Number(existing.amount_paisa)!==amount) throw new ConflictError('Refund idempotency key was already used with another request.');
        return { id:Number(existing.id), replayed:true, status:existing.status };
      }
      if (!['cancelled','delivered','returned'].includes(order.order_status)) throw new ConflictError('Refund requests are permitted only for cancelled, delivered or returned orders.');
      const reservedRows=await tx.queryAll(`SELECT id,amount_paisa FROM refunds WHERE order_id=? AND status IN (${RESERVED_REFUND_STATES.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,[id,...RESERVED_REFUND_STATES]);
      const paid = Number(order.paid_paisa || 0);
      if (!Number.isSafeInteger(paid) || paid<0 || amount < 1) throw new ValidationError('Recorded paid balance is invalid.');
      const reserved=reservedRows.reduce((sum,row)=>sum+BigInt(row.amount_paisa),0n);
      if(BigInt(amount)>BigInt(paid)-reserved)throw new ValidationError('Refund amount exceeds the remaining recorded paid balance.');
      const inserted = await tx.execute('INSERT INTO refunds (order_id,invoice_no,amount_paisa,reason,request_key,method,status,processed_by_user_id) VALUES (?,?,?,?,?,?,?,?)', [id,order.invoice_no,amount,note,key,'manual','requested',actor.id||null]);
      await tx.execute('INSERT INTO refund_status_history (refund_id,from_status,to_status,reason,request_key,actor_user_id) VALUES (?,\'\',\'requested\',?,?,?)', [inserted.insertId,note,`req:${crypto.createHash('sha256').update(key).digest('hex')}`,actor.id||null]);
      await insertAudit(tx, actor, 'refund.requested', 'refund', inserted.insertId, null, { orderId:id, amountPaisa:amount, status:'requested', requestKey:key });
      return { id:inserted.insertId, replayed:false, status:'requested' };
    });
  } catch (err) {
    if (err.code === 'DB_DUPLICATE_ENTRY') {
      const replay = await lookupReplay();
      if (replay) return replay;
    }
    throw err;
  }
}
async function transitionRefund(refundId, targetStatus, reason, actor = {}, requestKey) {
  assertMysql();
  const id = requirePositiveInt(refundId, 'refund ID');
  const target = String(targetStatus || '').trim();
  const note = requireString(reason, 'refund decision reason', { min:3, max:255 });
  const key = requireString(requestKey, 'refund decision request key', { min:8, max:128 });
  if (!['approved','rejected'].includes(target)) throw new ValidationError('Admins may approve or reject requests; provider processing is not available here.');
  try {
    return await mysql.withTransaction(async (tx) => {
    const replay = await tx.queryOne('SELECT refund_id,to_status FROM refund_status_history WHERE request_key=?', [key]);
    if (replay) {
      if (Number(replay.refund_id)!==id || replay.to_status!==target) throw new ConflictError('Refund decision key was used for a different request.');
      return { id, status:target, replayed:true };
    }
    const candidate=await tx.queryOne('SELECT id,order_id FROM refunds WHERE id=?',[id]);
    if(!candidate)throw new NotFoundError('Refund request not found.');
    const order=await tx.queryOne('SELECT id,paid_paisa FROM orders WHERE id=? FOR UPDATE',[candidate.order_id]);
    const refund = await tx.queryOne('SELECT id,order_id,amount_paisa,status FROM refunds WHERE id=? FOR UPDATE', [id]);
    if (!refund) throw new NotFoundError('Refund request not found.');
    const concurrentReplay=await tx.queryOne('SELECT refund_id,to_status FROM refund_status_history WHERE request_key=? FOR UPDATE',[key]);
    if(concurrentReplay){if(Number(concurrentReplay.refund_id)!==id||concurrentReplay.to_status!==target)throw new ConflictError('Refund decision key was used for a different request.');return{id,status:target,replayed:true};}
    const allowedFrom=refund.status==='pending'?'requested':refund.status;
    if (!['requested','pending'].includes(refund.status) || !REFUND_STATES[allowedFrom]?.includes(target)) throw new ConflictError(`Refund cannot transition from ${refund.status} to ${target}.`);
    if (target === 'approved') {
      const configuredLimit=await tx.queryOne("SELECT setting_value FROM settings WHERE setting_key='d7_refund_approval_limit_paisa'");
      const approvalLimit=Number(configuredLimit?.setting_value||0);
      if(approvalLimit>0&&Number(refund.amount_paisa)>approvalLimit&&!(Array.isArray(actor.permissions)&&actor.permissions.includes('refunds.approve_high'))&&!['super_admin','superadmin'].includes(actor.roleSlug))throw new ConflictError('Refund exceeds the configured standard approval limit; a separate refunds.approve_high grant is required.');
      const reservedRows=await tx.queryAll(`SELECT id,amount_paisa FROM refunds WHERE order_id=? AND status IN (${RESERVED_REFUND_STATES.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,[refund.order_id,...RESERVED_REFUND_STATES]);
      const reserved=reservedRows.reduce((sum,row)=>sum+BigInt(row.amount_paisa),0n);
      if(!order || reserved>BigInt(order.paid_paisa||0))throw new ConflictError('Approved refund requests exceed recorded payments.');
    }
    await tx.execute('UPDATE refunds SET status=?,processed_by_user_id=? WHERE id=?', [target,actor.id||null,id]);
    await tx.execute('INSERT INTO refund_status_history (refund_id,from_status,to_status,reason,request_key,actor_user_id) VALUES (?,?,?,?,?,?)', [id,refund.status,target,note,key,actor.id||null]);
    await insertAudit(tx, actor, `refund.${target}`, 'refund', id, { status:refund.status }, { status:target, reason:note });
    return { id, status:target, replayed:false };
    });
  } catch(err) {
    if(err.code==='DB_DUPLICATE_ENTRY'){
      const replay=await client().queryOne('SELECT refund_id,to_status FROM refund_status_history WHERE request_key=?',[key]);
      if(replay){if(Number(replay.refund_id)!==id||replay.to_status!==target)throw new ConflictError('Refund decision key was used for a different request.');return{id,status:target,replayed:true};}
    }
    throw err;
  }
}
function normalizeCaptureCart(input) {
  if (!Array.isArray(input) || input.length > 100) throw new ValidationError('Cart contains too many items.');
  return input.map((row) => ({ product_id:requirePositiveInt(row.product_id ?? row.id,'product ID'), variant_id:row.variant_id ? requirePositiveInt(row.variant_id,'variant ID') : null, qty:requirePositiveInt(row.qty ?? row.quantity,'quantity',{max:99}) })).sort((a,b)=>a.product_id-b.product_id || (a.variant_id||0)-(b.variant_id||0));
}
async function recordIncompleteCheckout(input = {}) {
  if (input.consent !== true) return { recorded:false, reason:'consent_required' };
  assertMysql();
  const phone = normalizeBdPhone(input.phone);
  const sessionSid = requireString(input.sessionSid,'session',{min:24,max:128});
  const name = String(input.name || '').trim().slice(0,191);
  const cart = normalizeCaptureCart(input.cart || []);
  if (!cart.length) throw new ValidationError('A non-empty cart is required for recovery capture.');
  const payload = JSON.stringify(cart);
  const sessionHash = safeHash(sessionSid);
  const dedupeKey = safeHash(`${sessionHash}|${phone}|${payload}`);
  try {
    return await mysql.withTransaction(async (tx) => {
    const existing = await tx.queryOne('SELECT id,status,consent_withdrawn_at FROM incomplete_orders WHERE dedupe_key=?', [dedupeKey]);
    if (existing) {
      if (existing.consent_withdrawn_at || existing.status === 'withdrawn') return { recorded:false, reason:'consent_withdrawn' };
      await tx.execute('UPDATE incomplete_orders SET updated_at=UTC_TIMESTAMP() WHERE id=?', [existing.id]);
      return { recorded:true, id:Number(existing.id), duplicate:true };
    }
    const result = await tx.execute('INSERT INTO incomplete_orders (session_sid,dedupe_key,customer_name,phone,cart_json,consent_given,notification_allowed,status) VALUES (?,?,?,?,?,1,?,?)', [sessionHash,dedupeKey,name,phone,payload,input.notificationConsent === true ? 1 : 0,'abandoned']);
    await tx.execute('INSERT INTO incomplete_order_history (incomplete_order_id,from_status,to_status,reason) VALUES (?,\'\',\'abandoned\',\'Consent-recorded checkout abandonment\')', [result.insertId]);
    await insertAudit(tx,{type:'system'},'checkout.recovery.consent_captured','incomplete_order',result.insertId,null,{notificationAllowed:input.notificationConsent===true});
    return { recorded:true, id:result.insertId, duplicate:false };
    });
  } catch (err) {
    if(err.code==='DB_DUPLICATE_ENTRY'){
      const existing=await client().queryOne('SELECT id,status,consent_withdrawn_at FROM incomplete_orders WHERE dedupe_key=?',[dedupeKey]);
      if(existing?.consent_withdrawn_at||existing?.status==='withdrawn')return {recorded:false,reason:'consent_withdrawn'};
      if(existing)return {recorded:true,id:Number(existing.id),duplicate:true};
    }
    throw err;
  }
}
async function withdrawIncompleteCheckout(recordId, sessionSid) {
  assertMysql();
  const id=requirePositiveInt(recordId,'incomplete order ID');
  const sessionHash=safeHash(requireString(sessionSid,'session',{min:24,max:128}));
  return mysql.withTransaction(async tx=>{
    const row=await tx.queryOne('SELECT id,status,session_sid FROM incomplete_orders WHERE id=? FOR UPDATE',[id]);
    if(!row || row.session_sid!==sessionHash) throw new NotFoundError('Recovery consent record not found for this session.');
    if(row.status==='withdrawn') return {id,status:'withdrawn',replayed:true};
    if(!INCOMPLETE_STATES[row.status]?.includes('withdrawn')) throw new ConflictError(`Recovery consent cannot be withdrawn from ${row.status}.`);
    await tx.execute("UPDATE incomplete_orders SET status='withdrawn',consent_withdrawn_at=UTC_TIMESTAMP(),notification_allowed=0,phone='',customer_name='',session_sid='',cart_json=NULL WHERE id=?",[id]);
    await tx.execute("INSERT INTO incomplete_order_history (incomplete_order_id,from_status,to_status,reason) VALUES (?,?,'withdrawn','Customer withdrew recovery consent')",[id,row.status]);
    await insertAudit(tx,{type:'customer'},'checkout.recovery.consent_withdrawn','incomplete_order',id,{status:row.status},{status:'withdrawn'});
    return {id,status:'withdrawn',replayed:false};
  });
}
async function listIncompleteCheckouts({ search='',status='',page=1,limit=25 } = {}) {
  assertMysql();
  const q = String(search || '').trim().slice(0,100);
  const allowed = ['abandoned','contacted','recovery_started','recovered','withdrawn'];
  const filterStatus = allowed.includes(status) ? status : '';
  const pg = Math.max(1,Math.min(10000,Number(page)||1));
  const take = Math.max(1,Math.min(100,Number(limit)||25));
  const where = ['consent_given=1']; const params=[];
  if (q) { where.push('(phone LIKE ? OR customer_name LIKE ?)'); params.push(`%${q}%`,`%${q}%`); }
  if (filterStatus) { where.push('status=?'); params.push(filterStatus); }
  const db=client();
  const rows=await db.queryAll(`SELECT id,customer_name,phone,cart_json,status,notification_allowed,consent_withdrawn_at,recovered_order_id,created_at,updated_at FROM incomplete_orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,[...params,take,(pg-1)*take]);
  const total=await db.queryOne(`SELECT COUNT(*) AS total FROM incomplete_orders WHERE ${where.join(' AND ')}`,params);
  return { rows,total:Number(total?.total||0),page:pg,limit:take,totalPages:Math.ceil(Number(total?.total||0)/take) };
}
async function transitionIncompleteCheckout(recordId, targetStatus, reason, actor = {}, orderId = null) {
  assertMysql();
  const id=requirePositiveInt(recordId,'incomplete order ID'); const target=String(targetStatus||'').trim();
  const note=requireString(reason || target,'recovery status reason',{min:3,max:255});
  if (!Object.hasOwn(INCOMPLETE_STATES,target)) throw new ValidationError('Invalid recovery status.');
  return mysql.withTransaction(async(tx)=>{
    const row=await tx.queryOne('SELECT id,status,phone,dedupe_key,consent_withdrawn_at FROM incomplete_orders WHERE id=? FOR UPDATE',[id]);
    if(!row) throw new NotFoundError('Incomplete checkout record not found.');
    if(!INCOMPLETE_STATES[row.status]?.includes(target)) throw new ConflictError(`Recovery record cannot move from ${row.status} to ${target}.`);
    let linkedOrder=null;
    if(target==='recovered'){
      const oid=requirePositiveInt(orderId,'recovered order ID');
      linkedOrder=await tx.queryOne('SELECT id,customer_phone,idempotency_key FROM orders WHERE id=? FOR UPDATE',[oid]);
      if(!linkedOrder || linkedOrder.idempotency_key!==`incomplete:${id}` || normalizeBdPhone(linkedOrder.customer_phone)!==row.phone) throw new ConflictError('Recovered order must use this record’s idempotency key and verified phone.');
    }
    if(target==='withdrawn') await tx.execute('UPDATE incomplete_orders SET status=?,consent_withdrawn_at=UTC_TIMESTAMP(),notification_allowed=0,phone=\'\',customer_name=\'\',session_sid=\'\',cart_json=NULL WHERE id=?',[target,id]);
    else await tx.execute('UPDATE incomplete_orders SET status=?,recovered_order_id=? WHERE id=?',[target,linkedOrder?.id||null,id]);
    await tx.execute('INSERT INTO incomplete_order_history (incomplete_order_id,from_status,to_status,reason,actor_user_id) VALUES (?,?,?,?,?)',[id,row.status,target,note,actor.id||null]);
    await insertAudit(tx,actor,`checkout.recovery.${target}`,'incomplete_order',id,{status:row.status},{status:target,orderId:linkedOrder?.id||null});
    return { id,status:target,recoveredOrderId:linkedOrder?.id||null };
  });
}
async function createOrderOtp(phoneInput, { orderId=null,sessionSid='',customerId=null,policy={} } = {}) {
  assertMysql(); const phone=normalizeBdPhone(phoneInput); const cfg=validateOtpPolicy(policy);
  if(!cfg.enabled) throw new ConflictError('Order OTP is disabled by configuration.');
  const bindingCount=Number(Boolean(orderId))+Number(Boolean(sessionSid))+Number(Boolean(customerId));
  if(bindingCount!==1) throw new ValidationError('OTP must bind to exactly one order, customer account or checkout session.');
  const db=client(); let sidHash=''; let order=null;
  if(orderId){order=await db.queryOne('SELECT id,customer_id,customer_phone FROM orders WHERE id=?',[requirePositiveInt(orderId,'order ID')]); if(!order || normalizeBdPhone(order.customer_phone)!==phone) throw new NotFoundError('Order not found for this phone.');}
  if(customerId){const cust=await db.queryOne('SELECT id,phone FROM customers WHERE id=? AND status=1 AND is_blocked=0',[requirePositiveInt(customerId,'customer ID')]);if(!cust||normalizeBdPhone(cust.phone)!==phone)throw new NotFoundError('Customer account not found for this phone.');}
  if(sessionSid){sidHash=safeHash(requireString(sessionSid,'session',{min:24,max:128}));}
  const binding=safeHash(`${phone}|${order?.id||''}|${customerId||''}|${sidHash}`);
  const issueKey=`p08otp:issue:${safeHash(phone).slice(0,48)}`;
  const cooldownKey=`p08otp:cool:${binding.slice(0,48)}`;
  async function incrementBucket(key,seconds){
    await db.execute('INSERT INTO rate_limits (bucket_key,hit_count,reset_at) VALUES (?,1,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND)) ON DUPLICATE KEY UPDATE hit_count=IF(reset_at<=UTC_TIMESTAMP(),1,hit_count+1),reset_at=IF(reset_at<=UTC_TIMESTAMP(),DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? SECOND),reset_at)',[key,seconds,seconds]);
    return Number((await db.queryOne('SELECT hit_count FROM rate_limits WHERE bucket_key=?',[key]))?.hit_count||0);
  }
  const issued=await incrementBucket(issueKey,3600); if(issued>cfg.maxPerHour) throw new ConflictError('OTP issue limit reached.');
  const cooldown=await incrementBucket(cooldownKey,cfg.cooldownSeconds); if(cooldown>1) throw new ConflictError('Please wait before requesting another code.');
  const code=makeOtp(); const expiresAt=new Date(Date.now()+cfg.expirySeconds*1000);
  await db.execute('INSERT INTO order_otps (phone,session_hash,order_id,customer_id,otp_hash,attempts,max_attempts,expires_at) VALUES (?,?,?,?,?,0,?,?)',[phone,sidHash,order?.id||null,customerId||null,otpDigest(phone,code),cfg.maxAttempts,expiresAt]);
  // Internal handoff only. An authorized SMS adapter must deliver; this method does not send/log plaintext.
  return { phone,code,expiresAt,deliveryRequired:true,bindingHash:binding };
}
async function verifyOrderOtp(phoneInput,code,{orderId=null,sessionSid='',customerId=null}={}) {
  assertMysql();const phone=normalizeBdPhone(phoneInput);const candidate=String(code||'').trim();
  if(!/^\d{6}$/.test(candidate)) throw new ValidationError('Enter the six-digit verification code.');
  const conditions=['phone=?','verified_at IS NULL','expires_at>UTC_TIMESTAMP()','attempts<max_attempts'];const params=[phone];
  if(orderId){conditions.push('order_id=?');params.push(requirePositiveInt(orderId,'order ID'));}
  else if(customerId){conditions.push('customer_id=?');params.push(requirePositiveInt(customerId,'customer ID'));}
  else if(sessionSid){conditions.push('session_hash=?');params.push(safeHash(requireString(sessionSid,'session',{min:24,max:128})));}
  else throw new ValidationError('OTP verification requires the original order, account or session binding.');
  return mysql.withTransaction(async(tx)=>{
    const row=await tx.queryOne(`SELECT id,otp_hash,attempts,max_attempts,order_id FROM order_otps WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 1 FOR UPDATE`,params);
    if(!row)return false;
    const expected=Buffer.from(String(row.otp_hash),'hex');const actual=Buffer.from(otpDigest(phone,candidate),'hex');
    const valid=expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);
    if(!valid){await tx.execute('UPDATE order_otps SET attempts=attempts+1 WHERE id=?',[row.id]);return false;}
    await tx.execute('UPDATE order_otps SET verified_at=UTC_TIMESTAMP() WHERE id=? AND verified_at IS NULL',[row.id]);
    if(row.order_id) await tx.execute("UPDATE orders SET otp_status='verified' WHERE id=? AND customer_phone=?",[row.order_id,phone]);
    await insertAudit(tx,{id:null},'otp.verified','order_otp',row.id,null,{bindingType:row.order_id?'order':'session'});
    return true;
  });
}
async function getPhase08Settings(){
  const db=client();const keys=['otp_mode','otp_expiry_seconds','otp_max_attempts','otp_cooldown_seconds','otp_max_per_hour','advance_payment_mode','advance_payment_value','advance_min_order_paisa','advance_max_order_paisa'];
  const rows=await db.queryAll(`SELECT setting_key,setting_value FROM settings WHERE setting_key IN (${keys.map(()=>'?').join(',')})`,keys);
  return Object.fromEntries(rows.map(r=>[r.setting_key,r.setting_value]));
}
async function savePhase08Settings(input,actor={}){
  assertMysql();const otp=validateOtpPolicy({enabled:input.otp_mode==='on',expirySeconds:Number(input.otp_expiry_seconds??300),maxAttempts:Number(input.otp_max_attempts??5),cooldownSeconds:Number(input.otp_cooldown_seconds??60),maxPerHour:Number(input.otp_max_per_hour??5)});
  const advance=validateAdvancePolicy({mode:input.advance_payment_mode||'off',value:Number(input.advance_payment_value??0),minimumPaisa:input.advance_min_order_paisa||0,maximumPaisa:input.advance_max_order_paisa||null});
  return mysql.withTransaction(async(tx)=>{
    const settings={otp_mode:otp.enabled?'on':'off',otp_expiry_seconds:String(otp.expirySeconds),otp_max_attempts:String(otp.maxAttempts),otp_cooldown_seconds:String(otp.cooldownSeconds),otp_max_per_hour:String(otp.maxPerHour),advance_payment_mode:advance.mode,advance_payment_value:String(advance.value),advance_min_order_paisa:String(advance.minimumPaisa),advance_max_order_paisa:advance.maximumPaisa===null?'':String(advance.maximumPaisa)};
    for(const [key,value] of Object.entries(settings))await tx.execute('INSERT INTO settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',[key,value]);
    await insertAudit(tx,actor,'checkout.policy.updated','settings','phase08',null,{otpMode:settings.otp_mode,advanceMode:settings.advance_payment_mode});
    return settings;
  });
}
async function listOrders({search='',status='',page=1,limit=25}={}){
  assertMysql();const q=String(search||'').trim().slice(0,100);const pg=Math.max(1,Math.min(10000,Number(page)||1));const take=Math.max(1,Math.min(100,Number(limit)||25));const where=[];const params=[];
  if(status){if(!Object.hasOwn(TRANSITIONS,status))throw new ValidationError('Invalid order status filter.');where.push('o.order_status=?');params.push(status);}
  if(q){where.push('(o.invoice_no LIKE ? OR o.customer_phone LIKE ? OR o.customer_name LIKE ?)');params.push(`%${q}%`,`%${q}%`,`%${q}%`);}
  const clause=where.length?`WHERE ${where.join(' AND ')}`:'';const db=client();const rows=await db.queryAll(`SELECT o.id,o.invoice_no,o.customer_name,o.customer_phone,o.total_paisa,o.paid_paisa,o.cod_due_paisa,o.order_status,o.otp_status,o.created_at FROM orders o ${clause} ORDER BY o.id DESC LIMIT ? OFFSET ?`,[...params,take,(pg-1)*take]);const total=await db.queryOne(`SELECT COUNT(*) AS total FROM orders o ${clause}`,params);return{rows,total:Number(total?.total||0),page:pg,limit:take,totalPages:Math.ceil(Number(total?.total||0)/take)};
}
async function listRefunds({search='',status='',page=1,limit=25}={}){
  assertMysql();const valid=['requested','pending','approved','processing','succeeded','failed','rejected','completed'];if(status&&!valid.includes(status))throw new ValidationError('Invalid refund status filter.');const q=String(search||'').trim().slice(0,100);const pg=Math.max(1,Math.min(10000,Number(page)||1));const take=Math.max(1,Math.min(100,Number(limit)||25));const where=[];const params=[];if(status){where.push('r.status=?');params.push(status);}if(q){where.push('(r.invoice_no LIKE ? OR o.customer_phone LIKE ?)');params.push(`%${q}%`,`%${q}%`);}const clause=where.length?`WHERE ${where.join(' AND ')}`:'';const db=client();const rows=await db.queryAll(`SELECT r.id,r.order_id,r.invoice_no,r.amount_paisa,r.reason,r.status,r.request_key,r.created_at,o.customer_name,o.customer_phone FROM refunds r JOIN orders o ON o.id=r.order_id ${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`,[...params,take,(pg-1)*take]);const total=await db.queryOne(`SELECT COUNT(*) AS total FROM refunds r JOIN orders o ON o.id=r.order_id ${clause}`,params);return{rows,total:Number(total?.total||0),page:pg,limit:take,totalPages:Math.ceil(Number(total?.total||0)/take)};
}
async function listRefundHistory(refundId){assertMysql();return client().queryAll('SELECT h.*,u.name AS actor_name FROM refund_status_history h LEFT JOIN users u ON u.id=h.actor_user_id WHERE h.refund_id=? ORDER BY h.id',[requirePositiveInt(refundId,'refund ID')]);}
async function getOrderOtpStatus(orderId){
  assertMysql();const id=requirePositiveInt(orderId,'order ID');const db=client();
  const order=await db.queryOne('SELECT id,otp_status FROM orders WHERE id=?',[id]);if(!order)throw new NotFoundError('Order not found.');
  const summary=await db.queryOne('SELECT COUNT(*) AS issued_count,SUM(verified_at IS NOT NULL) AS verified_count,MAX(attempts) AS max_attempts,MAX(expires_at) AS latest_expiry FROM order_otps WHERE order_id=?',[id]);
  return{orderId:id,status:order.otp_status,issuedCount:Number(summary?.issued_count||0),verifiedCount:Number(summary?.verified_count||0),maxAttempts:Number(summary?.max_attempts||0),latestExpiry:summary?.latest_expiry||null};
}
async function listOrderHistory(orderId){assertMysql();return client().queryAll('SELECT h.*,u.name AS actor_name FROM order_status_history h LEFT JOIN users u ON u.id=h.changed_by_user_id WHERE h.order_id=? ORDER BY h.id',[requirePositiveInt(orderId,'order ID')]);}

module.exports={TRANSITIONS,REFUND_STATES,INCOMPLETE_STATES,validateOtpPolicy,validateAdvancePolicy,calculateAdvance,computeOrderPayment,otpDigest,makeOtp,normalizeCaptureCart,normalizeOrderLines,orderReservationKey,transitionOrder,transitionOrderTx,requestRefund,transitionRefund,recordIncompleteCheckout,withdrawIncompleteCheckout,listIncompleteCheckouts,transitionIncompleteCheckout,createOrderOtp,verifyOrderOtp,getPhase08Settings,savePhase08Settings,listOrders,listRefunds,listRefundHistory,listOrderHistory,getOrderOtpStatus,reserveOrderInventory:async(orderId,actor={})=>mysql.withTransaction(tx=>reserveOrderInventoryTx(tx,requirePositiveInt(orderId,'order ID'),actor)),reserveOrderInventoryTx,releaseOrderInventory:async(orderId,actor={},reason='Order cancelled')=>mysql.withTransaction(tx=>releaseOrderInventoryTx(tx,requirePositiveInt(orderId,'order ID'),actor,reason)),listExpiredOrderReservationCandidates,expireExpiredOrderReservations};
