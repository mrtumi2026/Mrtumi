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

module.exports = { getAdminInvoice };
