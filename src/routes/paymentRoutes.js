'use strict';

/**
 * Payment Routes
 * ==============
 * Wires customer checkout, redirect gateways, and inbound webhooks.
 */

const express = require('express');
const paymentController = require('../controllers/paymentController');
const { requireCsrf } = require('../middleware/csrf');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const paymentInitiateLimiter = createRateLimiter({
  keyPrefix: 'pay_initiate',
  windowMs: 60_000,
  max: 15,
});

const webhookLimiter = createRateLimiter({
  keyPrefix: 'pay_webhook',
  windowMs: 60_000,
  max: 120,
});

// Customer payment session initiation (protected by CSRF and rate limiting)
router.post('/payment/initiate/:gateway', paymentInitiateLimiter, requireCsrf, paymentController.initiatePayment);

// Gateway browser redirect callbacks (must NOT enforce CSRF because they originate from external bank/gateway domains)
router.get('/payment/bkash/callback', paymentController.bkashCallback);
router.all('/payment/shurjopay/callback', paymentController.shurjopayCallback);
router.all('/payment/uddoktapay/callback', (req, res) => {
  const orderId = req.query.order_id || req.body?.metadata?.order_id;
  return res.redirect(`/order-success?order_id=${encodeURIComponent(orderId || '')}`);
});

// Server-to-server asynchronous webhooks & IPN endpoints
router.post('/webhooks/uddoktapay', webhookLimiter, paymentController.uddoktapayWebhook);

// Cash on Delivery (COD) Anti-Fraud Check endpoint
router.post('/payment/cod/verify', requireCsrf, paymentController.verifyCodEligibility);

module.exports = router;
