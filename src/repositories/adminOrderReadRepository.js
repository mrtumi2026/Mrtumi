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

/** Platform-wide admin order list projection used by the legacy status/search route. */
async function listAdminOrders({ statusParam = 'all', searchQuery = '' } = {}, poolOverride = null) {
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
  const [orders, statuses, counts, total] = await Promise.all([
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
        ORDER BY o.id DESC`,
      params
    ),
    client.queryAll('SELECT slug,name,badge_class,color,sort_order FROM order_statuses WHERE status=1 ORDER BY sort_order ASC'),
    client.queryAll('SELECT order_status AS status,COUNT(*) AS c FROM orders GROUP BY order_status'),
    client.queryOne('SELECT COUNT(*) AS c FROM orders'),
  ]);
  const statusCounts = { all: Number(total?.c || 0) };
  for (const row of counts) statusCounts[row.status] = Number(row.c || 0);
  return {
    orders: orders.map((row) => ({ ...row, amount: toBdtString(row.total_paisa) })),
    statuses,
    statusCounts,
  };
}

module.exports = { getAdminInvoice, listAdminOrders };
