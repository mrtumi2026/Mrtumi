'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../middleware/rbac');
const { requireCsrf } = require('../middleware/csrf');
const { asyncHandler } = require('../utils/asyncHandler');
const repo = require('../repositories/adminAccessRepository');
const { ValidationError } = require('../utils/errors');

const router = express.Router();
router.use('/admin', requireAdmin);
const actor = (req) => ({ id:req.adminUser?.id, roleId:req.adminUser?.role_id, ip:req.ip, userAgent:req.get('user-agent') || '' });

router.get('/admin/users/manage', requirePermission('staff.manage'), asyncHandler(async (req,res) => {
  const [rows,roles]=await Promise.all([repo.listStaff(),repo.listRoles()]);
  const canAssignRole=hasPermission(req.adminUser,'staff.assign_role');
  const fields=canAssignRole?[{name:'name',label:'Full name',type:'text',required:true},{name:'email',label:'Login email',type:'email',required:true},{name:'phone',label:'Phone',type:'text'},{name:'password',label:'Initial password (12+ chars)',type:'password',required:true},{name:'roleId',label:'Role',type:'select',required:true,options:roles.filter(r=>Number(r.status)&&!['super_admin','superadmin'].includes(r.slug)).map(r=>({value:r.id,label:r.name}))}]:[];
  return res.render('admin/crud-module',{pageTitle:'Admin Staff',subtitle:'Staff accounts; deactivation revokes active web sessions.',createAction:canAssignRole?'/admin/users/create':null,customActionPrefix:'/admin/users/toggle',customActionLabel:'Activate / Deactivate',columns:[{key:'id',label:'#'},{key:'name',label:'Name'},{key:'email',label:'Email'},{key:'phone',label:'Phone'},{key:'role_name',label:'Role'},{key:'status',label:'Status',type:'status'}],fields,rows});
}));
router.post('/admin/users/create', requirePermission('staff.manage','staff.assign_role'), requireCsrf, asyncHandler(async (req,res) => {
  const password=String(req.body.password||'');
  if(password.length<12||Buffer.byteLength(password,'utf8')>72)throw new ValidationError('Password must be at least 12 characters and no more than 72 UTF-8 bytes.');
  await repo.createStaff({...req.body,passwordHash:await bcrypt.hash(password,12)},actor(req));
  return res.redirect('/admin/users/manage');
}));
router.post('/admin/users/toggle/:id', requirePermission('staff.manage'), requireCsrf, asyncHandler(async (req,res) => {
  const users=await repo.listStaff(); const current=users.find(u=>Number(u.id)===Number(req.params.id));
  if(!current)throw new ValidationError('Staff account was not found.');
  await repo.setStaffStatus(req.params.id,Number(current.status)?0:1,actor(req));
  return res.redirect('/admin/users/manage');
}));
router.get('/admin/phase09/access/staff', requirePermission('staff.manage'), asyncHandler(async (_req,res) => res.json({data:await repo.listStaff()})));
router.post('/admin/phase09/access/staff', requirePermission('staff.manage','staff.assign_role'), requireCsrf, asyncHandler(async (req,res) => {
  const raw = String(req.body.password || '');
  if (raw.length < 12 || Buffer.byteLength(raw,'utf8') > 72) throw new ValidationError('Password must be at least 12 characters and no more than 72 UTF-8 bytes.');
  const passwordHash = await bcrypt.hash(raw,12);
  const staff = await repo.createStaff({...req.body,passwordHash},actor(req));
  return res.status(201).json({data:staff});
}));
router.put('/admin/phase09/access/staff/:id', requirePermission('staff.manage','staff.assign_role'), requireCsrf, asyncHandler(async (req,res) => res.json({data:await repo.updateStaff(req.params.id,req.body,actor(req))})));
router.patch('/admin/phase09/access/staff/:id', requirePermission('staff.manage'), requireCsrf, asyncHandler(async (req,res) => {
  const {status} = req.body;
  return res.json({data:await repo.setStaffStatus(req.params.id,status,actor(req))});
}));
router.get('/admin/roles/manage', requirePermission('roles.manage'), asyncHandler(async (_req,res) => {
  const rows=await repo.listRoles();
  return res.render('admin/crud-module',{pageTitle:'Admin Roles',subtitle:'Role permission grants are changed only by explicit role-management actions.',createAction:'/admin/roles/create',customActionPrefix:'/admin/roles/toggle',customActionLabel:'Activate / Deactivate',columns:[{key:'id',label:'#'},{key:'name',label:'Role'},{key:'slug',label:'Slug'},{key:'permissions',label:'Granted permissions'},{key:'status',label:'Status',type:'status'}],fields:[{name:'name',label:'Role name',type:'text',required:true},{name:'slug',label:'Stable role slug',type:'text',required:true}],rows:rows.map(r=>({...r,permissions:r.permissions.join(', ')}))});
}));
router.post('/admin/roles/create', requirePermission('roles.manage'), requireCsrf, asyncHandler(async (req,res) => {await repo.createRole(req.body,actor(req));return res.redirect('/admin/roles/manage');}));
router.post('/admin/roles/toggle/:id', requirePermission('roles.manage'), requireCsrf, asyncHandler(async (req,res) => {const role=(await repo.listRoles()).find(r=>Number(r.id)===Number(req.params.id));if(!role)throw new ValidationError('Role not found.');await repo.setRoleStatus(req.params.id,Number(role.status)?0:1,actor(req));return res.redirect('/admin/roles/manage');}));
router.get('/admin/permissions/manage', requirePermission('roles.manage'), asyncHandler(async (_req,res) => res.render('admin/crud-module',{pageTitle:'Permission Catalog',subtitle:'Permission definitions are migration-managed; no ad-hoc permission creation or deletion is exposed.',columns:[{key:'module',label:'Module'},{key:'name',label:'Permission key'},{key:'description',label:'Purpose'}],fields:[],rows:await repo.listPermissions()})));
router.get('/admin/phase09/access/roles', requirePermission('roles.manage'), asyncHandler(async (_req,res) => res.json({data:await repo.listRoles()})));
router.post('/admin/phase09/access/roles', requirePermission('roles.manage'), requireCsrf, asyncHandler(async (req,res) => res.status(201).json({data:await repo.createRole(req.body,actor(req))})));
router.put('/admin/phase09/access/roles/:id/permissions', requirePermission('roles.manage','roles.grants.manage'), requireCsrf, asyncHandler(async (req,res) => res.json({data:await repo.setRolePermissions(req.params.id,req.body.permissions,actor(req))})));
router.patch('/admin/phase09/access/roles/:id', requirePermission('roles.manage'), requireCsrf, asyncHandler(async (req,res) => res.json({data:await repo.setRoleStatus(req.params.id,req.body.status,actor(req))})));
router.get('/admin/phase09/access/permissions', requirePermission('roles.manage'), asyncHandler(async (_req,res) => res.json({data:await repo.listPermissions()})));
// Legacy destructive URLs are redirected to safe deactivation/catalog behavior, never hard-delete grants.
router.post('/admin/users/delete/:id', requirePermission('staff.manage'), requireCsrf, asyncHandler(async(req,res)=>{await repo.setStaffStatus(req.params.id,0,actor(req));return res.redirect('/admin/users/manage');}));
router.post('/admin/roles/delete/:id', requirePermission('roles.manage'), requireCsrf, asyncHandler(async(req,res)=>{await repo.setRoleStatus(req.params.id,0,actor(req));return res.redirect('/admin/roles/manage');}));
router.post('/admin/permissions/create', requirePermission('roles.manage'), requireCsrf, (_req,res)=>res.status(405).json({error:'METHOD_NOT_ALLOWED',message:'Permission definitions are migration-managed.'}));
router.post('/admin/permissions/delete/:id', requirePermission('roles.manage'), requireCsrf, (_req,res)=>res.status(405).json({error:'METHOD_NOT_ALLOWED',message:'Permission definitions cannot be deleted through the admin interface.'}));
router.get('/admin/audit-logs', requirePermission('audit_logs.view'), asyncHandler(async (req,res) => {
  const result=await repo.listAuditLogs({page:req.query.page,limit:req.query.limit});
  if(req.accepts(['html','json'])==='html')return res.render('admin/audit-logs',{result});
  return res.json({data:result});
}));

module.exports=router;
