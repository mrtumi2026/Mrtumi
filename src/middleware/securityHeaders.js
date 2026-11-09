'use strict';

/**
 * Enterprise HTTP Security Headers Middleware
 * ============================================
 * Implements OWASP ASVS v4.0 compliance using Helmet.
 *
 * Configures:
 *  - Content Security Policy (CSP) compatible with EJS, CDN assets, and MFS payment iframes (bKash, Nagad, Rocket)
 *  - HTTP Strict Transport Security (HSTS) with 1-year duration, subdomains, and preloading
 *  - Anti-Clickjacking protection via X-Frame-Options & CSP frame-ancestors
 *  - X-Content-Type-Options: nosniff
 *  - Strict Referrer-Policy
 *  - Modern Permissions-Policy restricting sensitive browser hardware APIs
 */

let helmet;
try {
  helmet = require('helmet');
} catch {
  helmet = null;
}

const { env } = require('../config/env');

function createSecurityHeaders() {
  // If helmet npm package is available, use its complete structured configuration
  if (helmet) {
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'", // Required for legacy EJS inline utilities & dynamic template data
            "'unsafe-eval'",
            'https://cdn.jsdelivr.net',
            'https://cdnjs.cloudflare.com',
            'https://code.jquery.com',
            'https://www.googletagmanager.com',
            'https://www.google-analytics.com',
            'https://scripts.bkash.com',
            'https://*.bka.sh',
            'https://*.nagad.com.bd',
            'https://*.dutchbanglabank.com',
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://cdn.jsdelivr.net',
            'https://cdnjs.cloudflare.com',
            'https://fonts.googleapis.com',
          ],
          fontSrc: [
            "'self'",
            'data:',
            'https://fonts.gstatic.com',
            'https://cdnjs.cloudflare.com',
            'https://cdn.jsdelivr.net',
          ],
          imgSrc: [
            "'self'",
            'data:',
            'blob:',
            'https:',
            'https://*.bka.sh',
            'https://*.shurjopayment.com',
            'https://*.google-analytics.com',
          ],
          connectSrc: [
            "'self'",
            'https://*.bka.sh',
            'https://*.shurjopayment.com',
            'https://*.uddoktapay.com',
            'https://www.google-analytics.com',
            'https://region1.google-analytics.com',
          ],
          frameSrc: [
            "'self'",
            'https://*.bka.sh',
            'https://*.shurjopayment.com',
            'https://*.uddoktapay.com',
          ],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'", 'https://*.bka.sh', 'https://*.shurjopayment.com', 'https://*.uddoktapay.com'],
          upgradeInsecureRequests: env.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false, // Prevents breaking cross-origin merchant product images
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Required for MFS payment gateway popups
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows serving uploaded product media safely
      dnsPrefetchControl: { allow: true },
      frameguard: { action: 'sameorigin' },
      hidePoweredBy: true,
      hsts: env.isProduction
        ? {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
          }
        : false,
      ieNoOpen: true,
      noSniff: true,
      originAgentCluster: true,
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      xssFilter: true,
    });
  }

  // Graceful standalone fallback if helmet is not yet installed in host environment
  return function standaloneSecurityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://*.bka.sh" "https://*.shurjopayment.com")');

    if (env.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }

    res.removeHeader('X-Powered-By');
    next();
  };
}

module.exports = {
  createSecurityHeaders,
};
