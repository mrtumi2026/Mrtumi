'use strict';

const path = require('path');
const express = require('express');
const { env } = require('./src/config/env');
const db = require('./src/db/database');
const { logger } = require('./src/utils/logger');
const { sendError } = require('./src/utils/apiResponse');
const sessionManager = require('./src/middleware/sessionManager');
const { attachCsrfToken } = require('./src/middleware/csrf');
const { attachRequestId, wantsJsonResponse, createErrorHandler } = require('./src/middleware/errorHandler');
const { attachGlobals } = require('./src/middleware/auth');
const { recordErrorLog } = require('./src/repositories/auditLogRepository');

const apiFoundationRoutes = require('./src/routes/apiFoundation');
const adminAuthRoutes = require('./src/routes/adminAuth');
const adminDashboardRoutes = require('./src/routes/adminDashboard');
const adminOrdersRoutes = require('./src/routes/adminOrders');
const adminCatalogRoutes = require('./src/routes/adminCatalog');
const adminOperationsRoutes = require('./src/routes/adminOperations');
const adminSettingsRoutes = require('./src/routes/adminSettings');
const vendorPanelRoutes = require('./src/routes/vendorPanel');
const resellerPanelRoutes = require('./src/routes/resellerPanel');
const storefrontRoutes = require('./src/routes/storefront');

// Initialize local SQLite prototype ONLY in non-production when DB_CLIENT=sqlite.
// Production strictly uses MySQL via versioned migrations (`npm run migrate:up`).
if (!env.isProduction && env.db.client === 'sqlite') {
  db.initializeDatabase();
}

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Allow embedding in Arena live preview iframes in non-production environments
if (!env.isProduction) {
  app.use((_req, res, next) => {
    res.removeHeader('X-Frame-Options');
    next();
  });
}

app.use(attachRequestId);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Database-backed sessions + CSRF token binding
app.use(sessionManager);
app.use(attachCsrfToken);

// Health, readiness & API foundation endpoints (mounted before full portal nav load)
app.use(apiFoundationRoutes);

// Portal template globals (settings, categories, actors, RBAC helpers)
app.use(attachGlobals);

// Mount modular portal routes
app.use(adminAuthRoutes);
app.use(adminDashboardRoutes);
app.use(adminOrdersRoutes);
app.use(adminCatalogRoutes);
app.use(adminOperationsRoutes);
app.use(adminSettingsRoutes);
app.use(vendorPanelRoutes);
app.use(resellerPanelRoutes);
app.use(storefrontRoutes);

// 404 Handler (JSON envelope for API paths, HTML/redirects for portal paths)
app.use((req, res) => {
  if (wantsJsonResponse(req)) {
    return sendError(res, {
      statusCode: 404,
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found.`,
    });
  }
  if (req.path.startsWith('/admin')) return res.redirect('/admin/dashboard');
  if (req.path.startsWith('/vendor')) return res.redirect('/vendor/dashboard');
  if (req.path.startsWith('/reseller')) return res.redirect('/reseller/dashboard');
  return res.status(404).render('store/page', {
    mode: 'cms',
    blogs: [],
    page: {
      title: '৪০৪ - পেজটি খুঁজে পাওয়া যায়নি',
      content: 'দুঃখিত, আপনি যে পেজটি খুঁজছেন তা পাওয়া যায়নি। হোম পেজে ফিরে আমাদের পণ্যগুলো দেখুন।',
    },
  });
});

// Centralized Error Handler
app.use(createErrorHandler({ persistErrorLog: recordErrorLog }));

function startServer(port = env.port, host = env.host) {
  return app.listen(port, host, () => {
    logger.info('HTTP server listening', {
      appName: env.appName,
      environment: env.nodeEnv,
      dbClient: env.db.client,
      url: `http://${host}:${port}`,
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
