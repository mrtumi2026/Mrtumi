'use strict';

const { getPool, createQueryClient } = require('../db/mysqlPool');
const { paisaToBdtString } = require('../utils/money');

function toBdtString(value) {
  return paisaToBdtString(Number(value || 0), { fixedDecimals: true });
}

/** Read-only projection matching the legacy printable invoice view over canonical MySQL rows. */
async function getAdminInvoice(orderId, poolOverride = null) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const client = createQueryClient(poolOverride || getPool());
  const row = await client.queryOne(
    `SELECT o.id,o.invoice_no AS invoice_id,o.created_at,
            COALESCE(os.name,o.order_status) AS status_label,
            o.customer_name,o.customer_phone AS phone,o.shipping_address AS address,
            o.payment_method,o.payment_status,
            COALESCE(NULLIF(ca.name,''),o.courier_code,'') AS courier_name,
            o.courier_tracking_id,
            o.subtotal_paisa,o.shipping_paisa,o.discount_paisa,o.total_paisa
       FROM orders o
       LEFT JOIN order_statuses os ON os.slug=o.order_status
       LEFT JOIN courier_apis ca ON ca.code=o.courier_code
      WHERE o.id=? LIMIT 1`,
    [id]
  );
  if (!row) return null;

  const items = await client.queryAll(
    `SELECT id,product_name,product_image,qty,size_label AS size,
            unit_price_paisa,line_total_paisa
       FROM order_items
      WHERE order_id=? ORDER BY id ASC`,
    [row.id]
  );
  const order = {
    ...row,
    subtotal: toBdtString(row.subtotal_paisa),
    shipping_charge: toBdtString(row.shipping_paisa),
    discount: toBdtString(row.discount_paisa),
    amount: toBdtString(row.total_paisa),
  };
  return {
    order,
    items: items.map((item) => ({
      ...item,
      price: toBdtString(item.unit_price_paisa),
    })),
  };
}

/**
 * Platform-wide detail view projection for the legacy admin order page.
 * Opening an existing order retains the route's historical is_seen read-tracking update.
 */
async function getAdminOrderDetail(orderId, poolOverride = null) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const client = createQueryClient(poolOverride || getPool());
  const row = await client.queryOne(
    `SELECT o.id,o.invoice_no AS invoice_id,o.customer_name,o.customer_phone AS phone,
            o.shipping_address AS address,o.shipping_zone AS shipping_area,
            o.subtotal_paisa,o.shipping_paisa,o.discount_paisa,o.total_paisa,
            o.coupon_code,o.payment_method,o.payment_status,o.order_status AS status,
            COALESCE(os.name,o.order_status) AS status_label,
            COALESCE(os.badge_class,'sb-1') AS badge_class,
            COALESCE(NULLIF(ca.name,''),o.courier_code,'') AS courier_name,
            o.courier_tracking_id,o.delivery_boy_id,o.traffic_source,
            o.order_channel AS order_type,o.customer_note AS note,o.admin_note,o.created_at,
            (SELECT op.provider_trx_id FROM order_payments op WHERE op.order_id=o.id ORDER BY op.id DESC LIMIT 1) AS trx_id,
            (SELECT op.sender_number FROM order_payments op WHERE op.order_id=o.id ORDER BY op.id DESC LIMIT 1) AS sender_number
       FROM orders o
       LEFT JOIN order_statuses os ON os.slug=o.order_status
       LEFT JOIN courier_apis ca ON ca.code=o.courier_code
      WHERE o.id=? LIMIT 1`,
    [id]
  );
  if (!row) return null;

  // Preserve the legacy detail page's notification acknowledgement on open.
  await client.execute('UPDATE orders SET is_seen=1,updated_at=updated_at WHERE id=?', [id]);
  const [rawItems,statuses,couriers,deliveryBoys,rawProducts,statusHistory] = await Promise.all([
    client.queryAll(
      `SELECT id,order_id,product_name,product_image,qty,
              size_label AS size,color_label AS color,unit_price_paisa
         FROM order_items WHERE order_id=? ORDER BY id ASC`,
      [id]
    ),
    client.queryAll('SELECT id,name,slug,badge_class,sort_order,status FROM order_statuses WHERE status=1 ORDER BY sort_order ASC'),
    client.queryAll('SELECT id,name,code,status FROM courier_apis WHERE status=1 ORDER BY id ASC'),
    client.queryAll('SELECT id,name,phone,status FROM delivery_boys WHERE status=1 ORDER BY id ASC'),
    client.queryAll(
      `SELECT id,COALESCE(NULLIF(name_en,''),name_bn) AS name,
              sale_price_paisa,unit_label AS sizes
         FROM products WHERE status=1 AND is_archived=0 AND approval_status='approved' AND vendor_id IS NULL
        ORDER BY COALESCE(NULLIF(name_en,''),name_bn) ASC`,
    ),
    client.queryAll(`SELECT h.id,h.from_status,h.to_status,h.note,h.created_at,u.name AS changed_by_name
      FROM order_status_history h LEFT JOIN users u ON u.id=h.changed_by_user_id
      WHERE h.order_id=? ORDER BY h.id DESC LIMIT 100`,[id]),
  ]);
  return {
    order: {
      ...row,
      subtotal: toBdtString(row.subtotal_paisa),
      shipping_charge: toBdtString(row.shipping_paisa),
      discount: toBdtString(row.discount_paisa),
      amount: toBdtString(row.total_paisa),
    },
    items: rawItems.map((item) => ({ ...item, price: toBdtString(item.unit_price_paisa) })),
    statuses,
    couriers,
    deliveryBoys,
    statusHistory,
    allProducts: rawProducts.map((product) => ({ ...product, new_price: toBdtString(product.sale_price_paisa) })),
  };
}

