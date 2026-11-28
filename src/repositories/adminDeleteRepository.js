'use strict';

// Real delete for admin records. A record is removed only when nothing about money or
// stock depends on it. Otherwise the reason and the practical alternative are returned.
const mysql = require('../db/mysqlPool');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

function positive(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('Invalid record.');
  return id;
}
async function audit(tx, actor, action, type, id, before) {
  await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,ip_address,user_agent) VALUES('admin',?,?,?,?,?,?,?)",
    [actor.id || null, action, type, String(id), JSON.stringify(before), String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]);
}
const count = async (tx, sql, params) => Number((await tx.queryOne(sql, params)).n || 0);

// A supplier with purchases is made inactive so the purchase history keeps its name.
async function deleteSupplier(idInput, actor = {}) {
  const id = positive(idInput);
  return mysql.withTransaction(async (tx) => {
    const supplier = await tx.queryOne('SELECT id,name,phone,balance_due_paisa,status FROM suppliers WHERE id=? FOR UPDATE', [id]);
    if (!supplier) throw new NotFoundError('Supplier not found.');
    const purchases = await count(tx, 'SELECT COUNT(*) AS n FROM purchases WHERE supplier_id=?', [id]);
    if (purchases || Number(supplier.balance_due_paisa)) {
      await tx.execute('UPDATE suppliers SET status=0 WHERE id=?', [id]);
      await audit(tx, actor, 'supplier.deactivate', 'supplier', id, { name: supplier.name, status: Number(supplier.status), purchases });
      return { deleted: false, deactivated: true };
    }
    await tx.execute('DELETE FROM suppliers WHERE id=?', [id]);
    await audit(tx, actor, 'supplier.delete', 'supplier', id, { name: supplier.name, phone: supplier.phone });
    return { deleted: true };
  });
}

async function deletePurchase(idInput, actor = {}) {
  const id = positive(idInput);
  return mysql.withTransaction(async (tx) => {
    const purchase = await tx.queryOne('SELECT id,reference_no,supplier_id,total_cost_paisa,paid_amount_paisa,receive_status FROM purchases WHERE id=? FOR UPDATE', [id]);
    if (!purchase) throw new NotFoundError('Purchase not found.');
    const received = await count(tx, 'SELECT COALESCE(SUM(received_qty),0) AS n FROM purchase_items WHERE purchase_id=?', [id]);
    const receipts = await count(tx, 'SELECT COUNT(*) AS n FROM purchase_receipts WHERE purchase_id=?', [id]);
    if (received || receipts) throw new ConflictError('Goods from this purchase were already received into stock, so it cannot be deleted. Correct the stock with an inventory adjustment.');
    if (Number(purchase.paid_amount_paisa) > 0) throw new ConflictError('A payment is recorded on this purchase, so it cannot be deleted.');
    await tx.execute('DELETE FROM purchase_items WHERE purchase_id=?', [id]);
    await tx.execute('DELETE FROM purchases WHERE id=?', [id]);
    await audit(tx, actor, 'purchase.delete', 'purchase', id, purchase);
    return { deleted: true };
  });
}

async function deleteIncompleteCheckout(idInput, actor = {}) {
  const id = positive(idInput);
  return mysql.withTransaction(async (tx) => {
    const row = await tx.queryOne('SELECT id,status,recovered_order_id FROM incomplete_orders WHERE id=? FOR UPDATE', [id]);
    if (!row) throw new NotFoundError('Record not found.');
    await tx.execute('DELETE FROM incomplete_order_history WHERE incomplete_order_id=?', [id]);
    await tx.execute('DELETE FROM incomplete_orders WHERE id=?', [id]);
    // The audit row keeps no name, phone or cart.
    await audit(tx, actor, 'checkout.recovery.delete', 'incomplete_order', id, { status: row.status, recoveredOrderId: row.recovered_order_id });
    return { deleted: true };
  });
}

