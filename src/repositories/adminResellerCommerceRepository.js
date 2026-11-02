'use strict';

const mysql = require('../db/mysqlPool');
const { bdtToPaisa } = require('../utils/money');
const { requirePositiveInt } = require('../utils/validator');
const { recordAuditLog } = require('./auditLogRepository');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

function cleanText(value, label, max, required = false) {
  const text = String(value ?? '').trim();
  if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ValidationError(`${label} is required and must be at most ${max} characters.`);
  }
  return text;
}
function toggle(value, label) {
  const text = String(Array.isArray(value) ? value[value.length - 1] : (value ?? '0'));
  if (!['0', '1'].includes(text)) throw new ValidationError(`${label} must be enabled or disabled.`);
  return Number(text);
}
function percentBps(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) throw new ValidationError('Platform fee percentage must have at most two decimal places.');
  const basisPoints = Number(text) * 100;
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) throw new ValidationError('Platform fee percentage must be from 0 to 100.');
  return basisPoints;
}
function amountPaisa(value, label, { optional = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text && optional) return null;
  try {
    const amount = bdtToPaisa(text);
    if (amount > 90000000000000) throw new Error('range');
    return amount;
  } catch (_error) {
    throw new ValidationError(`${label} must be a non-negative BDT amount with at most two decimals.`);
  }
}
function normalizeCommerceSettings(input = {}) {
  const feeType = String(input.platform_fee_type || 'fixed');
  if (!['fixed', 'percent'].includes(feeType)) throw new ValidationError('Select a fixed or percentage platform fee.');
  const min = amountPaisa(input.minimum_price_bdt, 'Minimum reseller price');
  const max = amountPaisa(input.maximum_price_bdt, 'Maximum reseller price', { optional: true });
  if (max !== null && max < min) throw new ValidationError('Maximum reseller price cannot be below the minimum.');
  const returnWindow = Number(input.return_window_days);
  if (!Number.isInteger(returnWindow) || returnWindow < 0 || returnWindow > 365) throw new ValidationError('Return window must be an integer from 0 to 365 days.');
  const officialCommissionBps = Number(input.official_commission_bps);
  if (!Number.isInteger(officialCommissionBps) || officialCommissionBps < 0 || officialCommissionBps > 10000) throw new ValidationError('Official commission must be an integer from 0 to 10000 basis points.');
  const fixedFee = feeType === 'fixed' ? amountPaisa(input.platform_fee_value, 'Platform fee') : 0;
  const feeBps = feeType === 'percent' ? percentBps(input.platform_fee_value) : 0;
  return {
    resellerPriceModeEnabled: toggle(input.reseller_price_mode_enabled, 'Reseller custom-price mode'),
    officialPriceModeEnabled: toggle(input.official_price_mode_enabled, 'Marketplace official-price mode'),
    platformFeeType: feeType,
    platformFeePaisa: fixedFee,
    platformFeeBps: feeBps,
    minimumPricePaisa: min,
    maximumPricePaisa: max,
    returnWindowDays: returnWindow,
    officialCommissionBps,
  };
}
function auditArgs(actor = {}) {
  return { actorType: 'admin', actorId: actor.id || null, ipAddress: actor.ip || '', userAgent: actor.userAgent || '' };
}

async function getCommerceSettings({ pool = null } = {}) {
  const db = mysql.createQueryClient(pool || mysql.getPool());
  const row = await db.queryOne('SELECT * FROM reseller_commerce_settings WHERE id=1');
  if (!row) throw new NotFoundError('Reseller commerce configuration is missing.');
  return row;
}

