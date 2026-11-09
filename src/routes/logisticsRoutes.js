'use strict';

/**
 * Logistics & Courier Routes
 * ==========================
 * Connects booking requests from admin/vendor portals and receives incoming
 * delivery status webhooks from Steadfast and Pathao.
 */

const express = require('express');
const logisticsController = require('../controllers/logisticsController');
const { requireCsrf } = require('../middleware/csrf');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const bookingLimiter = createRateLimiter({
  keyPrefix: 'courier_book',
  windowMs: 60_000,
  max: 30,
});

const webhookLimiter = createRateLimiter({
  keyPrefix: 'courier_webhook',
  windowMs: 60_000,
  max: 120,
});

// Single-click dispatch endpoint for admin or authenticated vendor (CSRF protected)
router.post('/api/courier/book', bookingLimiter, requireCsrf, logisticsController.bookShipment);

// Inbound Courier Status Webhooks (No CSRF requirement because calls originate from courier servers)
router.post('/api/courier/webhook/steadfast', webhookLimiter, logisticsController.steadfastWebhook);
router.post('/api/courier/webhook/pathao', webhookLimiter, logisticsController.pathaoWebhook);

module.exports = router;
