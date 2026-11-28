'use strict';

/**
 * Courier booking for the shop's own parcel of an order (vendor parcels have their own flow).
 *
 * A booking is never repeated blindly: a "started" audit row is committed before the
 * courier is called. If no result follows (timeout, crash), the next attempt is refused
 * until the admin confirms that the courier panel shows no parcel for this invoice.
 */
const mysql = require('../db/mysqlPool');
const CourierProviderFactory = require('./courier/CourierProviderFactory');
const CourierBaseAdapter = require('./courier/CourierBaseAdapter');
const { env } = require('../config/env');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const SUPPORTED_ADAPTERS = ['SteadfastAdapter', 'PathaoAdapter', 'RedxAdapter', 'MockCourierAdapter'];
const CLOSED_STATUSES = ['delivered', 'completed', 'cancelled', 'returned', 'refunded'];
const ACTIONS = { started: 'courier.own_order.started', booked: 'courier.own_order.booked', failed: 'courier.own_order.failed', unknown: 'courier.own_order.unknown' };
// A request that is still running is not something the admin can override.
const IN_FLIGHT_SECONDS = 90;

const pick = (locale, en, bn) => (locale === 'bn' ? bn : en);

async function writeAudit(db, actor, action, orderId, data) {
  await db.execute(
    `INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,after_json,ip_address,user_agent)
     VALUES ('admin',?,?,'order',?,?,?,?)`,
    [actor.id || null, action, String(orderId), JSON.stringify(data), String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]
  );
}

async function lastBookingEvent(db, orderId) {
  return db.queryOne(
    `SELECT action, TIMESTAMPDIFF(SECOND, created_at, CURRENT_TIMESTAMP) AS age_seconds FROM audit_logs
      WHERE entity_type='order' AND entity_id=? AND action IN (?,?,?,?) ORDER BY id DESC LIMIT 1`,
    [String(orderId), ACTIONS.started, ACTIONS.booked, ACTIONS.failed, ACTIONS.unknown]
  );
}