async function updateCommerceSettings(input, actor = {}, { pool = null } = {}) {
  const value = normalizeCommerceSettings(input);
  return mysql.withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT * FROM reseller_commerce_settings WHERE id=1 FOR UPDATE');
    if (!before) throw new NotFoundError('Reseller commerce configuration is missing.');
    await tx.execute(
      `UPDATE reseller_commerce_settings SET reseller_price_mode_enabled=?,official_price_mode_enabled=?,
       platform_fee_paisa=?,platform_fee_type=?,platform_fee_bps=?,minimum_price_paisa=?,maximum_price_paisa=?,
       return_window_days=?,official_commission_bps=?,updated_by_user_id=? WHERE id=1`,
      [value.resellerPriceModeEnabled, value.officialPriceModeEnabled, value.platformFeePaisa, value.platformFeeType,
        value.platformFeeBps, value.minimumPricePaisa, value.maximumPricePaisa, value.returnWindowDays,
        value.officialCommissionBps, actor.id || null]
    );
    await recordAuditLog({ ...auditArgs(actor), action: 'reseller_commerce.settings.updated', entityType: 'reseller_commerce_settings', entityId: 1,
      beforeState: before, afterState: value }, tx);
    return value;
  }, { pool: pool || mysql.getPool() });
}

async function listProducts({ search = '', pool = null } = {}) {
  const db = mysql.createQueryClient(pool || mysql.getPool());
  const term = cleanText(search, 'Search', 80);
  const pattern = `%${term}%`;
  return db.queryAll(
    `SELECT p.id,p.sku,p.name_bn,p.name_en,p.slug,COALESCE(e.reseller_price_mode_enabled,0) AS reseller_price_mode_enabled,
            COALESCE(e.official_price_mode_enabled,0) AS official_price_mode_enabled,
            e.minimum_price_paisa,e.maximum_price_paisa,e.vendor_entitlement_paisa
     FROM products p LEFT JOIN reseller_product_eligibility e ON e.product_id=p.id
     WHERE p.status=1 AND p.is_archived=0 AND (?='' OR p.name_bn LIKE ? OR p.name_en LIKE ? OR p.sku LIKE ?)
     ORDER BY p.id DESC LIMIT 200`, [term, pattern, pattern, pattern]
  );
}

async function setProductEligibility(productIdInput, input, actor = {}, { pool = null } = {}) {
  const productId = requirePositiveInt(productIdInput, 'Product ID');
  const resellerEnabled = toggle(input.reseller_price_mode_enabled, 'Reseller custom-price eligibility');
  const officialEnabled = toggle(input.official_price_mode_enabled, 'Official-price eligibility');
  const min = amountPaisa(input.minimum_price_bdt, 'Product minimum price', { optional: true });
  const max = amountPaisa(input.maximum_price_bdt, 'Product maximum price', { optional: true });
  const vendorEntitlement = amountPaisa(input.vendor_entitlement_bdt, 'Vendor entitlement', { optional: true });
  if (min !== null && max !== null && max < min) throw new ValidationError('Product maximum price cannot be below its minimum.');
  return mysql.withTransaction(async (tx) => {
    const product = await tx.queryOne('SELECT id,sku,name_bn,name_en FROM products WHERE id=? AND status=1 FOR UPDATE', [productId]);
    if (!product) throw new NotFoundError('Product not found or inactive.');
    const before = await tx.queryOne('SELECT * FROM reseller_product_eligibility WHERE product_id=? FOR UPDATE', [productId]);
    await tx.execute(
      `INSERT INTO reseller_product_eligibility(product_id,reseller_price_mode_enabled,official_price_mode_enabled,minimum_price_paisa,maximum_price_paisa,vendor_entitlement_paisa,updated_by_user_id)
       VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE reseller_price_mode_enabled=VALUES(reseller_price_mode_enabled),
       official_price_mode_enabled=VALUES(official_price_mode_enabled),minimum_price_paisa=VALUES(minimum_price_paisa),
       maximum_price_paisa=VALUES(maximum_price_paisa),vendor_entitlement_paisa=VALUES(vendor_entitlement_paisa),updated_by_user_id=VALUES(updated_by_user_id)`,
      [productId, resellerEnabled, officialEnabled, min, max, vendorEntitlement, actor.id || null]
    );
    await recordAuditLog({ ...auditArgs(actor), action: 'reseller_commerce.product_eligibility.updated', entityType: 'product', entityId: productId,
      beforeState: before, afterState: { resellerEnabled, officialEnabled, minimumPricePaisa: min, maximumPricePaisa: max, vendorEntitlementPaisa: vendorEntitlement } }, tx);
    return { productId, resellerEnabled, officialEnabled };
  }, { pool: pool || mysql.getPool() });
}

