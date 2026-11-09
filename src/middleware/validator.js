'use strict';

/**
 * Centralized Input Sanitization & Validation Middleware
 * ======================================================
 * Neutralizes XSS injection, prototype pollution, null-byte poisoning,
 * and normalizes all incoming request data before reaching business controllers.
 * Formats errors according to RFC 7807 Problem Details standard.
 */

const { ValidationError } = require('../utils/errors');
const { env } = require('../config/env');

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively sanitizes strings and objects.
 */
function sanitizeValue(val) {
  if (val === null || val === undefined) return val;

  if (typeof val === 'string') {
    return val
      // Strip dangerous null bytes
      .replace(/\0/g, '')
      // Neutralize javascript: pseudo-protocol
      .replace(/javascript:/gi, '')
      // Strip script tags
      .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
      // Neutralize inline event handlers like onerror=, onload=
      .replace(/on\w+\s*=/gi, '')
      .trim();
  }

  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValue(item));
  }

  if (typeof val === 'object' && val !== null) {
    const cleanObj = {};
    for (const [key, subVal] of Object.entries(val)) {
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
        continue; // Drop prototype pollution attempt
      }
      cleanObj[key] = sanitizeValue(subVal);
    }
    return cleanObj;
  }

  return val;
}

/**
 * Global sanitize middleware: runs on req.body, req.query, and req.params.
 */
function sanitizeRequestMiddleware(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeValue(req.params);
  }
  next();
}

/**
 * RFC 7807 Standardized Problem Details Error Response Formatter
 */
function formatProblemDetails(err, req) {
  const statusCode = Number(err.statusCode || err.status || 500);
  const isProd = env.isProduction;

  const problem = {
    type: `https://mrtumi.com/errors/${err.code || 'INTERNAL_ERROR'}`,
    title: err.name || 'Internal Server Error',
    status: statusCode,
    detail: isProd && statusCode >= 500
      ? 'An unexpected error occurred. Please contact support.'
      : err.message,
    instance: req.originalUrl || req.url,
    timestamp: new Date().toISOString(),
  };

  if (err.errors || err.invalidParams) {
    problem.invalidParams = err.errors || err.invalidParams;
  }

  return problem;
}

/**
 * Schema Validation Middleware Factory
 * Compatible with Joi, express-validator, or lightweight custom rules.
 *
 * Example usage:
 *   router.post('/login', validateSchema(loginSchema), authController.login);
 */
function validateSchema(schema) {
  return (req, _res, next) => {
    if (!schema) return next();

    // If Joi schema provided
    if (typeof schema.validate === 'function') {
      const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        const details = error.details.map((d) => ({
          field: d.path.join('.'),
          message: d.message.replace(/['"]/g, ''),
        }));
        const valErr = new ValidationError('Validation failed for request parameters.');
        valErr.invalidParams = details;
        return next(valErr);
      }

      req.body = value;
      return next();
    }

    // If custom validator function provided: fn(body) -> { error, value }
    if (typeof schema === 'function') {
      try {
        const validated = schema(req.body);
        if (validated) req.body = validated;
        return next();
      } catch (err) {
        return next(err);
      }
    }

    next();
  };
}

module.exports = {
  sanitizeRequestMiddleware,
  formatProblemDetails,
  validateSchema,
  sanitizeValue,
};
