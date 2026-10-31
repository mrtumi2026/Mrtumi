'use strict';

const { getPool, withTransaction, createQueryClient } = require('../db/mysqlPool');
const { env } = require('../config/env');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const logger = require('../utils/logger');

function client(poolOverride = null) {
  if (env.db.client !== 'mysql' && !poolOverride) throw new Error('Admin access repository requires MySQL.');
  return createQueryClient(poolOverride || getPool());
}
function boundedText(raw, field, max, min = 1) {
  const value = String(raw ?? '').trim();
  if (value.length < min || value.length > max) throw new ValidationError(`${field} must be ${min}-${max} characters.`);
  return value;
}
function boundedId(raw, field = 'id') {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new ValidationError(`${field} is invalid.`);
  return n;
}
function auditJson(value) {
  return JSON.stringify(logger.redactValue(value || {}));
}
async function audit(tx, actor, action, entity, id, before, after) {
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,?,?,?,?,?,?,?)`, [actor.id, action, entity, String(id), before ? auditJson(before) : null,
    after ? auditJson(after) : null, String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255)]);
}
async function listStaff({ pool = null } = {}) {
  return client(pool).queryAll(`SELECT u.id,u.name,u.email,u.phone,u.role_id,u.status,u.created_at,r.name AS role_name,r.slug AS role_slug
    FROM users u LEFT JOIN roles r ON r.id=u.role_id ORDER BY u.id DESC LIMIT 250`);
}
async function listRoles({ pool = null } = {}) {
  const c = client(pool);
  const roles = await c.queryAll(`SELECT id,name,slug,status,created_at FROM roles ORDER BY id`);
  if (!roles.length) return [];
  const grants = await c.queryAll(`SELECT rp.role_id,p.name AS permission FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
    WHERE rp.role_id IN (${roles.map(() => '?').join(',')}) ORDER BY p.name`, roles.map((r) => r.id));
  const byRole = new Map(roles.map((r) => [Number(r.id), []]));
  for (const g of grants) byRole.get(Number(g.role_id))?.push(g.permission);
  return roles.map((r) => ({ ...r, permissions: byRole.get(Number(r.id)) || [] }));
}
async function listPermissions({ pool = null } = {}) {
  return client(pool).queryAll('SELECT id,name,module,description FROM permissions ORDER BY module,name');
}
async function createStaff(input, actor, { pool = null } = {}) {
  const name = boundedText(input.name, 'Name', 191);
  const email = boundedText(input.email, 'Email', 191).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Email address is invalid.');
  const phone = String(input.phone || '').trim().slice(0,32);
  const passwordHash = String(input.passwordHash || '');
  if (!/^\$2[aby]\$\d\d\$/.test(passwordHash)) throw new ValidationError('A valid password hash is required.');
  const roleId = boundedId(input.roleId, 'Role');
  return withTransaction(async (tx) => {
    const role = await tx.queryOne('SELECT id,name,slug,status FROM roles WHERE id=? FOR UPDATE', [roleId]);
    if (!role || Number(role.status) !== 1 || ['super_admin','superadmin'].includes(role.slug)) throw new ValidationError('Selected role is unavailable.');
    const result = await tx.execute(`INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status)
      VALUES(?,?,?,?,?,?,1)`, [roleId,name,email,phone,passwordHash,role.name]);
    await audit(tx,actor,'admin.staff.created','admin_user',result.insertId,null,{roleId,status:1});
    return { id: result.insertId, name, email, phone, role_id: roleId, status: 1 };
  }, { pool });
}
async function updateStaff(id,input,actor,{pool=null}={}) {
  const userId=boundedId(id);
  const name=boundedText(input.name,'Name',191);
  const email=boundedText(input.email,'Email',191).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ValidationError('Email address is invalid.');
  const phone=String(input.phone||'').trim().slice(0,32);
  const roleId=boundedId(input.roleId,'Role');
  if(Number(actor.id)===userId && Number(actor.roleId)!==roleId)throw new ConflictError('You cannot change your own role.');
  return withTransaction(async tx=>{
    const before=await tx.queryOne('SELECT u.id,u.name,u.email,u.phone,u.role_id,u.status,r.slug AS role_slug FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=? FOR UPDATE',[userId]);
    if(!before)throw new NotFoundError('Staff account not found.');
    if(['super_admin','superadmin'].includes(before.role_slug))throw new ConflictError('Super Admin accounts cannot be edited through staff management.');
    const role=await tx.queryOne('SELECT id,name,slug,status FROM roles WHERE id=? FOR UPDATE',[roleId]);
    if(!role||Number(role.status)!==1||['super_admin','superadmin'].includes(role.slug))throw new ValidationError('Selected role is unavailable.');
    await tx.execute('UPDATE users SET name=?,email=?,phone=?,role_id=?,role_label=? WHERE id=?',[name,email,phone,roleId,role.name,userId]);
    await tx.execute("DELETE FROM web_sessions WHERE actor_type='admin' AND actor_id=?",[userId]);
    await audit(tx,actor,'admin.staff.updated','admin_user',userId,{roleId:Number(before.role_id),status:Number(before.status)},{roleId,changedFields:['name','email','phone','role']});
    return {id:userId,name,email,phone,role_id:roleId,status:Number(before.status)};
  },{pool});
}
async function setStaffStatus(id, status, actor, { pool = null } = {}) {
  const userId = boundedId(id);
  if (![0,1].includes(Number(status))) throw new ValidationError('Status must be 0 or 1.');
  if (Number(actor.id) === userId && Number(status) === 0) throw new ConflictError('You cannot deactivate your own active account.');
  return withTransaction(async (tx) => {
    const user = await tx.queryOne('SELECT u.id,u.name,u.email,u.status,r.slug AS role_slug,r.status AS role_status FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=? FOR UPDATE', [userId]);
    if (!user) throw new NotFoundError('Staff account not found.');
    if (['super_admin','superadmin'].includes(user.role_slug)) throw new ConflictError('Super Admin accounts cannot be changed through staff management.');
    if (Number(status) === 1 && Number(user.role_status) !== 1) throw new ConflictError('Reactivate the assigned role before reactivating this staff account.');
    const previous = Number(user.status);
    await tx.execute('UPDATE users SET status=? WHERE id=?', [Number(status),userId]);
    if (Number(status) === 0) await tx.execute("DELETE FROM web_sessions WHERE actor_type='admin' AND actor_id=?", [userId]);
    await audit(tx,actor,Number(status) ? 'admin.staff.activated' : 'admin.staff.deactivated','admin_user',userId,
      {status:previous},{status:Number(status)});
    return { id:userId,status:Number(status) };
  }, { pool });
}
async function createRole(input, actor, { pool = null } = {}) {
  const name = boundedText(input.name,'Role name',100);
  const slug = boundedText(input.slug,'Role slug',100).toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(slug) || ['super_admin','superadmin'].includes(slug)) throw new ValidationError('Role slug is invalid or reserved.');
  return withTransaction(async (tx) => {
    const result = await tx.execute('INSERT INTO roles(name,slug,status) VALUES(?,?,1)',[name,slug]);
    await audit(tx,actor,'admin.role.created','role',result.insertId,null,{name,slug,status:1,permissions:[]});
    return { id:result.insertId,name,slug,status:1,permissions:[] };
  },{pool});
}
async function setRolePermissions(roleId, permissionKeys, actor, { pool = null } = {}) {
  const id = boundedId(roleId,'Role');
  if (!Array.isArray(permissionKeys) || permissionKeys.length > 100) throw new ValidationError('Permissions must be a bounded list.');
  const keys = [...new Set(permissionKeys.map((key) => boundedText(key,'Permission key',120)))].sort();
  return withTransaction(async (tx) => {
    const role = await tx.queryOne('SELECT id,name,slug,status FROM roles WHERE id=? FOR UPDATE',[id]);
    if (!role) throw new NotFoundError('Role not found.');
    if (['super_admin','superadmin'].includes(role.slug)) throw new ConflictError('Super Admin grants cannot be edited through staff role management.');
    const beforeRows = await tx.queryAll('SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? ORDER BY p.name',[id]);
    if (keys.length) {
      const allowed = await tx.queryAll(`SELECT name,id FROM permissions WHERE name IN (${keys.map(() => '?').join(',')})`,keys);
      if (allowed.length !== keys.length) throw new ValidationError('One or more permission keys do not exist.');
    }
    await tx.execute('DELETE FROM role_permissions WHERE role_id=?',[id]);
    for (const key of keys) {
      const permission = await tx.queryOne('SELECT id FROM permissions WHERE name=?',[key]);
      await tx.execute('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?)',[id,permission.id]);
    }
    await audit(tx,actor,'admin.role.permissions_updated','role',id,{permissions:beforeRows.map((r)=>r.name)},{permissions:keys});
    return { roleId:id,permissions:keys };
  },{pool});
}
async function setRoleStatus(roleId, status, actor, { pool = null } = {}) {
  const id = boundedId(roleId,'Role');
  if (![0,1].includes(Number(status))) throw new ValidationError('Status must be 0 or 1.');
  return withTransaction(async (tx) => {
    const role = await tx.queryOne('SELECT id,name,slug,status FROM roles WHERE id=? FOR UPDATE',[id]);
    if (!role) throw new NotFoundError('Role not found.');
    if (['super_admin','superadmin'].includes(role.slug) || Number(role.id) === Number(actor.roleId)) throw new ConflictError('Protected role cannot be changed.');
    if (!Number(status) && await tx.queryOne('SELECT id FROM users WHERE role_id=? AND status=1 LIMIT 1 FOR UPDATE',[id])) throw new ConflictError('Reassign active staff before deactivating this role.');
    await tx.execute('UPDATE roles SET status=? WHERE id=?',[Number(status),id]);
    await audit(tx,actor,Number(status)?'admin.role.activated':'admin.role.deactivated','role',id,{status:Number(role.status)},{status:Number(status)});
    return {id,status:Number(status)};
  },{pool});
}
async function listAuditLogs({ page = 1, limit = 50, pool = null } = {}) {
  const p = Math.max(1,Math.min(100000,Number(page)||1));
  const n = Math.max(1,Math.min(100,Number(limit)||50));
  const offset = (p-1)*n;
  const c = client(pool);
  const [rows,total] = await Promise.all([
    c.queryAll('SELECT id,actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?',[n,offset]),
    c.queryOne('SELECT COUNT(*) AS count FROM audit_logs')
  ]);
  return { rows, page:p, limit:n, total:Number(total.count||0) };
}

module.exports={listStaff,listRoles,listPermissions,createStaff,updateStaff,setStaffStatus,createRole,setRolePermissions,setRoleStatus,listAuditLogs};
