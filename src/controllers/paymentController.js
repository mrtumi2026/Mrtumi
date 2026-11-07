'use strict';

/**
 * Payment Controller — Dynamic Bangladesh MFS Dual-Mode
 * ======================================================
 * Supports programmatic API checkout (bKash, Nagad, Rocket) and
 * manual TrxID verification workflows with immutable double-entry ledger settlement.
 */

const bkash = require('../services/gateways/bkashService');
const nagad = require('../services/gateways/nagadService');
const rocket = require('../services/gateways/rocketService');
const webhookService = require('../services/paymentWebhookService');
const codGuard = require('../services/codGuardService');
const mysql = require('../db/mysqlPool');
const { ValidationError, NotFoundError, AppError } = require('../utils/errors');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');

/**
 * Initiates an automated payment gateway session or processes manual selection.
 * POST /payment/initiate/:gateway
 */
async function initiatePayment(req, res, next) {
  try {
    const gateway = String(req.params.gateway || '').toLowerCase().trim();
    const orderId = Number(req.body.order_id);

    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      throw new ValidationError('A valid order_id is required.');
    }

    const pool = mysql.getPool();
    const [orders] = await pool.query(
      'SELECT id, invoice_no, total_paisa, paid_paisa, cod_due_paisa, payment_status, customer_name, customer_phone, shipping_address, district FROM orders WHERE id = ?',
      [orderId]
    );

    const order = orders && orders[0];
    if (!order) throw new NotFoundError(`Order ${orderId} does not exist.`);
    if (order.payment_status === 'paid') {
      return res.redirect(`/order-success?invoice=${encodeURIComponent(order.invoice_no)}`);
    }

    const amountToCharge = Number(order.cod_due_paisa) > 0 ? Number(order.cod_due_paisa) : Number(order.total_paisa);

    // 1. bKash Automated API Mode
    if (['bkash', 'bkash_api', 'bkash_tokenized'].includes(gateway)) {
      const callbackUrl = `${env.appUrl}/payment/bkash/callback?order_id=${orderId}`;
      const session = await bkash.createPayment({
        orderId,
        invoiceNo: order.invoice_no,
        amountPaisa: amountToCharge,
        callbackUrl,
      });

      return res.redirect(session.bkashURL);
    }

    // 2. Nagad Automated API Mode
    if (['nagad', 'nagad_api'].includes(gateway)) {
      const callbackUrl = `${env.appUrl}/payment/nagad/callback?order_id=${orderId}`;
      const session = await nagad.createPayment({
        orderId,
        amountPaisa: amountToCharge,
        customerPhone: order.customer_phone,
        callbackUrl,
      });

      return res.redirect(session.redirectUrl);
    }

    // 3. Rocket Automated API Mode
    if (['rocket', 'rocket_api'].includes(gateway)) {
      const callbackUrl = `${env.appUrl}/payment/rocket/callback?order_id=${orderId}`;
      const session = await rocket.createPayment({
        orderId,
        amountPaisa: amountToCharge,
        customerPhone: order.customer_phone,
        callbackUrl,
      });

      return res.redirect(session.redirectUrl);
    }

    // 4. Manual MFS Modes (bKash Manual, Nagad Manual, Rocket Manual, COD)
    if (['bkash_manual', 'nagad_manual', 'rocket_manual', 'cod', 'manual_bkash', 'manual_nagad', 'manual_rocket'].includes(gateway)) {
      return res.redirect(`/order-success?invoice=${encodeURIComponent(order.invoice_no)}&manual=1`);
    }

    throw new ValidationError(`Unsupported payment gateway code: ${gateway}`);
  } catch (err) {
    next(err);
  }
}

/**
 * Handles bKash return callback.
 * GET /payment/bkash/callback
 */
async function bkashCallback(req, res, next) {
  try {
    const paymentID = String(req.query.paymentID || '').trim();
    const status = String(req.query.status || '').toLowerCase();
    const orderId = Number(req.query.order_id);

    if (status === 'cancel' || status === 'failure') {
      logger.warn('bKash payment cancelled or failed', { status, orderId, paymentID });
      return res.redirect(`/checkout?error=Payment+was+${status}&order_id=${orderId}`);
    }

    if (status !== 'success' || !paymentID) {
      throw new ValidationError('bKash callback reported invalid payment outcome.');
    }

    await webhookService.processWebhookEvent({
      gatewayCode: 'bkash_api',
      eventType: 'callback',
      uniqueEventId: paymentID,
      headers: req.headers,
      payload: req.query,
      clientIp: req.ip,
      handlerFn: async (tx) => {
        const execution = await bkash.executePayment(paymentID);

        await webhookService.settleOrderPayment(tx, orderId, {
          gatewayCode: 'bkash_api',
          paymentId: execution.paymentID,
          trxId: execution.trxID,
          amountPaisa: execution.amountPaisa,
          rawResponse: execution.raw,
        });

        return execution;
      },
    });

    const pool = mysql.getPool();
    const [orders] = await pool.query('SELECT invoice_no FROM orders WHERE id = ?', [orderId]);
    const invoiceNo = orders[0]?.invoice_no || orderId;

    return res.redirect(`/order-success?invoice=${encodeURIComponent(invoiceNo)}&paid=1`);
  } catch (err) {
    next(err);
  }
}