async function readParcel(db, orderId, lock = false) {
  const order = await db.queryOne(`SELECT * FROM orders WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [orderId]);
  if (!order) throw new NotFoundError('Order not found.');
  const parts = await db.queryOne(
    `SELECT COALESCE(SUM(vendor_id IS NULL),0) AS own_items, COALESCE(SUM(vendor_id IS NOT NULL),0) AS vendor_items,
            COALESCE(SUM(IF(vendor_id IS NULL,line_total_paisa,0)),0) AS own_value_paisa
       FROM order_items WHERE order_id=?`, [orderId]);
  const vendor = await db.queryOne(
    "SELECT COALESCE(SUM(cod_due_paisa),0) AS cod_paisa FROM vendor_sub_orders WHERE order_id=? AND status<>'cancelled'", [orderId]);
  return {
    order,
    ownItems: Number(parts?.own_items || 0),
    vendorItems: Number(parts?.vendor_items || 0),
    ownValuePaisa: Number(parts?.own_value_paisa || 0),
    codPaisa: Math.max(0, Number(order.cod_due_paisa || 0) - Number(vendor?.cod_paisa || 0))
  };
}

async function blockReason(db, parcel) {
  const { order } = parcel;
  if (!parcel.ownItems) return ['This order has only vendor products. Vendor parcels are booked from the vendor parcel page.', 'এই অর্ডারে শুধু ভেন্ডরের পণ্য আছে। ভেন্ডর পার্সেল ভেন্ডর পার্সেল পেজ থেকে বুক হয়।'];
  if (CLOSED_STATUSES.includes(String(order.order_status))) return [`An order with status "${order.order_status}" cannot be booked.`, `"${order.order_status}" অবস্থার অর্ডার কুরিয়ারে বুক করা যায় না।`];
  if (String(order.payment_status) === 'pending_verification') return ['Approve or reject the customer\'s payment first, then book the courier.', 'আগে ক্রেতার পেমেন্ট অনুমোদন বা বাতিল করুন, তারপর কুরিয়ার বুক করুন।'];
  if (String(order.courier_tracking_id || '')) {
    const fromVendor = await db.queryOne(
      'SELECT 1 AS n FROM vendor_sub_orders WHERE order_id=? AND tracking_code=? LIMIT 1', [order.id, order.courier_tracking_id]);
    if (!fromVendor) return [`This order already has tracking ID ${order.courier_tracking_id}. To book again, first clear the courier on this page and save.`, `এই অর্ডারে আগেই ট্র্যাকিং আইডি ${order.courier_tracking_id} আছে। আবার বুক করতে হলে আগে এই পেজে কুরিয়ার খালি করে সেভ করুন।`];
  }
  return null;
}

/** What the order page needs to show the booking card. */
async function getBookingPanel(orderId) {
  const db = mysql.createQueryClient(mysql.getPool());
  const parcel = await readParcel(db, Number(orderId));
  const rows = await db.queryAll('SELECT * FROM courier_apis WHERE status=1 ORDER BY id ASC');
  const couriers = rows.map((row) => {
    const adapter = CourierProviderFactory.createAdapter(row);
    const kind = adapter.constructor.name;
    return {
      id: Number(row.id), name: String(row.name), code: String(row.code),
      automatic: SUPPORTED_ADAPTERS.includes(kind), needsArea: kind === 'RedxAdapter', testMode: Boolean(adapter.isSandbox)
    };
  }).filter((courier) => courier.automatic);
  const last = await lastBookingEvent(db, parcel.order.id);
  return {
    couriers,
    blocked: await blockReason(db, parcel),
    needsConfirm: Boolean(last && [ACTIONS.started, ACTIONS.unknown].includes(last.action) && !String(parcel.order.courier_tracking_id || '')),
    codTaka: parcel.codPaisa / 100,
    hasVendorItems: parcel.vendorItems > 0,
    trackingId: String(parcel.order.courier_tracking_id || ''),
    courierCode: String(parcel.order.courier_code || '')
  };
}

async function bookOwnOrder({ orderId: orderIdInput, courierId, areaId, areaName, note, confirmedNoParcel, actor = {}, locale = 'en' }) {
  const orderId = Number(orderIdInput);
  if (!Number.isSafeInteger(orderId) || orderId < 1) throw new ValidationError('Invalid order.');

  const prepared = await mysql.withTransaction(async (tx) => {
    const parcel = await readParcel(tx, orderId, true);
    const reason = await blockReason(tx, parcel);
    if (reason) throw new ConflictError(pick(locale, ...reason));
    const row = await tx.queryOne('SELECT * FROM courier_apis WHERE id=? AND status=1', [Number(courierId) || 0]);
    if (!row) throw new ValidationError(pick(locale, 'Choose an active courier.', 'একটি চালু কুরিয়ার বেছে নিন।'));
    const adapter = CourierProviderFactory.createAdapter(row);
    if (!SUPPORTED_ADAPTERS.includes(adapter.constructor.name)) {
      throw new ValidationError(pick(locale, 'Automatic booking is not available for this courier. Type its tracking ID by hand.', 'এই কুরিয়ারে স্বয়ংক্রিয় বুকিং নেই। ট্র্যাকিং আইডি হাতে লিখুন।'));
    }
    if (env.isProduction && adapter.isSandbox) {
      throw new ValidationError(pick(locale, `${row.name} is in test mode, which does not create a real parcel. Set its mode to Live in Admin → Courier API first.`, `${row.name} টেস্ট মোডে আছে, এতে আসল পার্সেল তৈরি হয় না। আগে অ্যাডমিন → কুরিয়ার API থেকে Live করুন।`));
    }
    if (adapter.constructor.name === 'PathaoAdapter' && !adapter.isSandbox && !adapter.storeId) {
      throw new ValidationError(pick(locale, 'Add the Pathao Store ID in Admin → Courier API first.', 'আগে অ্যাডমিন → কুরিয়ার API-তে Pathao Store ID দিন।'));
    }
    if (adapter.constructor.name === 'RedxAdapter' && !adapter.isSandbox && !(Number(areaId) > 0)) {
      throw new ValidationError(pick(locale, 'Choose the RedX delivery area first.', 'আগে RedX ডেলিভারি এলাকা বেছে নিন।'));
    }
    const last = await lastBookingEvent(tx, orderId);
    if (last && last.action === ACTIONS.started && Number(last.age_seconds) < IN_FLIGHT_SECONDS) {
      throw new ConflictError(pick(locale, 'A booking request for this order is still running. Wait a minute and reload the page.', 'এই অর্ডারের একটি বুকিং অনুরোধ এখনো চলছে। এক মিনিট পরে পেজটি রিলোড করুন।'));
    }
    if (last && [ACTIONS.started, ACTIONS.unknown].includes(last.action) && !String(parcel.order.courier_tracking_id || '') && !confirmedNoParcel) {
      throw new ConflictError(pick(locale, 'The result of the last booking is unknown. Check the courier panel for this invoice, then tick the confirmation box before booking again.', 'আগের বুকিংয়ের ফল জানা যায়নি। কুরিয়ার প্যানেলে এই ইনভয়েস খুঁজে দেখুন, তারপর নিশ্চিতকরণ বক্সে টিক দিয়ে আবার বুক করুন।'));
    }
    await writeAudit(tx, actor, ACTIONS.started, orderId, { courier: row.code });
    return { parcel, row };
  });

  const { parcel, row } = prepared;
  const { order } = parcel;
  const adapter = CourierProviderFactory.createAdapter(row);
  // Delivery zones may use "All" as a catch-all placeholder; it is not part of a real address.
  const district = String(order.district || '').trim().toLowerCase() === 'all' ? '' : String(order.district || '').trim();
  const typed = String(order.shipping_address || '').trim();
  // The customer types a full address; zone names are added only when it is too short for the courier.
  const addressText = (typed.length >= 15 ? [typed] : [typed, order.upazila, district])
    .filter(Boolean).join(', ');
  // Mixed orders book more than one parcel, so the shop's parcel gets its own reference.
  const reference = parcel.vendorItems ? `${order.invoice_no}-S` : String(order.invoice_no);

  let result;
  try {
    result = await adapter.bookShipment({
      subOrderId: order.id,
      invoiceNo: reference,
      recipient: {
        name: order.customer_name, phone: order.customer_phone, address: addressText,
        district: district || order.shipping_zone || 'Dhaka',
        note: String(note || '').trim().slice(0, 200) || `Order #${order.invoice_no}`
      },
      parcel: { weightGrams: 1000, deliveryAreaId: Number(areaId) || 0, deliveryAreaName: String(areaName || '').trim().slice(0, 120), valuePaisa: parcel.ownValuePaisa },
      codAmountPaisa: parcel.codPaisa,
      idempotencyKey: `own-${order.id}`
    });
  } catch (error) {
    result = { success: false, isTimeout: true, error: error.message };
  }

  const db = mysql.createQueryClient(mysql.getPool());
  if (!result.success) {
    // A network failure or an unreadable answer may still have created the parcel.
    const code = String(result.rawResponse?.code || '');
    const unknown = Boolean(result.isTimeout || result.isUnknownOutcome || code === 'COURIER_NETWORK_ERROR' || /network error|JSON/i.test(String(result.error || '')));
    await writeAudit(db, actor, unknown ? ACTIONS.unknown : ACTIONS.failed, orderId, { courier: row.code, error: String(result.error || '').slice(0, 300) });
    throw new ConflictError(unknown
      ? pick(locale, `The courier did not give a clear answer. Check the ${row.name} panel for ${reference} before trying again. (${result.error})`, `কুরিয়ার থেকে পরিষ্কার উত্তর আসেনি। আবার চেষ্টার আগে ${row.name} প্যানেলে ${reference} খুঁজে দেখুন। (${result.error})`)
      : pick(locale, `${row.name} did not accept the booking: ${result.error}`, `${row.name} বুকিং নেয়নি: ${result.error}`));
  }

  const tracking = String(result.trackingId || '').slice(0, 100);
  await mysql.withTransaction(async (tx) => {
    await tx.execute('UPDATE orders SET courier_code=?, courier_tracking_id=? WHERE id=?', [row.code, tracking, orderId]);
    await writeAudit(tx, actor, ACTIONS.booked, orderId, {
      courier: row.code, tracking, consignment: String(result.consignmentId || ''), codPaisa: parcel.codPaisa,
      response: CourierBaseAdapter.sanitize(result.rawResponse || {})
    });
  });
  return { courierName: String(row.name), trackingId: tracking, reference, codTaka: parcel.codPaisa / 100 };
}

