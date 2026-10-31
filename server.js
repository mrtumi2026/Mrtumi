'use strict';

const path = require('path');
const express = require('express');
const { env } = require('./src/config/env');
const db = require('./src/db/database');
const { logger } = require('./src/utils/logger');
const { sendError } = require('./src/utils/apiResponse');
const sessionManager = require('./src/middleware/sessionManager');
const { attachCsrfToken } = require('./src/middleware/csrf');
const { i18nMiddleware } = require('./src/middleware/i18n');
const { attachRequestId, wantsJsonResponse, createErrorHandler } = require('./src/middleware/errorHandler');
const { attachGlobals } = require('./src/middleware/auth');
const { legacyAdminRbac, legacyAdminCsrf } = require('./src/middleware/legacyAdminRbac');
const { legacyAdminAudit } = require('./src/middleware/legacyAdminAudit');
const { recordErrorLog } = require('./src/repositories/auditLogRepository');

if (require.main === module && env.isDevelopment) {
  throw new Error('DEPLOYMENT STARTUP ERROR: direct server.js startup refuses development defaults; use `npm run dev` locally or configure production and use app.js.');
}

const localeRoutes = require('./src/routes/locale');
const apiFoundationRoutes = require('./src/routes/apiFoundation');
const adminAuthRoutes = require('./src/routes/adminAuth');
const adminDashboardRoutes = require('./src/routes/adminDashboard');
const adminAccessRoutes = require('./src/routes/adminAccess');
const adminPrivacyRoutes = require('./src/routes/adminPrivacy');
const adminOrdersRoutes = require('./src/routes/adminOrders');
const adminCatalogRoutes = require('./src/routes/adminCatalog');
const adminOperationsRoutes = require('./src/routes/adminOperations');
const adminSettingsRoutes = require('./src/routes/adminSettings');
const phase06Routes = require('./src/routes/phase06');
const vendorPanelRoutes = require('./src/routes/vendorPanel');
const resellerPanelRoutes = require('./src/routes/resellerPanel');
const storefrontRoutes = require('./src/routes/storefront');
const customerAccountRoutes = require('./src/routes/customerAccount');
const phase08AdminRoutes = require('./src/routes/phase08Admin');

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
app.locals.mysqlCheckoutEnabled = env.db.client === 'mysql';

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
// Keep uploaded admin images reachable when UPLOAD_DIR points outside the disposable app release.
// The default local path is also under public/, so this is only a fallback there.
app.use('/uploads/custom', express.static(path.join(env.uploadDir, 'custom'), { index: false }));

// Database-backed sessions + CSRF token binding + Bilingual i18n (`bn` default, `en` switch)
app.use(sessionManager);
app.use(attachCsrfToken);
app.use(i18nMiddleware);

// Locale switcher (`/locale/:lang`) & Health/API foundation endpoints
app.use(localeRoutes);
app.use(apiFoundationRoutes);

// Portal template globals (settings, categories, actors, RBAC helpers)
app.use(attachGlobals);
// Fail closed on every authenticated legacy admin route, and require CSRF on all admin writes.
// Route modules retain their local auth/permission checks and response behavior.
app.use(legacyAdminRbac);
app.use(legacyAdminCsrf);
app.use(legacyAdminAudit);

// Mount modular portal routes
app.use(adminAuthRoutes);
app.use(adminDashboardRoutes);
app.use(adminAccessRoutes);
app.use(adminPrivacyRoutes);
app.use(adminOrdersRoutes);
app.use(adminCatalogRoutes);
app.use(adminOperationsRoutes);
app.use(adminSettingsRoutes);
app.use(phase06Routes);
app.use(phase08AdminRoutes);
app.use(vendorPanelRoutes);
app.use(resellerPanelRoutes);
app.use(customerAccountRoutes);
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
      title: req.locale === 'en' ? '404 — Page Not Found' : '৪০৪ - পেজটি খুঁজে পাওয়া যায়নি',
      content:
        req.locale === 'en'
          ? 'Sorry, the page you requested could not be found. Return to the home page to browse our grocery and gift catalog.'
          : 'দুঃখিত, আপনি যে পেজটি খুঁজছেন তা পাওয়া যায়নি। হোম পেজে ফিরে আমাদের গ্রোসারি ও গিফট পণ্যগুলো দেখুন।',
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
