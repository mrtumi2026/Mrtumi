'use strict';

/**
 * Payment Routes — Bangladesh MFS
 * =================================
 * Wires customer checkout, redirect gateways (bKash, Nagad, Rocket), and COD safeguard.
 */

const express = require('express');
const paymentController = require('../controllers/paymentController');
const { requireCsrf } = require('../middleware/csrf');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Automated gateway checkout is NOT launch-ready: callbacks take order_id from the
// request without binding it to a provider-verified payment. These routes stay closed
// until that is implemented and verified with real merchant credentials.
router.use(['/payment/initiate', '/payment/bkash', '/payment/nagad', '/payment/rocket', '/webhooks'],
  (_req, res) => res.sendStatus(404));

const paymentInitiateLimiter = createRateLimiter({
  keyPrefix: 'pay_initiate',
  windowMs: 60_000,
  max: 20,
});

const webhookLimiter = createRateLimiter({
  keyPrefix: 'pay_webhook',
  windowMs: 60_000,
  max: 120,
});

// Customer payment session initiation (protected by CSRF and rate limiting)
router.post('/payment/initiate/:gateway', paymentInitiateLimiter, requireCsrf, paymentController.initiatePayment);

// Gateway browser redirect callbacks (exempt from CSRF because calls originate from external MFS gateway domains)
router.get('/payment/bkash/callback', paymentController.bkashCallback);
router.all('/payment/nagad/callback', paymentController.nagadCallback);
router.all('/payment/rocket/callback', paymentController.rocketCallback);

// Inbound IPN Webhook callbacks
router.post('/webhooks/nagad/ipn', webhookLimiter, paymentController.nagadCallback);
router.post('/webhooks/rocket/ipn', webhookLimiter, paymentController.rocketCallback);

// Cash on Delivery (COD) Anti-Fraud Check endpoint
router.post('/payment/cod/verify', requireCsrf, paymentController.verifyCodEligibility);

module.exports = router;