/** Platform-wide admin order list projection used by the legacy status/search route. */
async function listAdminOrders({ statusParam = 'all', searchQuery = '', page = 1, perPage = 25 } = {}, poolOverride = null) {
  const client = createQueryClient(poolOverride || getPool());
  const status = String(statusParam || 'all');
  const search = String(searchQuery || '').trim();
  const where = [];
  const params = [];
  if (status !== 'all') {
    if (status === 'unpaid') where.push("(o.payment_status='unpaid' OR o.order_status='unpaid')");
    else { where.push('o.order_status=?'); params.push(status); }
  }
  if (search) {
    where.push('(o.invoice_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const currentPage=Math.max(1,Math.min(100000,Number.parseInt(page,10)||1));
  const pageSize=Math.max(1,Math.min(100,Number.parseInt(perPage,10)||25));
  const [orders, statuses, counts, total, matched] = await Promise.all([
    client.queryAll(
      `SELECT o.id,o.invoice_no AS invoice_id,o.customer_name,o.customer_phone AS phone,
              o.shipping_address AS address,o.total_paisa,o.payment_method,o.order_status AS status,
              COALESCE(os.name,o.order_status) AS status_label,
              COALESCE(os.badge_class,'sb-1') AS badge_class,
              COALESCE(NULLIF(ca.name,''),o.courier_code,'') AS courier_name,
              o.courier_tracking_id,o.traffic_source,o.created_at,
              (SELECT op.provider_trx_id FROM order_payments op WHERE op.order_id=o.id ORDER BY op.id DESC LIMIT 1) AS trx_id
         FROM orders o
         LEFT JOIN order_statuses os ON os.slug=o.order_status
         LEFT JOIN courier_apis ca ON ca.code=o.courier_code
         ${clause}
        ORDER BY o.id DESC LIMIT ? OFFSET ?`,
      [...params,pageSize,(currentPage-1)*pageSize]
    ),
    client.queryAll('SELECT slug,name,badge_class,color,sort_order FROM order_statuses WHERE status=1 ORDER BY sort_order ASC'),
    client.queryAll('SELECT order_status AS status,COUNT(*) AS c FROM orders GROUP BY order_status'),
    client.queryOne('SELECT COUNT(*) AS c FROM orders'),
    client.queryOne(`SELECT COUNT(*) AS c FROM orders o ${clause}`,params),
  ]);
  const statusCounts = { all: Number(total?.c || 0) };
  for (const row of counts) statusCounts[row.status] = Number(row.c || 0);
  return {
    orders: orders.map((row) => ({ ...row, amount: toBdtString(row.total_paisa) })),
    statuses,
    statusCounts,
    pagination:{page:currentPage,perPage:pageSize,total:Number(matched?.c||0),totalPages:Math.ceil(Number(matched?.c||0)/pageSize)},
  };
}

/** Canonical platform-wide reseller order listing; monetary projection uses integer paisa. */
async function listAdminResellerOrders(poolOverride = null) {
  const client = createQueryClient(poolOverride || getPool());
  const [orders, statuses, counts, total] = await Promise.all([
    client.queryAll(`SELECT o.id,o.invoice_no AS invoice_id,o.customer_name,o.customer_phone AS phone,
      o.shipping_address AS address,o.total_paisa,o.payment_method,o.order_status AS status,
      COALESCE(os.name,o.order_status) AS status_label,COALESCE(os.badge_class,'sb-1') AS badge_class,
      COALESCE(NULLIF(ca.name,''),o.courier_code,'') AS courier_name,o.courier_tracking_id,o.created_at
      FROM orders o LEFT JOIN order_statuses os ON os.slug=o.order_status
      LEFT JOIN courier_apis ca ON ca.code=o.courier_code
      WHERE o.reseller_id IS NOT NULL OR o.order_channel='reseller' ORDER BY o.id DESC`),
    client.queryAll('SELECT slug,name,badge_class,color,sort_order FROM order_statuses WHERE status=1 ORDER BY sort_order ASC'),
    client.queryAll("SELECT order_status AS status,COUNT(*) AS c FROM orders WHERE reseller_id IS NOT NULL OR order_channel='reseller' GROUP BY order_status"),
    client.queryOne("SELECT COUNT(*) AS c FROM orders WHERE reseller_id IS NOT NULL OR order_channel='reseller'")
  ]);
  const statusCounts={all:Number(total?.c||0)};
  for(const row of counts)statusCounts[row.status]=Number(row.c||0);
  return {orders:orders.map(row=>({...row,amount:toBdtString(row.total_paisa)})),statuses,statusCounts};
}

module.exports = { getAdminInvoice, getAdminOrderDetail, listAdminOrders, listAdminResellerOrders };
