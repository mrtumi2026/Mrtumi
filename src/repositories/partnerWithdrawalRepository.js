'use strict';

const { getPool, withTransaction } = require('../db/mysqlPool');
const { bdtToPaisa } = require('../utils/money');
const { ConflictError, NotFoundError } = require('../utils/errors');

function normalizeRequest({ amount, method, accountNumber }) {
  let amountPaisa;
  try { amountPaisa = bdtToPaisa(amount); } catch (error) { throw new TypeError('Enter a valid withdrawal amount with no more than two decimal places.'); }
  if (amountPaisa < 10000) throw new RangeError('The minimum withdrawal is ৳100.');
  const cleanMethod = String(method || 'bKash').trim().slice(0, 64);
  const cleanAccount = String(accountNumber || '').trim();
  if (!cleanMethod || !cleanAccount || cleanAccount.length > 100) throw new TypeError('A valid payout method and account number are required.');
  return { amountPaisa, method: cleanMethod, accountNumber: cleanAccount };
}

async function requestVendorWithdrawal(vendorId, input, actor = {}, { pool = null } = {}) {
  const { amountPaisa, method, accountNumber } = normalizeRequest(input);
  const activePool = pool || getPool();
  return withTransaction(async (tx) => {
    const vendor = await tx.queryOne('SELECT id,balance_paisa FROM vendors WHERE id=? FOR UPDATE', [vendorId]);
    if (!vendor) throw new NotFoundError('Vendor account was not found.');
    if (Number(vendor.balance_paisa) < amountPaisa) throw new ConflictError('Insufficient wallet balance.');
    const before = Number(vendor.balance_paisa);
    await tx.execute('UPDATE vendors SET balance_paisa=balance_paisa-? WHERE id=?', [amountPaisa, vendorId]);
    const result = await tx.execute("INSERT INTO vendor_withdrawals(vendor_id,amount_paisa,method,account_number,note,status) VALUES(?,?,?,?,'','pending')", [vendorId, amountPaisa, method, accountNumber]);
    await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES('vendor',?,'vendor.withdrawal.requested','vendor_withdrawal',?,?,?, ?,?)`,
      [vendorId, String(result.insertId), JSON.stringify({ balance_paisa: before }), JSON.stringify({ balance_paisa: before - amountPaisa, amount_paisa: amountPaisa, status: 'pending' }), String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255)]);
    return { id: Number(result.insertId), amount: (amountPaisa / 100), balancePaisa: before - amountPaisa };
  }, { pool: activePool });
}

async function requestResellerWithdrawal(resellerId, input, actor = {}, { pool = null } = {}) {
  const { amountPaisa, method, accountNumber } = normalizeRequest(input);
  const activePool = pool || getPool();
  return withTransaction(async (tx) => {
    const reseller = await tx.queryOne('SELECT id,balance_paisa FROM resellers WHERE id=? FOR UPDATE', [resellerId]);
    if (!reseller) throw new NotFoundError('Reseller account was not found.');
    if (Number(reseller.balance_paisa) < amountPaisa) throw new ConflictError('Insufficient commission balance.');
    const before = Number(reseller.balance_paisa);
    await tx.execute('UPDATE resellers SET balance_paisa=balance_paisa-? WHERE id=?', [amountPaisa, resellerId]);
    const result = await tx.execute("INSERT INTO reseller_transactions(reseller_id,tx_type,amount_paisa,method,trx_id,status) VALUES(?,'withdrawal',?,?,?,'pending')", [resellerId, amountPaisa, method, accountNumber]);
    await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES('reseller',?,'reseller.withdrawal.requested','reseller_transaction',?,?,?, ?,?)`,
      [resellerId, String(result.insertId), JSON.stringify({ balance_paisa: before }), JSON.stringify({ balance_paisa: before - amountPaisa, amount_paisa: amountPaisa, status: 'pending' }), String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255)]);
    return { id: Number(result.insertId), amount: (amountPaisa / 100), balancePaisa: before - amountPaisa };
  }, { pool: activePool });
}

module.exports = { requestVendorWithdrawal, requestResellerWithdrawal };
