'use strict';

const { env } = require('../config/env');
const { getPool, withTransaction, createQueryClient } = require('../db/mysqlPool');
const { normalizeBdPhone, requireEmail, requirePaisaFromBdt, requireString, requirePositiveInt } = require('../utils/validator');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const logger = require('../utils/logger');

function client() {
  if (env.db.client !== 'mysql') throw new Error('HR employee repository requires MySQL.');
  return createQueryClient(getPool());
}
function dateOnly(raw) {
  const value = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError('Join date must be a valid YYYY-MM-DD date.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Join date must be a valid YYYY-MM-DD date.');
  }
  return value;
}
async function insertAudit(tx, actor, action, id, beforeState, afterState) {
  const audit = (value) => value == null ? null : JSON.stringify(logger.redactValue(value));
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,?,?,?,?,?,?,?)`, [actor.id, action, 'employee', String(id), audit(beforeState), audit(afterState), String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]);
}
async function listEmployees() {
  return client().queryAll(`SELECT id,name,designation,phone,email,base_salary_paisa / 100 AS base_salary,join_date,status
    FROM employees ORDER BY id DESC`);
}
async function createEmployee(input, actor = {}) {
  const name = requireString(input.name, 'employee name', { min: 2, max: 191 });
  const designation = requireString(input.designation, 'designation', { min: 2, max: 120 });
  const phone = normalizeBdPhone(input.phone, 'employee phone');
  const email = String(input.email ?? '').trim() ? requireEmail(input.email, 'employee email') : '';
  const baseSalaryPaisa = requirePaisaFromBdt(input.base_salary, 'base salary');
  const joinDate = dateOnly(input.join_date);
  try {
    return await withTransaction(async (tx) => {
      const result = await tx.execute(`INSERT INTO employees(name,designation,phone,email,base_salary_paisa,join_date,status)
        VALUES(?,?,?,?,?,?,1)`, [name, designation, phone, email, baseSalaryPaisa, joinDate]);
      await insertAudit(tx, actor, 'hr.employee.created', result.insertId, null, {
        status: 1,
        fields: ['name', 'designation', 'phone', 'email', 'base_salary_paisa', 'join_date'],
      });
      return { id: Number(result.insertId), status: 1 };
    });
  } catch (error) {
    if (error.code === 'DB_DUPLICATE_ENTRY') throw new ConflictError('An employee with this phone number already exists.');
    throw error;
  }
}
async function deactivateEmployee(id, actor = {}) {
  const employeeId = requirePositiveInt(id, 'employee ID');
  return withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT id,status FROM employees WHERE id=? FOR UPDATE', [employeeId]);
    if (!before) throw new NotFoundError('Employee not found.');
    if (Number(before.status) === 0) return { id: employeeId, status: 0, changed: false };
    const result = await tx.execute('UPDATE employees SET status=0 WHERE id=? AND status=1', [employeeId]);
    if (result.affectedRows !== 1) throw new ConflictError('Employee status changed. Please reload and try again.');
    await insertAudit(tx, actor, 'hr.employee.deactivated', employeeId, { status: 1 }, { status: 0 });
    return { id: employeeId, status: 0, changed: true };
  });
}

module.exports = { listEmployees, createEmployee, deactivateEmployee, dateOnly };