async function listResellers({ pool = null } = {}) {
  const db = mysql.createQueryClient(pool || mysql.getPool());
  return db.queryAll(
    `SELECT r.id,r.name,r.shop_name,r.logo_url,r.phone,r.email,r.verified,r.status,r.branding_status,
            r.branding_review_note,r.created_at,COALESCE(w.pending_balance,0) AS pending_balance,
            COALESCE(w.available_balance,0) AS available_balance
     FROM resellers r LEFT JOIN partner_wallets w ON w.reseller_id=r.id ORDER BY r.created_at DESC,r.id DESC LIMIT 300`
  );
}

async function setResellerStatus(resellerIdInput, action, actor = {}, { pool = null } = {}) {
  const id = requirePositiveInt(resellerIdInput, 'Reseller ID');
  if (!['approve', 'suspend', 'reactivate'].includes(action)) throw new ValidationError('Unsupported reseller status action.');
  return mysql.withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT id,name,shop_name,verified,status FROM resellers WHERE id=? FOR UPDATE', [id]);
    if (!before) throw new NotFoundError('Reseller not found.');
    const verified = action === 'approve' || action === 'reactivate' ? 1 : Number(before.verified);
    const status = action === 'suspend' ? 0 : 1;
    await tx.execute('UPDATE resellers SET verified=?,status=? WHERE id=?', [verified, status, id]);
    await recordAuditLog({ ...auditArgs(actor), action: `reseller.${action}`, entityType: 'reseller', entityId: id,
      beforeState: { verified: Number(before.verified), status: Number(before.status) }, afterState: { verified, status } }, tx);
    return { id, verified, status };
  }, { pool: pool || mysql.getPool() });
}

function safeLogo(value) {
  const logo = cleanText(value, 'Reseller logo URL', 500);
  if (!logo) return '';
  if (/^\/uploads\/[a-zA-Z0-9_./-]+$/.test(logo) && !logo.includes('..')) return logo;
  let parsed;
  try { parsed = new URL(logo); } catch (_error) { throw new ValidationError('Reseller logo must be an uploaded image path or an HTTPS URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new ValidationError('Reseller logo must use a safe HTTPS URL.');
  return parsed.toString();
}

async function reviewBranding(resellerIdInput, { action, shopName, logoUrl, note = '' } = {}, actor = {}, { pool = null } = {}) {
  const id = requirePositiveInt(resellerIdInput, 'Reseller ID');
  if (!['approve', 'reject'].includes(action)) throw new ValidationError('Choose approve or reject for co-branding review.');
  const cleanShop = cleanText(shopName, 'Store name', 191, action === 'approve');
  const cleanLogo = safeLogo(logoUrl);
  const reviewNote = cleanText(note, 'Review note', 500, action === 'reject');
  return mysql.withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT id,shop_name,logo_url,branding_status,branding_review_note FROM resellers WHERE id=? FOR UPDATE', [id]);
    if (!before) throw new NotFoundError('Reseller not found.');
    const status = action === 'approve' ? 'approved' : 'rejected';
    await tx.execute(
      'UPDATE resellers SET shop_name=?,logo_url=?,branding_status=?,branding_review_note=?,branding_reviewed_by_user_id=?,branding_reviewed_at=UTC_TIMESTAMP() WHERE id=?',
      [cleanShop, cleanLogo, status, reviewNote, actor.id || null, id]
    );
    await recordAuditLog({ ...auditArgs(actor), action: `reseller.branding.${status}`, entityType: 'reseller', entityId: id,
      beforeState: { shopName: before.shop_name, logoUrl: before.logo_url, status: before.branding_status },
      afterState: { shopName: cleanShop, logoUrl: cleanLogo, status, note: reviewNote } }, tx);
    return { id, status };
  }, { pool: pool || mysql.getPool() });
}

