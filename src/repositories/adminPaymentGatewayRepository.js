'use strict';

/**
 * Admin Payment Gateway & Verification Repository
 * ================================================
 * Governs the 7 dynamic Bangladesh MFS channels, on/off toggles,
 * credentials management, and atomic manual TrxID verification.
 */

const { env } = require('../config/env');
const mysql = require('../db/mysqlPool');
const sqliteDb = require('../db/database');
const { recordAuditLog } = require('./auditLogRepository');
const { requirePositiveInt } = require('../utils/validator');
const { ValidationError, NotFoundError } = require('../utils/errors');

function normalizeUpdate(input = {}) {
  const accountNumber = String(input.account_number ?? '').trim();
  const instructions = String(input.instructions ?? '').trim();
  const rawStatus = String(input.status ?? (input.is_active !== undefined ? (input.is_active ? '1' : '0') : ''));
  if (accountNumber.length > 100 || !/^[A-Za-z0-9+(). -]*$/.test(accountNumber)) {
    throw new ValidationError('Enter a valid receiving account number (maximum 100 characters).');
  }
  if (instructions.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions)) {
    throw new ValidationError('Instructions must not exceed 4000 characters or contain control characters.');
  }
  if (!['0', '1'].includes(rawStatus)) {
    throw new ValidationError('Choose Active or Inactive for gateway status.');
  }
  return { accountNumber, instructions, status: Number(rawStatus) };
}

function accountAudit(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return { last4: digits.slice(-4), configured: Boolean(value) };
}

/**
 * List all active/inactive MFS and COD channels.
 */
async function listPaymentGateways({ pool = null } = {}) {
  if (env.db.client === 'mysql' || pool) {
    const client = mysql.createQueryClient(pool || mysql.getPool());
    return client.queryAll(
      `SELECT id, name, code, mode, gateway_type, account_number, instructions, instructions_bn,
              is_active, status, min_order_paisa, max_order_paisa, api_credentials, updated_at
       FROM payment_gateways
       WHERE code IN ('cod', 'bkash_api', 'bkash_manual', 'nagad_api', 'nagad_manual', 'rocket_api', 'rocket_manual')
       ORDER BY CASE WHEN code='cod' THEN 0 ELSE 1 END, id ASC`
    );
  }
  return sqliteDb.all(
    `SELECT id, name, code, type AS gateway_type, 'manual' AS mode, account_number,
            instructions, instructions AS instructions_bn, status AS is_active, status
     FROM payment_gateways
     WHERE code IN ('cod', 'bkash_api', 'bkash_manual', 'nagad_api', 'nagad_manual', 'rocket_api', 'rocket_manual')
     ORDER BY CASE WHEN code='cod' THEN 0 ELSE 1 END, id ASC`
  );
}

/**
 * Immediate On/Off toggle for any payment channel.
 */
async function togglePaymentGateway(idInput, actor = {}, { pool = null } = {}) {
  const id = requirePositiveInt(idInput, 'Gateway ID');

  if (env.db.client === 'mysql' || pool) {
    const activePool = pool || mysql.getPool();
    return mysql.withTransaction(async (tx) => {
      const before = await tx.queryOne(
        'SELECT id, name, code, status, is_active FROM payment_gateways WHERE id=? FOR UPDATE',
        [id]
      );
      if (!before) throw new NotFoundError('Payment gateway not found.');

      const newStatus = Number(before.status || before.is_active || 0) === 1 ? 0 : 1;
      await tx.execute(
        'UPDATE payment_gateways SET status=?, is_active=? WHERE id=?',
        [newStatus, newStatus, id]
      );

      await recordAuditLog(
        {
          actorType: 'admin',
          actorId: actor.id || null,
          action: 'payment_gateway.updated',
          entityType: 'payment_gateway',
          entityId: id,
          beforeState: { code: before.code, active: Boolean(before.status) },
          afterState: { code: before.code, active: Boolean(newStatus) },
          ipAddress: actor.ip || '',
          userAgent: actor.userAgent || '',
        },
        tx
      );

      return { id, code: before.code, is_active: newStatus, status: newStatus };
    }, { pool: activePool });
  }

  const before = sqliteDb.get('SELECT id, name, code, status FROM payment_gateways WHERE id=?', id);
  if (!before) throw new NotFoundError('Payment gateway not found.');
  const newStatus = Number(before.status || 0) === 1 ? 0 : 1;
  sqliteDb.run('UPDATE payment_gateways SET status=? WHERE id=?', newStatus, id);
  return { id, code: before.code, is_active: newStatus, status: newStatus };
}