async function deleteRefundRequest(idInput, actor = {}) {
  const id = positive(idInput);
  return mysql.withTransaction(async (tx) => {
    const refund = await tx.queryOne('SELECT id,order_id,invoice_no,amount_paisa,status,reason FROM refunds WHERE id=? FOR UPDATE', [id]);
    if (!refund) throw new NotFoundError('Refund request not found.');
    if (!['requested', 'pending', 'rejected'].includes(refund.status)) throw new ConflictError('Money was already returned or approved for this refund, so its record cannot be deleted.');
    await tx.execute('DELETE FROM refund_status_history WHERE refund_id=?', [id]);
    await tx.execute('DELETE FROM refunds WHERE id=?', [id]);
    await audit(tx, actor, 'refund.delete', 'refund', id, refund);
    return { deleted: true };
  });
}

// Checks in order of what an administrator can act on first.
const ORDER_BLOCKERS = Object.freeze([
  ['SELECT COUNT(*) AS n FROM refunds WHERE order_id=?', 'This order has a refund record. It must be kept for the accounts.'],
  ["SELECT COUNT(*) AS n FROM order_payments WHERE order_id=? AND status<>'rejected'", 'This order has a payment record that was not rejected. Check the payment first; reject it only if no money arrived.'],
  ['SELECT COUNT(*) AS n FROM payment_transactions WHERE order_id=?', 'This order has an online payment record. It must be kept for the accounts.'],
  ["SELECT COUNT(*) AS n FROM customer_wallet_transactions WHERE reference_id=CONCAT('order:',?)", 'Wallet money was used on this order. It must be kept so the wallet history stays correct.'],
  ['SELECT COUNT(*) AS n FROM courier_shipments WHERE order_id=?', 'This order was given to a courier. It must be kept.'],
  ['SELECT COUNT(*) AS n FROM vendor_sub_orders WHERE order_id=?', 'This order contains vendor products and is part of the vendor accounts.'],
  ['SELECT COUNT(*) AS n FROM vendor_orders WHERE order_id=?', 'This order contains vendor products and is part of the vendor accounts.'],
  ['SELECT COUNT(*) AS n FROM vendor_order_item_history WHERE order_id=?', 'This order contains vendor products and is part of the vendor accounts.'],
  ['SELECT COUNT(*) AS n FROM vendor_order_status_history WHERE order_id=?', 'This order contains vendor products and is part of the vendor accounts.'],
  ['SELECT COUNT(*) AS n FROM vendor_courier_booking_requests WHERE order_id=?', 'This order was given to a courier. It must be kept.'],
  ['SELECT COUNT(*) AS n FROM reseller_financial_ledger WHERE order_id=?', 'This order is part of a reseller account.'],
  ['SELECT COUNT(*) AS n FROM customer_return_requests WHERE order_id=?', 'This order has a return request. It must be kept.'],
  ["SELECT COUNT(*) AS n FROM referral_rewards WHERE order_id=? AND status NOT IN ('cancelled','rejected')", 'A referral reward is linked to this order.'],
  ["SELECT COUNT(*) AS n FROM affiliate_commissions WHERE order_id=? AND status NOT IN ('cancelled','rejected')", 'An affiliate commission is linked to this order.'],
]);

