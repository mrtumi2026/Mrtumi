'use strict';

const { env } = require('../config/env');
const { getPool, withTransaction, createQueryClient } = require('../db/mysqlPool');
const { normalizeBdPhone, requirePositiveInt, requireString } = require('../utils/validator');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

function client() {
  if (env.db.client !== 'mysql') throw new Error('Admin complaint repository requires MySQL.');
  return createQueryClient(getPool());
}
function boundedOptional(raw, field, max) {
  const value = String(raw ?? '').trim();
  if (value.length > max) throw new ValidationError(`${field} must not exceed ${max} characters.`);
  return value;
}
async function insertAudit(tx, actor, action, id, beforeState, afterState) {
  const audit = (value) => value == null ? null : JSON.stringify(logger.redactValue(value));
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,?,?,?,?,?,?,?)`, [actor.id, action, 'complaint', String(id), audit(beforeState), audit(afterState), String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]);
}
async function listComplaints() {
  return client().queryAll(`SELECT id,name,phone,invoice_no AS invoice_id,details,status,admin_reply,created_at
    FROM complaints ORDER BY id DESC`);
}
async function listContactMessages() {
  return client().queryAll(`SELECT id,name,phone,email,subject,message,status,created_at
    FROM contact_messages ORDER BY id DESC`);
}
async function createComplaint(input, actor = {}) {
  const name = requireString(input.name, 'customer name', { min: 2, max: 191 });
  const phone = normalizeBdPhone(input.phone, 'customer phone');
  const invoiceNo = boundedOptional(input.invoice_id, 'invoice number', 40);
  const details = requireString(input.details, 'complaint details', { min: 3, max: 10000 });
  return withTransaction(async (tx) => {
    const result = await tx.execute(`INSERT INTO complaints(name,phone,invoice_no,details,status)
      VALUES(?,?,?,?,'pending')`, [name, phone, invoiceNo, details]);
    await insertAudit(tx, actor, 'customer.complaint.created', result.insertId, null, {
      status: 'pending', fields: ['name', 'phone', 'invoice_no', 'details'],
    });
    return { id: Number(result.insertId), status: 'pending' };
  });
}
async function resolveComplaint(id, actor = {}) {
  const complaintId = requirePositiveInt(id, 'complaint ID');
  return withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT id,status FROM complaints WHERE id=? FOR UPDATE', [complaintId]);
    if (!before) throw new NotFoundError('Complaint not found.');
    const oldStatus = String(before.status);
    if (oldStatus === 'resolved') return { id: complaintId, status: 'resolved', changed: false };
    const update = await tx.execute("UPDATE complaints SET status='resolved' WHERE id=? AND status=?", [complaintId, oldStatus]);
    if (update.affectedRows !== 1) throw new ValidationError('Complaint status changed. Reload and try again.');
    await insertAudit(tx, actor, 'customer.complaint.resolved', complaintId, { status: oldStatus }, { status: 'resolved' });
    return { id: complaintId, status: 'resolved', changed: true };
  });
}

module.exports = { listComplaints, listContactMessages, createComplaint, resolveComplaint };