async function listVendorSubOrders({ pool = null } = {}) {
  const db = mysql.createQueryClient(pool || mysql.getPool());
  const rows = await db.queryAll(
    `SELECT so.id,so.order_id,so.vendor_id,so.vendor_order_no,so.status,so.cod_due_paisa,so.vendor_entitlement_paisa,
            so.marketplace_fee_paisa,so.net_payable_paisa,so.shipment_carrier,so.tracking_code,so.delivered_at,
            o.invoice_no,o.payment_method,o.payment_status,v.shop_name AS vendor_name
     FROM vendor_sub_orders so JOIN orders o ON o.id=so.order_id JOIN vendors v ON v.id=so.vendor_id
     ORDER BY so.created_at DESC,so.id DESC LIMIT 300`
  );
  for (const row of rows) {
    row.items = await db.queryAll(
      `SELECT oi.product_name,si.quantity,oi.unit_price_paisa AS customer_unit_price_paisa,
              ps.vendor_entitlement_unit_paisa,ps.reseller_margin_unit_paisa,ps.marketplace_revenue_unit_paisa
       FROM vendor_sub_order_items si JOIN order_items oi ON oi.id=si.order_item_id
       LEFT JOIN order_price_snapshots ps ON ps.order_item_id=oi.id WHERE si.vendor_sub_order_id=? ORDER BY oi.id`, [row.id]
    );
    row.shipments = await db.queryAll(
      `SELECT fs.id,fs.courier_code AS courier_name,fs.tracking_id AS tracking_number,fs.status,fs.created_at
       FROM fulfillment_shipments fs WHERE fs.vendor_sub_order_id=? ORDER BY fs.created_at DESC,fs.id DESC`, [row.id]
    );
    for (const shipment of row.shipments) shipment.history = await db.queryAll(
      `SELECT from_status,to_status AS status,created_at FROM vendor_order_status_history WHERE vendor_sub_order_id=? ORDER BY created_at DESC,id DESC`, [row.id]
    );
  }
  return rows;
}

async function listCodShipments({ pool = null } = {}) {
  const db = mysql.createQueryClient(pool || mysql.getPool());
  return db.queryAll(
    `SELECT fs.id AS shipment_id,fs.vendor_sub_order_id,fs.courier_code,fs.tracking_id,fs.status AS shipment_status,
            fs.cod_due_paisa AS expected_paisa,so.order_id,so.vendor_order_no,so.status AS sub_order_status,o.invoice_no,o.payment_status,
            v.shop_name AS vendor_name,c.id AS collection_id,c.courier_name,c.consignment_id,c.collected_amount_paisa AS collected_paisa,
            c.courier_fee_paisa,c.cod_fee_paisa,c.net_remitted_paisa,c.remittance_reference,c.bank_trans_ref,
            COALESCE(c.bank_trans_ref,c.remittance_reference,'') AS reconciliation_reference,c.reconciliation_status,
            CASE WHEN c.id IS NULL THEN NULL ELSE c.collected_amount_paisa-fs.cod_due_paisa END AS discrepancy_paisa
     FROM fulfillment_shipments fs JOIN vendor_sub_orders so ON so.id=fs.vendor_sub_order_id
     JOIN orders o ON o.id=so.order_id JOIN vendors v ON v.id=so.vendor_id
     LEFT JOIN courier_cod_collections c ON c.id=(SELECT MAX(c2.id) FROM courier_cod_collections c2 WHERE c2.shipment_id=fs.id)
     ORDER BY fs.created_at DESC,fs.id DESC LIMIT 300`
  );
}

async function getWalletSummary({ pool = null } = {}) {
  const db = mysql.createQueryClient(pool || mysql.getPool());
  return db.queryAll(
    `SELECT 'reseller' AS partner_type,COALESCE(SUM(pending_balance),0) AS pending_paisa,
            COALESCE(SUM(available_balance),0) AS available_paisa FROM partner_wallets
     UNION ALL
     SELECT 'vendor' AS partner_type,COALESCE(SUM(pending_settlement),0) AS pending_paisa,
            COALESCE(SUM(available_balance),0) AS available_paisa FROM vendor_wallets`
  );
}

