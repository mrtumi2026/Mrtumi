'use strict';

/**
 * cPanel CloudLinux "Setup Node.js App" (Phusion Passenger / LiteSpeed lsnode)
 * standard startup entry file.
 *
 * When invoked by Passenger/lsnode or directly via `node app.js`, starts the
 * HTTP listener on the environment/Passenger-assigned `process.env.PORT`.
 */
const { app, startServer } = require('./server');

if (require.main === module || typeof PhusionPassenger !== 'undefined') {
  startServer();
}

module.exports = app;
