'use strict';

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' https://code.jquery.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "upgrade-insecure-requests",
  "report-uri /api/security/csp-report",
  "report-to csp-endpoint",
].join('; ');

const { env } = require('../config/env');

function createSecurityHeaders({ isProduction = env.isProduction } = {}) {
  return function securityHeaders(_req, res, next) {
    if (res.setHeader) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
      res.setHeader('Reporting-Endpoints', 'csp-endpoint="/api/security/csp-report"');
      if (isProduction) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      }
    }
    if (res.removeHeader) {
      res.removeHeader('X-Powered-By');
    }
    next();
  };
}

module.exports = { CSP_REPORT_ONLY, createSecurityHeaders };