async function previewMaturedSettlements(returnWindowDays = 7, { pool = null } = {}) {
  const days = Number(returnWindowDays);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new ValidationError('Return window must be from 0 to 365 days.');
  const db = mysql.createQueryClient(pool || mysql.getPool());
  return db.queryAll(
    `WITH matured AS (
       SELECT so.id,so.vendor_id,o.reseller_id,so.vendor_entitlement_paisa,
              NOT EXISTS (SELECT 1 FROM vendor_transactions vt WHERE vt.idempotency_key=CONCAT('settle:vendor:',so.id)) AS vendor_unreleased,
              (o.reseller_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM partner_transactions pt WHERE pt.idempotency_key=CONCAT('settle:reseller:',so.id))) AS reseller_unreleased
       FROM vendor_sub_orders so JOIN orders o ON o.id=so.order_id
       WHERE so.status='delivered' AND so.delivered_at IS NOT NULL
         AND so.delivered_at<=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? DAY)
         AND (o.payment_status='paid' OR (o.payment_method='cod'
           AND EXISTS (SELECT 1 FROM fulfillment_shipments fs WHERE fs.vendor_sub_order_id=so.id)
           AND NOT EXISTS (SELECT 1 FROM fulfillment_shipments fs LEFT JOIN courier_cod_collections c
             ON c.id=(SELECT MAX(c2.id) FROM courier_cod_collections c2 WHERE c2.shipment_id=fs.id)
             WHERE fs.vendor_sub_order_id=so.id AND COALESCE(c.reconciliation_status,'pending')<>'reconciled')))
     )
     SELECT 'vendor' AS partner_type,m.vendor_id AS partner_id,COUNT(*) AS record_count,
            SUM(m.vendor_entitlement_paisa) AS amount_paisa,? AS return_window_days
     FROM matured m WHERE m.vendor_unreleased=1 GROUP BY m.vendor_id
     UNION ALL
     SELECT 'reseller' AS partner_type,m.reseller_id AS partner_id,COUNT(DISTINCT m.id) AS record_count,
            SUM(ps.reseller_margin_unit_paisa*si.quantity) AS amount_paisa,? AS return_window_days
     FROM matured m JOIN vendor_sub_order_items si ON si.vendor_sub_order_id=m.id
     JOIN order_price_snapshots ps ON ps.order_item_id=si.order_item_id
     WHERE m.reseller_unreleased=1 GROUP BY m.reseller_id`, [days, days, days]
  );
}

async function listWithdrawalRequests({ pool = null } = {}) {
  const db = mysql.createQueryClient(pool || mysql.getPool());
  return db.queryAll(
    `SELECT 'vendor' AS partner_type,vw.id AS id,vw.vendor_id AS partner_id,v.shop_name AS partner_name,
            vw.amount_paisa,vw.method,CONCAT('••••',RIGHT(vw.account_number,4)) AS destination,vw.status,vw.created_at
     FROM vendor_withdrawals vw JOIN vendors v ON v.id=vw.vendor_id WHERE vw.status='pending'
     UNION ALL
     SELECT 'reseller' AS partner_type,rt.id AS request_id,rt.reseller_id AS partner_id,r.shop_name AS partner_name,
            rt.amount_paisa,rt.method,CONCAT('••••',RIGHT(COALESCE(rt.trx_id,''),4)) AS masked_account,rt.status,rt.created_at
     FROM reseller_transactions rt JOIN resellers r ON r.id=rt.reseller_id WHERE rt.tx_type='withdrawal' AND rt.status='pending'
     ORDER BY created_at ASC,request_id ASC LIMIT 300`
  );
}