/**
 * Handles Nagad return callback / IPN.
 * GET/POST /payment/nagad/callback
 */
async function nagadCallback(req, res, next) {
  try {
    const paymentRefId = String(req.query.payment_ref_id || req.body.payment_ref_id || req.query.paymentRefId || '').trim();
    const orderId = Number(req.query.order_id || req.body.order_id || 0);
    const status = String(req.query.status || req.body.status || '').toLowerCase();

    if (status === 'aborted' || status === 'failed') {
      logger.warn('Nagad payment declined or aborted', { status, orderId, paymentRefId });
      return res.redirect(`/checkout?error=Payment+was+${status}&order_id=${orderId}`);
    }

    if (!paymentRefId) {
      throw new ValidationError('Nagad payment reference is missing from callback.');
    }

    await webhookService.processWebhookEvent({
      gatewayCode: 'nagad_api',
      eventType: 'callback',
      uniqueEventId: paymentRefId,
      headers: req.headers,
      payload: { ...req.query, ...req.body },
      clientIp: req.ip,
      handlerFn: async (tx) => {
        const verified = await nagad.verifyPayment({ paymentRefId });

        await webhookService.settleOrderPayment(tx, orderId, {
          gatewayCode: 'nagad_api',
          paymentId: verified.paymentId,
          trxId: verified.trxId,
          amountPaisa: verified.amountPaisa,
          rawResponse: verified.raw,
        });

        return verified;
      },
    });

    const pool = mysql.getPool();
    const [orders] = await pool.query('SELECT invoice_no FROM orders WHERE id = ?', [orderId]);
    const invoiceNo = orders[0]?.invoice_no || orderId;

    return res.redirect(`/order-success?invoice=${encodeURIComponent(invoiceNo)}&paid=1`);
  } catch (err) {
    next(err);
  }
}

/**
 * Handles DBBL Rocket return callback.
 * GET/POST /payment/rocket/callback
 */
async function rocketCallback(req, res, next) {
  try {
    const paymentId = String(req.query.payment_id || req.body.payment_id || '').trim();
    const orderId = Number(req.query.order_id || req.body.order_id || 0);

    if (!paymentId) throw new ValidationError('Rocket payment ID is missing from callback.');

    await webhookService.processWebhookEvent({
      gatewayCode: 'rocket_api',
      eventType: 'callback',
      uniqueEventId: paymentId,
      headers: req.headers,
      payload: { ...req.query, ...req.body },
      clientIp: req.ip,
      handlerFn: async (tx) => {
        const verified = await rocket.verifyPayment({ paymentId });

        await webhookService.settleOrderPayment(tx, orderId, {
          gatewayCode: 'rocket_api',
          paymentId: verified.paymentId,
          trxId: verified.trxId,
          amountPaisa: verified.amountPaisa,
          rawResponse: verified.raw,
        });

        return verified;
      },
    });

    const pool = mysql.getPool();
    const [orders] = await pool.query('SELECT invoice_no FROM orders WHERE id = ?', [orderId]);
    const invoiceNo = orders[0]?.invoice_no || orderId;

    return res.redirect(`/order-success?invoice=${encodeURIComponent(invoiceNo)}&paid=1`);
  } catch (err) {
    next(err);
  }
}

/**
 * Cash on Delivery (COD) Anti-Fraud Check endpoint before order placement.
 * POST /payment/cod/verify
 */
async function verifyCodEligibility(req, res, next) {
  try {
    const { phone, total_paisa, district } = req.body;
    const assessment = await codGuard.evaluateCodEligibility({
      phone,
      totalPaisa: Number(total_paisa || 0),
      district: String(district || ''),
      customerId: req.customerUser?.id || null,
    });

    return res.json({ success: true, assessment });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  initiatePayment,
  bkashCallback,
  nagadCallback,
  rocketCallback,
  verifyCodEligibility,
};