// For test, fake or duplicate orders: cancelled or failed, with no money and no courier.
async function deleteOrder(idInput, actor = {}) {
  const id = positive(idInput);
  return mysql.withTransaction(async (tx) => {
    const order = await tx.queryOne('SELECT id,invoice_no,customer_name,customer_phone,total_paisa,paid_paisa,payment_method,order_status,reseller_id FROM orders WHERE id=? FOR UPDATE', [id]);
    if (!order) throw new NotFoundError('Order not found.');
    if (!['cancelled', 'failed'].includes(order.order_status)) throw new ConflictError('Cancel the order first. Only cancelled or failed orders can be deleted.');
    if (Number(order.paid_paisa) > 0) throw new ConflictError('Money was received for this order. It must be kept for the accounts.');
    for (const [sql, message] of ORDER_BLOCKERS) if (await count(tx, sql, [id])) throw new ConflictError(message);
    const held = await count(tx, "SELECT COUNT(*) AS n FROM stock_reservations WHERE reservation_key=CONCAT('order:',?) AND status='active'", [id]);
    if (held) throw new ConflictError('Stock is still reserved for this order. Cancel the order again before deleting it.');
    const items = await tx.queryAll('SELECT product_id,product_name,qty,line_total_paisa FROM order_items WHERE order_id=?', [id]);
    await tx.execute("DELETE FROM referral_rewards WHERE order_id=? AND status IN ('cancelled','rejected')", [id]);
    await tx.execute("DELETE FROM affiliate_commissions WHERE order_id=? AND status IN ('cancelled','rejected')", [id]);
    await tx.execute('DELETE FROM order_cancellation_requests WHERE order_id=?', [id]);
    await tx.execute('DELETE FROM order_payments WHERE order_id=?', [id]);
    await tx.execute('DELETE FROM order_items WHERE order_id=?', [id]);
    await tx.execute('DELETE FROM orders WHERE id=?', [id]);
    await audit(tx, actor, 'order.delete', 'order', id, { ...order, items });
    return { deleted: true, invoiceNo: order.invoice_no };
  });
}

// Plain records with nothing else depending on them. The audit row stores no message text or phone number.
function simpleDelete(table, action, type, notFound, keep) {
  return async (idInput, actor = {}) => {
    const id = positive(idInput);
    return mysql.withTransaction(async (tx) => {
      const row = await tx.queryOne(`SELECT ${keep} FROM ${table} WHERE id=? FOR UPDATE`, [id]);
      if (!row) throw new NotFoundError(notFound);
      await tx.execute(`DELETE FROM ${table} WHERE id=?`, [id]);
      await audit(tx, actor, action, type, id, row);
      return { deleted: true };
    });
  };
}
const deleteComplaint = simpleDelete('complaints', 'customer.complaint.delete', 'complaint', 'Complaint not found.', 'id,status,invoice_no');
const deleteContactMessage = simpleDelete('contact_messages', 'customer.contact_message.delete', 'contact_message', 'Message not found.', 'id,status');
const deleteReview = simpleDelete('reviews', 'catalog.review.delete', 'review', 'Review not found.', 'id,product_id,rating,status');
// Removing a block is how a wrongly blocked customer is allowed to order again.
const deleteIpBlock = simpleDelete('ip_blocks', 'customer.ip_block.removed', 'ip_block', 'Block entry not found.', 'id,target_type,ip_or_phone,reason');

// A courier that is still carrying parcels is needed for tracking. The audit row keeps no key or secret.
async function deleteCourierApi(idInput, actor = {}) {
  const id = positive(idInput);
  return mysql.withTransaction(async (tx) => {
    const row = await tx.queryOne('SELECT id,name,code,status FROM courier_apis WHERE id=? FOR UPDATE', [id]);
    if (!row) throw new NotFoundError('Courier setting not found.');
    const open = await count(tx, 'SELECT COUNT(*) AS n FROM courier_shipments WHERE LOWER(courier_code)=LOWER(?) AND is_active=1', [row.code]);
    const queued = await count(tx, "SELECT COUNT(*) AS n FROM vendor_courier_booking_requests WHERE LOWER(courier_code)=LOWER(?) AND active_sub_order_id IS NOT NULL", [row.code]);
    if (open || queued) throw new ConflictError('This courier still has open parcels or booking requests. Turn it off with Toggle Active instead, and delete it after they are finished.');
    await tx.execute('DELETE FROM courier_apis WHERE id=?', [id]);
    await audit(tx, actor, 'courier.api.delete', 'courier_api', id, row);
    return { deleted: true };
  });
}

module.exports = { deleteCourierApi, deleteComplaint, deleteContactMessage, deleteReview, deleteIpBlock, deleteSupplier, deletePurchase, deleteIncompleteCheckout, deleteRefundRequest, deleteOrder };