/**
 * Update gateway configuration, numbers, and Bengali instructions.
 */
async function updatePaymentGateway(idInput, input = {}, actor = {}, { pool = null } = {}) {
  const id = requirePositiveInt(idInput, 'Gateway ID');
  const update = normalizeUpdate(input);
  const instructionsBn = String(input.instructions_bn || update.instructions).trim();
  const apiCredentials = typeof input.api_credentials === 'object' && input.api_credentials !== null
    ? JSON.stringify(input.api_credentials)
    : String(input.api_credentials ?? '').trim();
  const minOrderPaisa = Number(input.min_order_paisa || 0);
  const maxOrderPaisa = input.max_order_paisa ? Number(input.max_order_paisa) : null;

  if (env.db.client === 'mysql' || pool) {
    const activePool = pool || mysql.getPool();
    return mysql.withTransaction(async (tx) => {
      const before = await tx.queryOne(
        `SELECT id, name, code, gateway_type, account_number, instructions, status FROM payment_gateways WHERE id=? FOR UPDATE`,
        [id]
      );
      if (!before) throw new NotFoundError('Payment gateway not found.');
      if (before.gateway_type === 'manual' && update.status === 1 && (!update.accountNumber || !update.instructions)) {
        throw new ValidationError('Configure both the receiving account number and customer instructions before activating a manual MFS gateway.');
      }

      await tx.execute(
        `UPDATE payment_gateways
         SET account_number = ?,
             instructions = ?,
             instructions_bn = ?,
             status = ?,
             is_active = ?,
             min_order_paisa = ?,
             max_order_paisa = ?,
             api_credentials = COALESCE(NULLIF(?, ''), api_credentials)
         WHERE id = ?`,
        [
          update.accountNumber,
          update.instructions,
          instructionsBn,
          update.status,
          update.status,
          minOrderPaisa,
          maxOrderPaisa,
          apiCredentials,
          id,
        ]
      );

      await recordAuditLog(
        {
          actorType: 'admin',
          actorId: actor.id || null,
          action: 'payment_gateway.updated',
          entityType: 'payment_gateway',
          entityId: id,
          beforeState: {
            code: before.code,
            account: accountAudit(before.account_number),
            instructionsLength: String(before.instructions || '').length,
            status: Number(before.status),
          },
          afterState: {
            code: before.code,
            account: accountAudit(update.accountNumber),
            instructionsLength: update.instructions.length,
            status: update.status,
          },
          ipAddress: actor.ip || '',
          userAgent: actor.userAgent || '',
        },
        tx
      );

      return { id, code: before.code, status: update.status };
    }, { pool: activePool });
  }

  const before = sqliteDb.get('SELECT id, name, code, type AS gateway_type, account_number, instructions, status FROM payment_gateways WHERE id=?', id);
  if (!before) throw new NotFoundError('Payment gateway not found.');
  if (before.gateway_type === 'manual' && update.status === 1 && (!update.accountNumber || !update.instructions)) {
    throw new ValidationError('Configure both the receiving account number and customer instructions before activating a manual MFS gateway.');
  }
  sqliteDb.run(
    'UPDATE payment_gateways SET account_number=?, instructions=?, status=? WHERE id=?',
    update.accountNumber,
    update.instructions,
    update.status,
    id
  );
  await recordAuditLog({
    actorType: 'admin',
    actorId: actor.id || null,
    action: 'payment_gateway.updated',
    entityType: 'payment_gateway',
    entityId: id,
    beforeState: { code: before.code, account: accountAudit(before.account_number), instructionsLength: String(before.instructions || '').length, status: Number(before.status) },
    afterState: { code: before.code, account: accountAudit(update.accountNumber), instructionsLength: update.instructions.length, status: update.status },
    ipAddress: actor.ip || '',
    userAgent: actor.userAgent || '',
  });
  return { id, code: before.code, status: update.status };
}

module.exports = {
  listPaymentGateways,
  togglePaymentGateway,
  updatePaymentGateway,
  normalizeUpdate,
};