async function decideWithdrawal({ partnerType, requestId, decision, reason = '' } = {}, actor = {}, { pool = null } = {}) {
  const id = requirePositiveInt(requestId, 'Withdrawal request ID');
  if (!['vendor', 'reseller'].includes(partnerType) || !['approve', 'reject'].includes(decision)) throw new ValidationError('Unsupported withdrawal decision.');
  const note = cleanText(reason, 'Decision reason', 255, decision === 'reject');
  return mysql.withTransaction(async (tx) => {
    let row;
    if (partnerType === 'vendor') row = await tx.queryOne(
      "SELECT id,vendor_id,amount_paisa,status FROM vendor_withdrawals WHERE id=? AND status='pending' FOR UPDATE", [id]
    );
    else row = await tx.queryOne(
      "SELECT id,reseller_id,amount_paisa,status,tx_type FROM reseller_transactions WHERE id=? AND tx_type='withdrawal' AND status='pending' FOR UPDATE", [id]
    );
    if (!row) throw new NotFoundError('Pending withdrawal request not found.');
    const amount = Number(row.amount_paisa);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ConflictError('Withdrawal amount is invalid.');
    if (partnerType === 'vendor') {
      const wallet = await tx.queryOne('SELECT available_balance FROM vendor_wallets WHERE vendor_id=? FOR UPDATE', [row.vendor_id]);
      if (!wallet) throw new NotFoundError('Vendor wallet not found.');
      if (decision === 'approve') {
        if (Number(wallet.available_balance) < amount) throw new ConflictError('Withdrawal amount exceeds the vendor available balance.');
        await tx.execute('UPDATE vendor_wallets SET available_balance=available_balance-? WHERE vendor_id=?', [amount, row.vendor_id]);
        await tx.execute('UPDATE vendors SET balance_paisa=balance_paisa-? WHERE id=?', [amount, row.vendor_id]);
        await tx.execute("UPDATE vendor_withdrawals SET status='paid',note=?,processed_by_user_id=? WHERE id=? AND status='pending'", [note, actor.id || null, id]);
        await tx.execute(
          `INSERT INTO vendor_transactions(vendor_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
           VALUES(?,NULL,?,'withdrawal',?,'available',?)`,
          [row.vendor_id, `withdrawal:vendor:${id}`, -amount, JSON.stringify({ approvedBy: actor.id || null })]
        );
      } else {
        await tx.execute("UPDATE vendor_withdrawals SET status='rejected',note=?,processed_by_user_id=? WHERE id=? AND status='pending'", [note, actor.id || null, id]);
      }
    } else {
      const wallet = await tx.queryOne('SELECT available_balance FROM partner_wallets WHERE reseller_id=? FOR UPDATE', [row.reseller_id]);
      if (!wallet) throw new NotFoundError('Reseller wallet not found.');
      if (decision === 'approve') {
        if (Number(wallet.available_balance) < amount) throw new ConflictError('Withdrawal amount exceeds the reseller available balance.');
        await tx.execute('UPDATE partner_wallets SET available_balance=available_balance-? WHERE reseller_id=?', [amount, row.reseller_id]);
        await tx.execute('UPDATE resellers SET balance_paisa=balance_paisa-? WHERE id=?', [amount, row.reseller_id]);
        await tx.execute("UPDATE reseller_transactions SET status='completed' WHERE id=? AND tx_type='withdrawal' AND status='pending'", [id]);
        await tx.execute(
          `INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
           VALUES(?,NULL,?,'withdrawal',?,'available',?)`,
          [row.reseller_id, `withdrawal:reseller:${id}`, -amount, JSON.stringify({ approvedBy: actor.id || null })]
        );
      } else {
        await tx.execute("UPDATE reseller_transactions SET status='rejected' WHERE id=? AND tx_type='withdrawal' AND status='pending'", [id]);
      }
    }
    await recordAuditLog({ ...auditArgs(actor), action: `reseller_commerce.withdrawal.${decision}`, entityType: `${partnerType}_withdrawal`, entityId: id,
      beforeState: { status: 'pending', amountPaisa: amount }, afterState: { status: decision === 'approve' ? 'paid' : 'rejected', reason: note } }, tx);
    return { partnerType, requestId: id, decision, amountPaisa: amount };
  }, { pool: pool || mysql.getPool() });
}

