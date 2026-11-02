'use strict';

const { getPool, withTransaction } = require('../db/mysqlPool');
const { bdtToPaisa } = require('../utils/money');
const { ConflictError, NotFoundError } = require('../utils/errors');
const { requirePositiveInt } = require('../utils/validator');
const vendorPii = require('../utils/vendorPii');

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
  const id=requirePositiveInt(vendorId,'Vendor ID');
  const amountOnly=normalizeRequest({amount:input.amount,method:'verified account',accountNumber:'verified'}).amountPaisa;
  if(!input.payoutAccountId)throw new TypeError('A verified payout account is required.');
  const payoutAccountId=requirePositiveInt(input.payoutAccountId,'Verified payout account');
  const activePool = pool || getPool();
  return withTransaction(async (tx) => {
    const vendor = await tx.queryOne('SELECT id,balance_paisa,status,lifecycle_status,payout_verified_at FROM vendors WHERE id=? FOR UPDATE', [id]);
    if (!vendor) throw new NotFoundError('Vendor account was not found.');
    if(Number(vendor.status)!==1||vendor.lifecycle_status!=='active'||!vendor.payout_verified_at)throw new ConflictError('Withdrawals require an active vendor and a verified payout account.');
    const payout=await tx.queryOne("SELECT id,method,details_ciphertext,masked_account FROM vendor_payout_accounts WHERE id=? AND vendor_id=? AND verification_status='verified' FOR UPDATE",[payoutAccountId,id]);
    if(!payout)throw new ConflictError('Choose a payout account verified by the marketplace administrator.');
    const details=JSON.parse(vendorPii.decryptVendorPii(payout.details_ciphertext));
    if(!details.account_number)throw new ConflictError('Verified payout account details are unavailable.');
    await tx.execute('INSERT IGNORE INTO vendor_wallets(vendor_id) VALUES(?)', [id]);
    const wallet=await tx.queryOne('SELECT available_balance FROM vendor_wallets WHERE vendor_id=? FOR UPDATE',[id]);
    if (!wallet || Number(wallet.available_balance) < amountOnly) throw new ConflictError('Insufficient available wallet balance.');
    const before = Number(wallet.available_balance);
    await tx.execute('UPDATE vendor_wallets SET available_balance=available_balance-? WHERE vendor_id=?', [amountOnly, id]);
    await tx.execute('UPDATE vendors SET balance_paisa=balance_paisa-? WHERE id=?', [amountOnly, id]);
    const result = await tx.execute("INSERT INTO vendor_withdrawals(vendor_id,payout_account_id,amount_paisa,method,account_number,note,status) VALUES(?,?,?,?,?,'','pending')", [id,payout.id,amountOnly,payout.method,payout.masked_account]);
    await tx.execute(`INSERT INTO vendor_transactions(vendor_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
      VALUES(?,NULL,?,'withdrawal',?,'available',?)`,[id,`withdrawal:vendor:${result.insertId}`,-amountOnly,JSON.stringify({payoutAccountId:payout.id})]);
    await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES('vendor',?,'vendor.withdrawal.requested','vendor_withdrawal',?,?,?, ?,?)`,
      [id, String(result.insertId), JSON.stringify({ balance_paisa: before }), JSON.stringify({ balance_paisa: before - amountOnly, amount_paisa: amountOnly, payout_account_id:payout.id, masked_account:payout.masked_account, status: 'pending' }), String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255)]);
    return { id: Number(result.insertId), amount: (amountOnly / 100), balancePaisa: before - amountOnly };
  }, { pool: activePool });
}

async function requestResellerWithdrawal(resellerId, input, actor = {}, { pool = null } = {}) {
  const { amountPaisa, method, accountNumber } = normalizeRequest(input);
  const activePool = pool || getPool();
  return withTransaction(async (tx) => {
    const reseller = await tx.queryOne('SELECT id,balance_paisa FROM resellers WHERE id=? FOR UPDATE', [resellerId]);
    if (!reseller) throw new NotFoundError('Reseller account was not found.');
    await tx.execute('INSERT IGNORE INTO partner_wallets(reseller_id) VALUES(?)', [resellerId]);
    const wallet=await tx.queryOne('SELECT available_balance FROM partner_wallets WHERE reseller_id=? FOR UPDATE',[resellerId]);
    if (!wallet || Number(wallet.available_balance) < amountPaisa) throw new ConflictError('Insufficient available commission balance.');
    const before = Number(wallet.available_balance);
    await tx.execute('UPDATE partner_wallets SET available_balance=available_balance-? WHERE reseller_id=?', [amountPaisa, resellerId]);
    await tx.execute('UPDATE resellers SET balance_paisa=balance_paisa-? WHERE id=?', [amountPaisa, resellerId]);
    const result = await tx.execute("INSERT INTO reseller_transactions(reseller_id,tx_type,amount_paisa,method,trx_id,status) VALUES(?,'withdrawal',?,?,?,'pending')", [resellerId, amountPaisa, method, accountNumber]);
    await tx.execute(`INSERT INTO partner_transactions(reseller_id,sub_order_id,idempotency_key,transaction_type,amount_paisa,balance_bucket,metadata_json)
      VALUES(?,NULL,?,'withdrawal',?,'available',?)`,[resellerId,`withdrawal:reseller:${result.insertId}`,-amountPaisa,JSON.stringify({method})]);
    await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES('reseller',?,'reseller.withdrawal.requested','reseller_transaction',?,?,?, ?,?)`,
      [resellerId, String(result.insertId), JSON.stringify({ balance_paisa: before }), JSON.stringify({ balance_paisa: before - amountPaisa, amount_paisa: amountPaisa, status: 'pending' }), String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255)]);
    return { id: Number(result.insertId), amount: (amountPaisa / 100), balancePaisa: before - amountPaisa };
  }, { pool: activePool });
}


async function listVendorWithdrawals(vendorId,{pool=null}={}) {
  const { createQueryClient }=require('../db/mysqlPool');
  const db=createQueryClient(pool||getPool());
  const rows=await db.queryAll('SELECT id,amount_paisa/100 AS amount,method,account_number AS masked_account,note,status,created_at FROM vendor_withdrawals WHERE vendor_id=? ORDER BY id DESC',[vendorId]);
  return rows;
}

module.exports = { requestVendorWithdrawal, requestResellerWithdrawal, listVendorWithdrawals };