/** Asks the courier for the current status. It only reports; the admin changes the order status. */
async function checkOwnOrderStatus(orderIdInput, locale = 'en') {
  const db = mysql.createQueryClient(mysql.getPool());
  const order = await db.queryOne('SELECT courier_code, courier_tracking_id FROM orders WHERE id=?', [Number(orderIdInput) || 0]);
  if (!order) throw new NotFoundError('Order not found.');
  const row = order.courier_code ? await db.queryOne('SELECT * FROM courier_apis WHERE code=? LIMIT 1', [order.courier_code]) : null;
  if (!row || !order.courier_tracking_id) {
    throw new ValidationError(pick(locale, 'This order has no courier booking to check.', 'এই অর্ডারে যাচাই করার মতো কোনো কুরিয়ার বুকিং নেই।'));
  }
  const data = await CourierProviderFactory.createAdapter(row).trackShipment(order.courier_tracking_id);
  if (['error', 'unconfigured', 'unknown'].includes(String(data.rawStatus || '').toLowerCase())) {
    const detail = data.events?.[0]?.note || '';
    throw new ConflictError(pick(locale, `${row.name} did not return a status. ${detail}`, `${row.name} থেকে অবস্থা পাওয়া যায়নি। ${detail}`));
  }
  return { courierName: String(row.name), trackingId: String(order.courier_tracking_id), rawStatus: String(data.rawStatus) };
}

module.exports = { getBookingPanel, bookOwnOrder, checkOwnOrderStatus };
