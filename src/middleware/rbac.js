'use strict';

const { AuthenticationError, AuthorizationError } = require('../utils/errors');

/**
 * Checks whether an authenticated admin/staff user possesses a specific permission key.
 * Super Admin (`super_admin` slug or `Super Admin` role name) holds full platform access.
 */
function hasPermission(user, permKey) {
  if (!user) return false;
  const roleSlug = String(user.role_slug || user.role_name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (roleSlug === 'super_admin' || roleSlug === 'superadmin') {
    return true;
  }
  if (Array.isArray(user.permissions)) {
    return user.permissions.includes(permKey) || user.permissions.includes('*');
  }
  return false;
}

/**
 * Server-side role guard for API & portal routes.
 */
function requireRole(...allowedRoles) {
  const normalizedAllowed = allowedRoles.map((r) =>
    String(r).trim().toLowerCase().replace(/\s+/g, '_')
  );

  return function roleGuard(req, _res, next) {
    const user = req.adminUser || (resLocalsUser(req));
    if (!user) {
      return next(new AuthenticationError());
    }
    const roleSlug = String(user.role_slug || user.role_name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');

    if (roleSlug === 'super_admin' || normalizedAllowed.includes(roleSlug)) {
      return next();
    }
    return next(
      new AuthorizationError('Your role does not have access to this resource.')
    );
  };
}

/**
 * Server-side granular permission guard. Never trusts client-side UI visibility.
 */
function requirePermission(...requiredPermKeys) {
  return function permissionGuard(req, _res, next) {
    const user = req.adminUser || resLocalsUser(req);
    if (!user) {
      return next(new AuthenticationError());
    }
    const allowed = requiredPermKeys.every((perm) => hasPermission(user, perm));
    if (!allowed) {
      return next(
        new AuthorizationError('Insufficient permissions for this action.')
      );
    }
    return next();
  };
}

function resLocalsUser(req) {
  return req.res && req.res.locals ? req.res.locals.adminUser : null;
}

module.exports = {
  hasPermission,
  requireRole,
  requirePermission,
};
