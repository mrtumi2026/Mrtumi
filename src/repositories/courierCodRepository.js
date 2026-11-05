'use strict';

const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { requirePositiveInt } = require('../utils/validator');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

function assertMysql() {
  if (env.db.client !== 'mysql') throw new Error('Courier COD reconciliation requires MySQL.');
}
function nonNegativePaisa(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 90000000000000) {
    throw new ValidationError(`${label} must be a non-negative integer amount in paisa.`);
  }
  return amount;
}
function safeText(value, label, max, required = false) {
  const text = String(value ?? '').trim();
  if ((required && !text) || text.length > max) throw new ValidationError(`${label} is required and must be at most ${max} characters.`);
  return text;
}

async function reconcileCourierCollection({
  shipmentId,
  collectedAmountPaisa,
  remittanceRef,
  bankTransRef = '',
  courierName = '',
  consignmentId = '',
  courierFeePaisa = 0,
  codFeePaisa = 0,
  actor = {},
} = {}) {
  assertMysql();
  const shipment = requirePositiveInt(shipmentId, 'shipment ID');
  const collected = nonNegativePaisa(collectedAmountPaisa, 'Collected amount');
  const courierFee = nonNegativePaisa(courierFeePaisa, 'Courier fee');
  const codFee = nonNegativePaisa(codFeePaisa, 'COD fee');
  if (courierFee + codFee > collected) throw new ValidationError('Courier and COD fees cannot exceed the collected amount.');
  const reference = safeText(remittanceRef, 'Remittance reference', 120, true);
  const bankReference = safeText(bankTransRef, 'Bank transaction reference', 120);
  const courier = safeText(courierName, 'Courier name', 80);
  const consignment = safeText(consignmentId, 'Consignment ID', 120);
  const actorId = actor?.userId || actor?.id || null;
  const userId = actorId ? requirePositiveInt(actorId, 'actor ID') : null;
  const netRemitted = collected - courierFee - codFee;

  return mysql.withTransaction(async (tx) => {
    const shipmentRow = await tx.queryOne(
      `SELECT fs.id,fs.vendor_sub_order_id,fs.cod_due_paisa,fs.quoted_charge_paisa,fs.courier_code,fs.tracking_id,
              so.order_id,o.total_paisa,o.cod_due_paisa AS order_cod_due_paisa,o.payment_method,o.payment_status
       FROM fulfillment_shipments fs
       JOIN vendor_sub_orders so ON so.id=fs.vendor_sub_order_id
       JOIN orders o ON o.id=so.order_id
       WHERE fs.id=? FOR UPDATE`,
      [shipment]
    );
    if (!shipmentRow) throw new NotFoundError('Fulfillment shipment not found.');
    const expected = nonNegativePaisa(shipmentRow.cod_due_paisa, 'Shipment COD due');
    const quotedChargePaisa = Number(shipmentRow.quoted_charge_paisa || 0);
    const feeVariancePaisa = quotedChargePaisa > 0 ? (courierFee - quotedChargePaisa) : 0;
    const status = collected === expected ? 'reconciled' : 'discrepancy';
    const existing = await tx.queryOne(
      'SELECT id,reconciliation_status,collected_amount_paisa,courier_fee_paisa,cod_fee_paisa,remittance_reference,bank_trans_ref FROM courier_cod_collections WHERE shipment_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [shipment]
    );
    if (existing?.reconciliation_status === 'reconciled') {
      if (Number(existing.collected_amount_paisa) !== collected || Number(existing.courier_fee_paisa) !== courierFee
          || Number(existing.cod_fee_paisa) !== codFee || existing.remittance_reference !== reference
          || existing.bank_trans_ref !== bankReference) {
        throw new ConflictError('A reconciled courier collection is immutable and cannot be overwritten.');
      }
      return { shipmentId: shipment, status: 'reconciled', collectedAmountPaisa: collected, netRemittedPaisa: netRemitted,
        quotedChargePaisa, feeVariancePaisa, orderPaid: shipmentRow.payment_status === 'paid', replayed: true };
    }
    const idempotencyKey = `courier-cod:shipment:${shipment}`;
    if (existing) {
      await tx.execute(
        `UPDATE courier_cod_collections
         SET courier_name=?,consignment_id=?,collected_amount_paisa=?,collected_paisa=?,courier_fee_paisa=?,cod_fee_paisa=?,
             net_remitted_paisa=?,remitted_paisa=?,remittance_reference=?,bank_trans_ref=?,reconciliation_status=?,received_at=UTC_TIMESTAMP(),reconciled_by_user_id=?
         WHERE id=?`,
        [courier, consignment, collected, collected, courierFee, codFee, netRemitted, netRemitted, reference, bankReference, status, userId, existing.id]
      );
    } else {
      await tx.execute(
        `INSERT INTO courier_cod_collections
         (shipment_id,idempotency_key,courier_name,consignment_id,collected_amount_paisa,collected_paisa,courier_fee_paisa,cod_fee_paisa,
          net_remitted_paisa,remitted_paisa,remittance_reference,bank_trans_ref,reconciliation_status,received_at,reconciled_by_user_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?,UTC_TIMESTAMP(),?)`,
        [shipment, idempotencyKey, courier || shipmentRow.courier_code || '', consignment || shipmentRow.tracking_id || '', collected, collected,
          courierFee, codFee, netRemitted, netRemitted, reference, bankReference, status, userId]
      );
    }

    let orderPaid = false;
    if (status === 'reconciled') {
      const totals = await tx.queryOne(
        `SELECT COUNT(*) AS shipment_count,
                SUM(CASE WHEN c.reconciliation_status='reconciled' THEN 1 ELSE 0 END) AS reconciled_count,
                COALESCE(SUM(fs.cod_due_paisa),0) AS due_paisa,
                MAX(o.cod_due_paisa) AS order_due_paisa,
                COALESCE(SUM(CASE WHEN c.reconciliation_status='reconciled' THEN c.collected_amount_paisa ELSE 0 END),0) AS collected_paisa
         FROM fulfillment_shipments fs
         JOIN vendor_sub_orders so ON so.id=fs.vendor_sub_order_id
         JOIN orders o ON o.id=so.order_id
         LEFT JOIN courier_cod_collections c ON c.id=(SELECT MAX(c2.id) FROM courier_cod_collections c2 WHERE c2.shipment_id=fs.id)
         WHERE so.order_id=?`,
        [shipmentRow.order_id]
      );
      const incomplete = await tx.queryOne(
        `SELECT COUNT(*) AS n FROM vendor_sub_orders so
         WHERE so.order_id=? AND so.status<>'cancelled' AND (
           NOT EXISTS (SELECT 1 FROM fulfillment_shipments fs WHERE fs.vendor_sub_order_id=so.id)
           OR EXISTS (
             SELECT 1 FROM fulfillment_shipments fs LEFT JOIN courier_cod_collections c
               ON c.id=(SELECT MAX(c2.id) FROM courier_cod_collections c2 WHERE c2.shipment_id=fs.id)
             WHERE fs.vendor_sub_order_id=so.id AND COALESCE(c.reconciliation_status,'pending')<>'reconciled'
           )
         )`, [shipmentRow.order_id]
      );
      const complete = Number(totals?.shipment_count || 0) > 0
        && Number(totals.reconciled_count || 0) === Number(totals.shipment_count)
        && Number(incomplete?.n || 0) === 0
        && Number(totals.collected_paisa || 0) >= Number(totals.order_due_paisa ?? totals.due_paisa ?? 0);
      if (complete && shipmentRow.payment_method === 'cod') {
        await tx.execute(
          "UPDATE orders SET payment_status='paid',paid_paisa=total_paisa,cod_due_paisa=0 WHERE id=? AND payment_status<>'paid'",
          [shipmentRow.order_id]
        );
        orderPaid = true;
      }
    }
    return { shipmentId: shipment, status, collectedAmountPaisa: collected, netRemittedPaisa: netRemitted, quotedChargePaisa, feeVariancePaisa, orderPaid };
  });
}

module.exports = { reconcileCourierCollection, nonNegativePaisa };