async function listAuditTrail({ orderId = '', resellerId = '', reference = '', pool = null } = {}) {
  const order = orderId ? requirePositiveInt(orderId, 'Order ID') : null;
  const reseller = resellerId ? requirePositiveInt(resellerId, 'Reseller ID') : null;
  const term = cleanText(reference, 'Transaction reference', 120);
  const db = mysql.createQueryClient(pool || mysql.getPool());
  const rows = await db.queryAll(
    `SELECT 'partner' AS ledger_type,pt.id,pt.reseller_id,pt.sub_order_id,so.order_id,pt.idempotency_key AS reference,
            pt.transaction_type,pt.amount_paisa,pt.balance_bucket,pt.created_at
     FROM partner_transactions pt LEFT JOIN vendor_sub_orders so ON so.id=pt.sub_order_id
     WHERE (? IS NULL OR so.order_id=? OR pt.sub_order_id=?) AND (? IS NULL OR pt.reseller_id=?) AND (?='' OR pt.idempotency_key LIKE ?)
     UNION ALL
     SELECT 'vendor' AS ledger_type,vt.id,NULL AS reseller_id,vt.sub_order_id,so.order_id,vt.idempotency_key AS reference,
            vt.transaction_type,vt.amount_paisa,vt.balance_bucket,vt.created_at
     FROM vendor_transactions vt LEFT JOIN vendor_sub_orders so ON so.id=vt.sub_order_id
     WHERE (? IS NULL OR so.order_id=? OR vt.sub_order_id=?) AND (?='' OR vt.idempotency_key LIKE ?)
     ORDER BY created_at DESC LIMIT 200`,
    [order, order, order, reseller, reseller, term, `%${term}%`, order, order, order, term, `%${term}%`]
  );
  const snapshots = await db.queryAll(
    `SELECT 'snapshot' AS ledger_type,ps.order_item_id AS id,ps.reseller_id,NULL AS sub_order_id,oi.order_id,
            CAST(oi.id AS CHAR) AS reference,'price_snapshot' AS transaction_type,
            (ps.customer_unit_price_paisa*ps.quantity) AS amount_paisa,'snapshot' AS balance_bucket,ps.created_at
     FROM order_price_snapshots ps JOIN order_items oi ON oi.id=ps.order_item_id
     WHERE (? IS NULL OR oi.order_id=?) AND (? IS NULL OR ps.reseller_id=?) ORDER BY ps.created_at DESC LIMIT 200`,
    [order, order, reseller, reseller]
  );
  const resellerSnapshots = await db.queryAll(
    `SELECT 'reseller_snapshot' AS ledger_type,rs.order_item_id AS id,o.reseller_id,NULL AS sub_order_id,oi.order_id,
            CAST(oi.id AS CHAR) AS reference,rs.pricing_mode AS transaction_type,
            (rs.customer_unit_price_paisa*rs.quantity) AS amount_paisa,'snapshot' AS balance_bucket,rs.created_at
     FROM reseller_order_price_snapshots rs JOIN order_items oi ON oi.id=rs.order_item_id JOIN orders o ON o.id=oi.order_id
     WHERE (? IS NULL OR oi.order_id=?) AND (? IS NULL OR o.reseller_id=?) ORDER BY rs.created_at DESC LIMIT 200`,
    [order, order, reseller, reseller]
  );
  return [...rows, ...snapshots, ...resellerSnapshots].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,200);
}

module.exports = {
  getCommerceSettings, updateCommerceSettings, normalizeCommerceSettings, listProducts, setProductEligibility,
  listResellers, setResellerStatus, reviewBranding, safeLogo, listVendorSubOrders, listCodShipments,
  getWalletSummary, previewMaturedSettlements, listWithdrawalRequests, decideWithdrawal, listAuditTrail,
};
