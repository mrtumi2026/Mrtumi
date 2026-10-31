'use strict';

class AppError extends Error {
  constructor(code, message, statusCode = 500, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || 'INTERNAL_ERROR';
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required.') {
    super('UNAUTHENTICATED', message, 401);
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions for this action.') {
    super('FORBIDDEN', message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Requested resource was not found.') {
    super('NOT_FOUND', message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Duplicate or conflicting operation.', details = null) {
    super('CONFLICT', message, 409, details);
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', retryAfterSec = 60) {
    super('RATE_LIMITED', message, 429, { retryAfterSec });
    this.retryAfterSec = retryAfterSec;
  }
}

class DatabaseError extends AppError {
  constructor(code = 'DB_ERROR', message = 'A database operation failed.', statusCode = 503) {
    super(code, message, statusCode);
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  DatabaseError,
};
