'use strict';

const path = require('path');
const express = require('express');
const { env } = require('./src/config/env');
const db = require('./src/db/database');
const sessionManager = require('./src/middleware/sessionManager');
const { attachGlobals } = require('./src/middleware/auth');

const adminAuthRoutes = require('./src/routes/adminAuth');
const adminDashboardRoutes = require('./src/routes/adminDashboard');
const adminOrdersRoutes = require('./src/routes/adminOrders');
const adminCatalogRoutes = require('./src/routes/adminCatalog');
const adminOperationsRoutes = require('./src/routes/adminOperations');
const adminSettingsRoutes = require('./src/routes/adminSettings');
const vendorPanelRoutes = require('./src/routes/vendorPanel');
const resellerPanelRoutes = require('./src/routes/resellerPanel');
const storefrontRoutes = require('./src/routes/storefront');

db.initializeDatabase();

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

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware + template globals
app.use(sessionManager);
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

// 404 Handler
app.use((req, res) => {
  if (req.path.startsWith('/admin')) return res.redirect('/admin/dashboard');
  if (req.path.startsWith('/vendor')) return res.redirect('/vendor/dashboard');
  if (req.path.startsWith('/reseller')) return res.redirect('/reseller/dashboard');
  res.status(404).render('store/page', {
    mode: 'cms',
    blogs: [],
    page: {
      title: '৪০৪ - পেজটি খুঁজে পাওয়া যায়নি',
      content: 'দুঃখিত, আপনি যে পেজটি খুঁজছেন তা পাওয়া যায়নি। হোম পেজে ফিরে আমাদের পণ্যগুলো দেখুন।',
    },
  });
});

// Error Handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  try {
    db.run('INSERT INTO error_logs (level, message, context) VALUES (?, ?, ?)', 'ERROR', String(err.message || err), 'express');
  } catch (_e) {}
  res.status(500).send('Internal Server Error');
});

function startServer(port = env.port, host = env.host) {
  return app.listen(port, host, () => {
    console.log(`${env.appName} (${env.nodeEnv}) listening on http://${host}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
