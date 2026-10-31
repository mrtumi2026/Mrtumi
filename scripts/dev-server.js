'use strict';

// Explicit non-production entry point; keep development defaults out of deployment startup paths.
if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  throw new Error('Development startup requires NODE_ENV=development.');
}
process.env.NODE_ENV = 'development';

const { startServer } = require('../server');
startServer();
