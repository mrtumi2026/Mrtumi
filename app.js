'use strict';

/**
 * Candidate deployment wrapper. `server.js` owns the Express app and listens on
 * the configured HOST/PORT. Select this file as a host startup target only after
 * confirming that account's application-entry and process-manager contract; no
 * cPanel/Passenger port or environment-variable behavior is assumed here.
 */
const { env } = require('./src/config/env');

// This is the deployment entry point. Development remains available through `npm run dev`;
// tests may import the Express app, but starting it in test mode requires an explicit test-only opt-in.
const isStartupInvocation = require.main === module || typeof PhusionPassenger !== 'undefined';
if (!env.isProduction && !env.isTest) {
  throw new Error('DEPLOYMENT STARTUP ERROR: app.js requires NODE_ENV=production (use `npm run dev` for local development).');
}
if (env.isTest && isStartupInvocation && process.env.APP_ALLOW_TEST_STARTUP !== 'true') {
  throw new Error('DEPLOYMENT STARTUP ERROR: NODE_ENV=test cannot start app.js without the explicit test-only APP_ALLOW_TEST_STARTUP=true flag.');
}

const { app, startServer } = require('./server');

if (isStartupInvocation) {
  startServer();
}

module.exports = app;
