'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const { ValidationError } = require('../utils/errors');

function client(pool = null) {
  if (env.db.client !== 'mysql' && !pool) throw new Error('Partner directory repository requires MySQL.');
  return createQueryClient(pool || getPool());
}

function pendingFilter(value) {
  if (typeof value !== 'boolean') throw new ValidationError('Pending filter must be a boolean.');
  return value;
}

/** Existing platform-wide admin directory read; D3 tenant isolation is not claimed. */
async function listVendors({ pendingOnly = false } = {}, { pool = null } = {}) {
  pendingOnly = pendingFilter(pendingOnly);
  const verifiedClause = pendingOnly ? 'WHERE verified=?' : '';
  return client(pool).queryAll(`SELECT id,shop_name,owner_name,phone,
      commission_rate_bps/100 AS commission_rate,balance_paisa/100 AS balance,verified
    FROM vendors ${verifiedClause} ORDER BY id DESC`, pendingOnly ? [0] : []);
}

/** Existing platform-wide admin directory read; D3 tenant isolation is not claimed. */
async function listResellers({ pendingOnly = false } = {}, { pool = null } = {}) {
  pendingOnly = pendingFilter(pendingOnly);
  const verifiedClause = pendingOnly ? 'WHERE verified=?' : '';
  return client(pool).queryAll(`SELECT id,name,shop_name,phone,balance_paisa/100 AS balance,verified
    FROM resellers ${verifiedClause} ORDER BY id DESC`, pendingOnly ? [0] : []);
}

module.exports = { listVendors, listResellers };
