'use strict';

const { withTransaction } = require('../db/mysqlPool');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');

/**
 * Atomically adjusts either warehouse stock (`stock_on_hand`) or separate vendor stock
 * (`vendor_stock_on_hand`) using `SELECT ... FOR UPDATE` row locking and writes an
 * immutable `stock_ledger` audit row inside the same ACID transaction.
 *
 * Per approved business rule:
 * - Warehouse stock (`stock_on_hand`) serves in-house & reseller orders.
 * - Vendor stock (`vendor_stock_on_hand`) is tracked strictly separately and never
 *   silently draws down warehouse stock (or vice versa).
 */
async function adjustProductStockAtomically(
  {
    productId,
    stockPool, // 'warehouse' | 'vendor'
    movementType = 'adjustment',
    qtyDelta,
    reason = '',
    vendorId = null,
    referenceType = null,
    referenceId = null,
    actorUserId = null,
    existingTx = null,
  },
  poolOverride = null
) {
  if (!['warehouse', 'vendor'].includes(stockPool)) {
    throw new ValidationError(`Invalid stockPool "${stockPool}". Must be "warehouse" or "vendor".`);
  }
  if (!Number.isSafeInteger(qtyDelta) || qtyDelta === 0) {
    throw new ValidationError('qtyDelta must be a non-zero integer.');
  }

  const runInTx = async (tx) => {
    const lockedRows = await tx.lockRowsById('products', [productId], [
      'id',
      'vendor_id',
      'stock_on_hand',
      'vendor_stock_on_hand',
    ]);
    const product = lockedRows[0];
    if (!product) {
      throw new NotFoundError(`Product #${productId} not found.`);
    }

    if (stockPool === 'vendor' && !product.vendor_id) {
      throw new ValidationError(`Product #${productId} is not assigned to a vendor stock pool.`);
    }

    const col = stockPool === 'warehouse' ? 'stock_on_hand' : 'vendor_stock_on_hand';
    const currentBalance = Number(product[col]);
    const nextBalance = currentBalance + qtyDelta;

    if (nextBalance < 0) {
      throw new AppError(
        'INSUFFICIENT_STOCK',
        `Insufficient ${stockPool} stock for product #${productId} (available: ${currentBalance}, requested delta: ${qtyDelta}).`,
        409,
        { productId: Number(product.id), stockPool, available: currentBalance, requestedDelta: qtyDelta }
      );
    }

    await tx.execute(`UPDATE \`products\` SET \`${col}\` = ? WHERE \`id\` = ?`, [
      nextBalance,
      productId,
    ]);

    await tx.execute(
      `INSERT INTO \`stock_ledger\`
        (\`product_id\`, \`stock_pool\`, \`vendor_id\`, \`movement_type\`, \`qty_delta\`, \`balance_after\`, \`reference_type\`, \`reference_id\`, \`reason\`, \`actor_user_id\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productId,
        stockPool,
        vendorId ?? product.vendor_id ?? null,
        String(movementType || 'adjustment').slice(0, 40),
        qtyDelta,
        nextBalance,
        referenceType ? String(referenceType).slice(0, 40) : null,
        referenceId ?? null,
        String(reason || '').slice(0, 255),
        actorUserId ?? null,
      ]
    );

    return {
      productId: Number(product.id),
      stockPool,
      previousBalance: currentBalance,
      qtyDelta,
      balanceAfter: nextBalance,
    };
  };

  if (existingTx) {
    return runInTx(existingTx);
  }
  return withTransaction(runInTx, { pool: poolOverride });
}

module.exports = {
  adjustProductStockAtomically,
};
