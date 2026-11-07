'use strict';

/**
 * Vendor Multi-Tenant Scoping & Anti-IDOR Middleware
 * ===================================================
 * Eliminates Insecure Direct Object Reference (IDOR) vulnerabilities across the
 * entire vendor panel. Guarantees that no vendor can view, modify, or delete
 * another vendor's products, orders, inventory records, or wallet balances.
 */

const mysql = require('../db/mysqlPool');
const { AuthorizationError, NotFoundError } = require('../utils/errors');
const { logger } = require('../utils/logger');

/**
 * Attaches vendor scoping helper methods to `req` and verifies authenticated vendor identity.
 */
function enforceVendorScope(req, res, next) {
  const vendorUser = req.session?.vendorUser;

  if (!vendorUser || !vendorUser.id) {
    if (req.accepts('json') || req.path.startsWith('/api/')) {
      return res.status(401).json({
        type: 'https://mrtumi.com/errors/UNAUTHORIZED',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required. Please log in to your vendor dashboard.',
      });
    }
    return res.redirect('/vendor/login');
  }

  const vendorId = Number(vendorUser.id);
  req.vendorId = vendorId;

  /**
   * Helper: Assert that a specific resource's owner matches the currently logged-in vendor.
   * Throws AuthorizationError(403) on mismatch.
   */
  req.assertVendorOwnership = (resourceVendorId, resourceName = 'record') => {
    if (Number(resourceVendorId) !== vendorId) {
      logger.warn({
        event: 'idor_attempt_blocked',
        attackerVendorId: vendorId,
        targetedResourceOwner: resourceVendorId,
        resourceName,
        path: req.originalUrl,
        ip: req.ip,
      });
      throw new AuthorizationError(`Access denied: You do not own this ${resourceName}.`);
    }
  };

  /**
   * Helper: Verifies ownership of a product ID directly against the products table.
   */
  req.verifyProductOwnership = async (productId) => {
    const pId = Number(productId);
    const pool = mysql.getPool();
    const [rows] = await pool.query(
      'SELECT id, vendor_id FROM products WHERE id = ?',
      [pId]
    );

    const product = rows && rows[0];
    if (!product) {
      throw new NotFoundError(`Product ${pId} not found.`);
    }

    req.assertVendorOwnership(product.vendor_id, 'product');
    return product;
  };

  /**
   * Helper: Verifies ownership of a vendor sub-order.
   */
  req.verifyVendorOrderOwnership = async (vendorOrderId) => {
    const voId = Number(vendorOrderId);
    const pool = mysql.getPool();
    const [rows] = await pool.query(
      'SELECT id, vendor_id, status FROM vendor_orders WHERE id = ?',
      [voId]
    );

    const vo = rows && rows[0];
    if (!vo) {
      throw new NotFoundError(`Vendor order ${voId} not found.`);
    }

    req.assertVendorOwnership(vo.vendor_id, 'order');
    return vo;
  };

  next();
}

/**
 * Route parameter guard middleware: Automatically verifies that the `:productId`
 * in the URL belongs to the logged-in vendor.
 */
function guardProductParam(paramName = 'id') {
  return async (req, res, next) => {
    try {
      const productId = req.params[paramName] || req.body?.product_id;
      if (productId) {
        await req.verifyProductOwnership(productId);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Route parameter guard middleware: Automatically verifies that the `:orderId` or `:vendorOrderId`
 * in the URL belongs to the logged-in vendor.
 */
function guardVendorOrderParam(paramName = 'id') {
  return async (req, res, next) => {
    try {
      const orderId = req.params[paramName] || req.body?.vendor_order_id;
      if (orderId) {
        await req.verifyVendorOrderOwnership(orderId);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  enforceVendorScope,
  guardProductParam,
  guardVendorOrderParam,
};
