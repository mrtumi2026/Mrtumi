'use strict';

const { env } = require('../config/env');
const { getPool, withTransaction, createQueryClient } = require('../db/mysqlPool');
const { requirePositiveInt, requireString } = require('../utils/validator');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

function client() {
  if (env.db.client !== 'mysql') throw new Error('Admin order-status repository requires MySQL.');
  return createQueryClient(getPool());
}
function normalizeSlug(input = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const source = String(values.slug || values.name || '').trim().toLowerCase();
  const slug = source.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug || slug.length > 80) throw new ValidationError('Status slug must contain 1–80 ASCII letters, numbers or hyphens.');
  return slug;
}
function normalizeColor(input = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const color = String(values.color || '#3b82f6').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new ValidationError('Status color must be a six-digit hexadecimal color.');
  return color.toLowerCase();
}
function normalizeSortOrder(raw) {
  const value = raw === undefined || raw === null || raw === '' ? 8 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new ValidationError('Sort order must be an integer between 0 and 100000.');
  return value;
}
async function insertAudit(tx, actor, action, id, beforeState, afterState) {
  const audit = (value) => value == null ? null : JSON.stringify(logger.redactValue(value));
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,?,?,?,?,?,?,?)`, [actor.id, action, 'order_status', String(id), audit(beforeState), audit(afterState), String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]);
}
async function listOrderStatuses() {
  return client().queryAll('SELECT id,name,slug,badge_class,color,sort_order,status FROM order_statuses ORDER BY sort_order ASC,id ASC');
}
async function createOrderStatus(input = {}, actor = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const name = requireString(values.name, 'status name', { min: 1, max: 80 });
  const slug = normalizeSlug({ slug: values.slug, name });
  const color = normalizeColor(values);
  const sortOrder = normalizeSortOrder(values.sort_order);
  try {
    return await withTransaction(async (tx) => {
      const result = await tx.execute('INSERT INTO order_statuses(name,slug,color,sort_order,status) VALUES(?,?,?,?,1)', [name, slug, color, sortOrder]);
      await insertAudit(tx, actor, 'order.status_definition.created', result.insertId, null, { name, slug, color, sortOrder, status: 1 });
      return { id: Number(result.insertId), name, slug, color, sortOrder, status: 1 };
    });
  } catch (error) {
    if (error.code === 'DB_DUPLICATE_ENTRY') throw new ConflictError('An order status with this slug already exists.');
    throw error;
  }
}
async function deactivateOrderStatus(id, actor = {}) {
  const statusId = requirePositiveInt(id, 'order status ID');
  return withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT id,name,slug,status FROM order_statuses WHERE id=? FOR UPDATE', [statusId]);
    if (!before) throw new NotFoundError('Order status not found.');
    if (Number(before.status) === 0) return { id: statusId, status: 0, changed: false };
    const update = await tx.execute('UPDATE order_statuses SET status=0 WHERE id=? AND status=1', [statusId]);
    if (update.affectedRows !== 1) throw new ConflictError('Order status changed. Reload and try again.');
    await insertAudit(tx, actor, 'order.status_definition.deactivated', statusId, { slug: before.slug, status: 1 }, { slug: before.slug, status: 0 });
    return { id: statusId, status: 0, changed: true };
  });
}
module.exports = { listOrderStatuses, createOrderStatus, deactivateOrderStatus, normalizeSlug, normalizeColor, normalizeSortOrder };
