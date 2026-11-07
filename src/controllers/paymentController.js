'use strict';

/**
 * Payment Controller
 * ==================
 * Production orchestrator connecting browser checkout with gateways,
 * executing server-to-server verification, and processing callbacks safely.
 */

const bkash = require('../services/gateways/bkashService');
const shurjopay = require('../services/gateways/shurjopayService');
const uddoktapay = require('../services/gateways/uddoktapayService');
const webhookService = require('../services/paymentWebhookService');
const codGuard = require('../services/codGuardService');
const mysql = require('../db/mysqlPool');
const { ValidationError, NotFoundError, AppError } = require('../utils/errors');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');

/**
 * Initiates an automated payment gateway session for an existing order.
 * POST /payment/initiate/:gateway
 */
async function initiatePayment(req, res, next) {
  try {
    const gateway = String(req.params.gateway || '').toLowerCase();
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

    // 1. bKash Tokenized
    if (gateway === 'bkash' || gateway === 'bkash_tokenized') {
      const callbackUrl = `${env.appUrl}/payment/bkash/callback?order_id=${orderId}`;
      const session = await bkash.createPayment({
        orderId,
        invoiceNo: order.invoice_no,
        amountPaisa: amountToCharge,
        callbackUrl,
      });

      return res.redirect(session.bkashURL);
    }

    // 2. ShurjoPay
    if (gateway === 'shurjopay') {
      const returnUrl = `${env.appUrl}/payment/shurjopay/callback?order_id=${orderId}`;
      const cancelUrl = `${env.appUrl}/checkout?cancelled=1&order_id=${orderId}`;

      const session = await shurjopay.initiatePayment({
        orderId,
        invoiceNo: order.invoice_no,
        amountPaisa: amountToCharge,
        customer: {
          name: order.customer_name,
          phone: order.customer_phone,
          address: order.shipping_address,
          city: order.district,
        },
        returnUrl,
        cancelUrl,
        clientIp: req.ip || '127.0.0.1',
      });

      return res.redirect(session.checkoutUrl);
    }

    // 3. UddoktaPay
    if (gateway === 'uddoktapay') {
      const redirectUrl = `${env.appUrl}/payment/uddoktapay/callback?order_id=${orderId}`;
      const cancelUrl = `${env.appUrl}/checkout?cancelled=1&order_id=${orderId}`;
      const webhookUrl = `${env.appUrl}/webhooks/uddoktapay`;

      const session = await uddoktapay.createPayment({
        orderId,
        invoiceNo: order.invoice_no,
        amountPaisa: amountToCharge,
        customer: {
          name: order.customer_name,
          phone: order.customer_phone,
        },
        redirectUrl,
        cancelUrl,
        webhookUrl,
      });

      return res.redirect(session.paymentUrl);
    }

    throw new ValidationError(`Unsupported online gateway: ${gateway}`);
  } catch (err) {
    next(err);
  }
}

/**
 * Handles bKash redirect callback after customer completes authentication in bKash frame.
 * GET /payment/bkash/callback
 */
async function bkashCallback(req, res, next) {
  try {
    const paymentID = String(req.query.paymentID || '').trim();
    const status = String(req.query.status || '').toLowerCase();
    const orderId = Number(req.query.order_id);

    if (status === 'cancel' || status === 'failure') {
      logger.warn({ event: 'bkash_payment_cancelled_or_failed', status, orderId, paymentID });
      return res.redirect(`/checkout?error=Payment+was+${status}&order_id=${orderId}`);
    }

    if (status !== 'success' || !paymentID) {
      throw new ValidationError('bKash callback reported invalid payment outcome.');
    }

    // Process payment execution via Idempotent Webhook Engine
    await webhookService.processWebhookEvent({
      gatewayCode: 'bkash_tokenized',
      eventType: 'callback',
      uniqueEventId: paymentID,
      headers: req.headers,
      payload: req.query,
      clientIp: req.ip,
      handlerFn: async (tx) => {
        // Execute payment with bKash server
        const execution = await bkash.executePayment(paymentID);

        // Mark order and vendor sub-orders as settled
        await webhookService.settleOrderPayment(tx, orderId, {
          gatewayCode: 'bkash_tokenized',
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
 * Handles ShurjoPay return callback.
 * ALL /payment/shurjopay/callback
 */
async function shurjopayCallback(req, res, next) {
  try {
    const spOrderId = String(req.query.sp_order_id || req.body.sp_order_id || req.query.order_id || req.body.order_id || '').trim();
    const orderId = Number(req.query.order_id || req.body.value1 || 0);

    if (!spOrderId) throw new ValidationError('ShurjoPay sp_order_id missing from callback.');

    await webhookService.processWebhookEvent({
      gatewayCode: 'shurjopay',
      eventType: 'callback',
      uniqueEventId: spOrderId,
      headers: req.headers,
      payload: { ...req.query, ...req.body },
      clientIp: req.ip,
      handlerFn: async (tx) => {
        const verified = await shurjopay.verifyPayment(spOrderId);

        if (!verified.isSuccess) {
          throw new AppError('SHURJOPAY_DECLINED', `ShurjoPay declined: ${verified.spMessage}`, 400);
        }

        const targetOrderId = orderId || verified.orderId;
        await webhookService.settleOrderPayment(tx, targetOrderId, {
          gatewayCode: 'shurjopay',
          paymentId: verified.spOrderId,
          trxId: verified.bankTrxId,
          amountPaisa: verified.amountPaisa,
          rawResponse: verified.raw,
        });

        return verified;
      },
    });

    return res.redirect(`/order-success?sp_order=${encodeURIComponent(spOrderId)}&paid=1`);
  } catch (err) {
    next(err);
  }
}

/**
 * Handles UddoktaPay IPN / Webhook callback.
 * POST /webhooks/uddoktapay
 */
async function uddoktapayWebhook(req, res) {
  try {
    const invoiceId = req.body.invoice_id || req.body.metadata?.invoice_id;
    if (!invoiceId) {
      return res.status(400).json({ error: 'Missing invoice_id' });
    }

    const result = await webhookService.processWebhookEvent({
      gatewayCode: 'uddoktapay',
      eventType: 'webhook',
      uniqueEventId: String(invoiceId),
      headers: req.headers,
      payload: req.body,
      clientIp: req.ip,
      handlerFn: async (tx) => {
        const verified = await uddoktapay.verifyPayment(invoiceId);

        if (!verified.isSuccess) {
          throw new AppError('UDDOKTAPAY_NOT_COMPLETED', 'Payment verification was not completed.', 400);
        }

        await webhookService.settleOrderPayment(tx, verified.orderId, {
          gatewayCode: 'uddoktapay',
          paymentId: verified.invoiceId,
          trxId: verified.transactionId,
          amountPaisa: verified.amountPaisa,
          rawResponse: verified.raw,
        });

        return verified;
      },
    });

    return res.status(200).json({ success: true, replayed: result.isReplay });
  } catch (err) {
    logger.error({ event: 'uddoktapay_webhook_error', error: err.message });
    return res.status(err.statusCode || 500).json({ error: err.message });
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
  shurjopayCallback,
  uddoktapayWebhook,
  verifyCodEligibility,
};
